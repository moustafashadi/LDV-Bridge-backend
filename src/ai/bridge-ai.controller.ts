import {
  Controller,
  Post,
  Get,
  Param,
  Query,
  HttpCode,
  HttpStatus,
  UseGuards,
  Request,
  BadRequestException,
} from '@nestjs/common';
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiBearerAuth,
  ApiParam,
  ApiQuery,
} from '@nestjs/swagger';
import {
  BridgeAIService,
  BridgeAIAnalysis,
  AIProviderName,
} from './bridge-ai.service';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { UserRole } from '@prisma/client';

@ApiTags('BridgeAI')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Controller('ai')
export class BridgeAIController {
  constructor(private readonly bridgeAIService: BridgeAIService) {}

  @Get('status')
  @ApiOperation({
    summary: 'Check BridgeAI availability and configured providers',
  })
  @ApiResponse({
    status: 200,
    description: 'BridgeAI availability status with provider details',
  })
  async getStatus() {
    const providers = this.bridgeAIService.getProvidersStatus();
    const activeProvider = this.bridgeAIService.getActiveProvider();

    return {
      enabled: this.bridgeAIService.isAvailable(),
      providers,
      activeProvider: activeProvider
        ? {
            name: activeProvider.getName(),
            model: activeProvider.getModel(),
          }
        : null,
      features: ['security-analysis', 'code-review', 'risk-assessment'],
      fallbackEnabled: providers.filter((p) => p.available).length > 1,
    };
  }

  @Post('analyze/:changeId')
  @HttpCode(HttpStatus.OK)
  @Roles(UserRole.PRO_DEVELOPER, UserRole.ADMIN)
  @ApiOperation({
    summary: 'Analyze a change with BridgeAI (auto-selects best provider)',
  })
  @ApiParam({ name: 'changeId', description: 'ID of the change to analyze' })
  @ApiQuery({
    name: 'provider',
    required: false,
    enum: ['anthropic', 'openai', 'gemini', 'groq'],
    description:
      'Preferred AI provider (optional, will fallback if unavailable)',
  })
  @ApiResponse({
    status: 200,
    description: 'AI analysis result',
  })
  @ApiResponse({ status: 400, description: 'BridgeAI not available' })
  @ApiResponse({ status: 404, description: 'Change not found' })
  async analyzeChange(
    @Param('changeId') changeId: string,
    @Query('provider') preferredProvider: AIProviderName | undefined,
    @Request() req: any,
  ): Promise<BridgeAIAnalysis> {
    if (!this.bridgeAIService.isAvailable()) {
      throw new BadRequestException(
        'BridgeAI is not configured. Please set at least one of: ANTHROPIC_API_KEY, OPENAI_API_KEY, or GOOGLE_GEMINI_API_KEY.',
      );
    }

    try {
      return await this.bridgeAIService.analyzeChange(
        changeId,
        req.user.organizationId,
        preferredProvider,
      );
    } catch (error: any) {
      // Provide user-friendly error messages
      if (error.message?.includes('CREDITS_EXHAUSTED')) {
        throw new BadRequestException(
          'All configured AI providers have exhausted their credits. Please add credits or configure additional providers.',
        );
      }
      if (error.message?.includes('RATE_LIMITED')) {
        throw new BadRequestException(
          'AI rate limit exceeded. Please try again in a few moments.',
        );
      }
      throw new BadRequestException(error.message);
    }
  }

  @Get('analysis/:changeId')
  @ApiOperation({ summary: 'Get stored BridgeAI analysis for a change' })
  @ApiParam({ name: 'changeId', description: 'ID of the change' })
  @ApiResponse({
    status: 200,
    description: 'Stored AI analysis (null if not analyzed)',
  })
  async getAnalysis(
    @Param('changeId') changeId: string,
  ): Promise<BridgeAIAnalysis | null> {
    return this.bridgeAIService.getStoredAnalysis(changeId);
  }
}

import {
  Controller,
  Post,
  Get,
  Param,
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
} from '@nestjs/swagger';
import { BridgeAIService, BridgeAIAnalysis } from './bridge-ai.service';
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
  @ApiOperation({ summary: 'Check if BridgeAI is available' })
  @ApiResponse({
    status: 200,
    description: 'BridgeAI availability status',
  })
  async getStatus() {
    return {
      available: this.bridgeAIService.isAvailable(),
      provider: 'anthropic',
      model: 'claude-sonnet-4-20250514',
    };
  }

  @Post('analyze/:changeId')
  @HttpCode(HttpStatus.OK)
  @Roles(UserRole.PRO_DEVELOPER, UserRole.ADMIN)
  @ApiOperation({ summary: 'Analyze a change with BridgeAI' })
  @ApiParam({ name: 'changeId', description: 'ID of the change to analyze' })
  @ApiResponse({
    status: 200,
    description: 'AI analysis result',
  })
  @ApiResponse({ status: 400, description: 'BridgeAI not available' })
  @ApiResponse({ status: 404, description: 'Change not found' })
  async analyzeChange(
    @Param('changeId') changeId: string,
    @Request() req: any,
  ): Promise<BridgeAIAnalysis> {
    if (!this.bridgeAIService.isAvailable()) {
      throw new BadRequestException(
        'BridgeAI is not configured. Please set ANTHROPIC_API_KEY in environment.',
      );
    }

    return this.bridgeAIService.analyzeChange(
      changeId,
      req.user.organizationId,
    );
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

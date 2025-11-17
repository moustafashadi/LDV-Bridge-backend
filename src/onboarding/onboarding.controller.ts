import {
  Controller,
  Post,
  Get,
  Body,
  UseGuards,
  Query,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiBearerAuth } from '@nestjs/swagger';
import { OnboardingService } from './onboarding.service';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { Public } from '../auth/decorators/public.decorator';
import {
  CompleteOnboardingDto,
  SearchOrganizationDto,
} from './dto';

/**
 * Onboarding Controller
 * Handles user onboarding flows: create org, join org, use invitation code
 */
@ApiTags('onboarding')
@Controller('onboarding')
export class OnboardingController {
  constructor(private readonly onboardingService: OnboardingService) {}

  /**
   * Search for organizations (used during signup)
   * Public endpoint - allows unauthenticated users to search
   */
  @Public()
  @Get('organizations/search')
  @ApiOperation({ summary: 'Search for organizations during signup' })
  @ApiResponse({ status: 200, description: 'List of matching organizations' })
  async searchOrganizations(@Query() dto: SearchOrganizationDto) {
    return this.onboardingService.searchOrganizations(dto);
  }

  /**
   * Complete onboarding process
   * Called after Auth0 signup to create org or join existing org
   */
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @Post('complete')
  @ApiOperation({ summary: 'Complete onboarding process' })
  @ApiResponse({ status: 201, description: 'Onboarding completed successfully' })
  @ApiResponse({ status: 400, description: 'Invalid onboarding data' })
  @ApiResponse({ status: 409, description: 'User already onboarded' })
  async completeOnboarding(
    @CurrentUser() user: any,
    @Body() dto: CompleteOnboardingDto,
  ) {
    console.log('User object in completeOnboarding:', JSON.stringify(user, null, 2));
    return this.onboardingService.completeOnboarding(
      user.auth0Id || user.sub, // Auth0 user ID (use auth0Id or sub)
      dto.email, // Use email from request body
      dto.name || user.name, // Use name from body or JWT
      dto,
    );
  }

  /**
   * Get onboarding status for current user
   */
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @Get('status')
  @ApiOperation({ summary: 'Get onboarding status' })
  @ApiResponse({ status: 200, description: 'Onboarding status retrieved' })
  async getOnboardingStatus(@CurrentUser() user: any) {
    return this.onboardingService.getOnboardingStatus(user.sub);
  }
}

import {
  Controller,
  Get,
  Post,
  UseGuards,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiBearerAuth,
} from '@nestjs/swagger';
import { AuthService } from './auth.service';
import { JwtAuthGuard } from './guards/jwt-auth.guard';
import { OnboardedGuard } from './guards/onboarded.guard';
import { CurrentUser } from './decorators/current-user.decorator';
import { Public } from './decorators/public.decorator';
import type { AuthenticatedUser } from './interfaces/authenticated-user.interface';
import { AuthResponseDto } from './dto/auth-response.dto';

/**
 * Authentication Controller
 * Handles authentication endpoints
 */
@ApiTags('Authentication')
@Controller('auth')
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  /**
   * Get current user profile
   * Requires authentication and completed onboarding
   */
  @Get('profile')
  @UseGuards(JwtAuthGuard, OnboardedGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Get current user profile' })
  @ApiResponse({
    status: 200,
    description: 'Returns authenticated user profile',
    type: AuthResponseDto,
  })
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  async getProfile(@CurrentUser() user: AuthenticatedUser): Promise<AuthResponseDto> {
    // OnboardedGuard ensures id is not null
    const profile = await this.authService.getProfile(user.id!);

    return {
      id: profile.id,
      email: profile.email,
      role: profile.role,
      organizationId: profile.organizationId,
      name: user.name,
      picture: user.picture,
    };
  }

  /**
   * Verify token validity
   * Returns user info if token is valid
   */
  @Get('verify')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Verify JWT token' })
  @ApiResponse({ status: 200, description: 'Token is valid' })
  @ApiResponse({ status: 401, description: 'Token is invalid or expired' })
  async verifyToken(@CurrentUser() user: AuthenticatedUser) {
    return {
      valid: true,
      user: {
        id: user.id,
        email: user.email,
        role: user.role,
        organizationId: user.organizationId,
      },
    };
  }

  /**
   * Health check endpoint (public)
   */
  @Public()
  @Get('health')
  @ApiOperation({ summary: 'Health check' })
  @ApiResponse({ status: 200, description: 'Service is healthy' })
  healthCheck() {
    return {
      status: 'ok',
      timestamp: new Date().toISOString(),
      service: 'auth',
    };
  }

  /**
   * Logout endpoint
   * Note: With JWT, logout is handled client-side by removing the token
   * This endpoint can be used for audit logging
   */
  @Post('logout')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Logout (audit logging only)' })
  @ApiResponse({ status: 204, description: 'Logged out successfully' })
  async logout(@CurrentUser() user: AuthenticatedUser) {
    // Log the logout event (optional)
    // In JWT architecture, actual logout is client-side token removal
    return;
  }
}


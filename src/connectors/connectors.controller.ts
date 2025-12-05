import {
  Controller,
  Post,
  Get,
  Delete,
  Body,
  Query,
  UseGuards,
  Logger,
  BadRequestException,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiBearerAuth } from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import type { AuthenticatedUser } from '../auth/interfaces/authenticated-user.interface';
import { TokenManagerService } from './services/token-manager.service';
import { OAuthService } from './services/oauth.service';
import {
  InitiateConnectionDto,
  CompleteConnectionDto,
  TestConnectionDto,
  DisconnectDto,
} from './dto/connection.dto';
import { ConnectionStatus } from './interfaces/base-connector.interface';

@ApiTags('Platform Connectors')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('connectors')
export class ConnectorsController {
  private readonly logger = new Logger(ConnectorsController.name);

  constructor(
    private tokenManager: TokenManagerService,
    private oauthService: OAuthService,
  ) { }

  @Post('initiate')
  @ApiOperation({
    summary: 'Initiate OAuth2 connection to a platform',
    description: 'Generate authorization URL for connecting to PowerApps or Mendix',
  })
  @ApiResponse({
    status: 200,
    description: 'Authorization URL generated successfully',
    schema: {
      properties: {
        authUrl: { type: 'string' },
        state: { type: 'string' },
        platform: { type: 'string' },
      },
    },
  })
  async initiateConnection(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: InitiateConnectionDto,
  ) {
    if (!user.id || !user.organizationId) {
      throw new BadRequestException('User must complete onboarding first');
    }

    this.logger.log(
      `User ${user.id} initiating ${dto.platform} connection`,
    );

    // Generate state for OAuth flow
    const state = this.oauthService.generateState(
      user.id,
      user.organizationId,
    );

    // TODO: This will be implemented in Task 7 & 8 for specific platforms
    // For now, return a placeholder response
    return {
      authUrl: `https://oauth.${dto.platform.toLowerCase()}.com/authorize?state=${state}`,
      state,
      platform: dto.platform,
      message: 'Platform-specific OAuth implementation pending (Task 7 & 8)',
    };
  }

  @Get('callback')
  @ApiOperation({
    summary: 'OAuth callback handler',
    description: 'Handle OAuth callback and exchange code for tokens',
  })
  @ApiResponse({
    status: 200,
    description: 'Connection completed successfully',
  })
  async completeConnection(@Query() query: CompleteConnectionDto) {
    const { code, state } = query;

    this.logger.log(`Processing OAuth callback with state: ${state}`);

    // Parse and validate state
    const { userId, organizationId } = this.oauthService.parseState(state);

    // TODO: Exchange code for tokens (platform-specific in Task 7 & 8)
    return {
      success: true,
      message: 'Token exchange will be implemented in platform-specific connectors',
      userId,
      organizationId,
    };
  }

  @Post('test')
  @ApiOperation({
    summary: 'Test platform connection',
    description: 'Verify that connection to platform is working',
  })
  @ApiResponse({
    status: 200,
    description: 'Connection test result',
    schema: {
      properties: {
        connected: { type: 'boolean' },
        platform: { type: 'string' },
        message: { type: 'string' },
      },
    },
  })
  async testConnection(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: TestConnectionDto,
  ) {
    if (!user.id) {
      throw new BadRequestException('User must complete onboarding first');
    }

    this.logger.log(
      `Testing ${dto.platform} connection for user ${user.id}`,
    );

    // Check if token exists and is valid
    const token = await this.tokenManager.getToken(user.id, dto.platform);
    const isExpired = await this.tokenManager.isTokenExpired(
      user.id,
      dto.platform,
    );

    if (!token) {
      return {
        connected: false,
        platform: dto.platform,
        message: 'No connection found. Please connect first.',
      };
    }

    if (isExpired) {
      return {
        connected: false,
        platform: dto.platform,
        message: 'Token expired. Please reconnect.',
      };
    }

    // TODO: Make actual API call to platform in Task 7 & 8
    return {
      connected: true,
      platform: dto.platform,
      message: 'Connection is active',
    };
  }

  @Delete('disconnect')
  @ApiOperation({
    summary: 'Disconnect from platform',
    description: 'Revoke tokens and remove connection',
  })
  @ApiResponse({
    status: 200,
    description: 'Successfully disconnected',
  })
  async disconnect(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: DisconnectDto,
  ) {
    if (!user.id) {
      throw new BadRequestException('User must complete onboarding first');
    }

    this.logger.log(
      `User ${user.id} disconnecting from ${dto.platform}`,
    );

    try {
      // Delete tokens from database
      await this.tokenManager.deleteToken(user.id, dto.platform);

      // TODO: Revoke tokens at platform level in Task 7 & 8

      return {
        success: true,
        platform: dto.platform,
        message: 'Successfully disconnected',
      };
    } catch (error) {
      this.logger.error(
        `Failed to disconnect: ${error.message}`,
        error.stack,
      );
      throw error;
    }
  }

  @Get('connections')
  @ApiOperation({
    summary: 'List user connections',
    description: 'Get all platform connections for the current user',
  })
  @ApiResponse({
    status: 200,
    description: 'List of user connections',
  })
  async getUserConnections(@CurrentUser() user: AuthenticatedUser) {
    if (!user.id) {
      throw new BadRequestException('User must complete onboarding first');
    }

    this.logger.log(`Fetching connections for user ${user.id}`);

    const connections = await this.tokenManager.getUserConnections(
      user.id,
    );

    // Don't expose sensitive token data
    return connections.map((conn) => ({
      id: conn.id,
      platform: conn.platform,
      isActive: conn.isActive,
      expiresAt: conn.expiresAt,
      createdAt: conn.createdAt,
      updatedAt: conn.updatedAt,
    }));
  }

  @Get('status')
  @ApiOperation({
    summary: 'Get connection status',
    description: 'Check status of connection to a specific platform',
  })
  @ApiResponse({
    status: 200,
    description: 'Connection status',
  })
  async getConnectionStatus(
    @CurrentUser() user: AuthenticatedUser,
    @Query('platform') platform: string,
  ) {
    if (!user.id) {
      throw new BadRequestException('User must complete onboarding first');
    }

    this.logger.log(
      `Checking ${platform} connection status for user ${user.id}`,
    );

    const token = await this.tokenManager.getToken(user.id, platform);
    const isExpired = await this.tokenManager.isTokenExpired(
      user.id,
      platform,
    );

    if (!token) {
      return {
        status: ConnectionStatus.DISCONNECTED,
        platform,
        message: 'Not connected',
      };
    }

    if (isExpired) {
      return {
        status: ConnectionStatus.EXPIRED,
        platform,
        message: 'Token expired',
      };
    }

    return {
      status: ConnectionStatus.CONNECTED,
      platform,
      expiresAt: token.expiresAt,
      message: 'Connected',
    };
  }
}

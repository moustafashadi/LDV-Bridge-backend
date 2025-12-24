import {
  Controller,
  Get,
  Post,
  Delete,
  Body,
  Param,
  Query,
  Res,
  HttpStatus,
  Logger,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiBearerAuth,
  ApiBody,
  ApiProperty,
} from '@nestjs/swagger';
import { IsString, IsNotEmpty } from 'class-validator';
import type { Response } from 'express';
import { MendixService } from './mendix.service';
import { CurrentUser } from '../../auth/decorators/current-user.decorator';
import type { AuthenticatedUser } from '../../auth/interfaces/authenticated-user.interface';
import { Public } from 'src/auth/decorators/public.decorator';

/**
 * Mendix API Credentials DTO
 */
class MendixCredentialsDto {
  @ApiProperty({
    description:
      'Mendix API Key - used for general API access (listing projects, environments). Connection is validated using this.',
    example: '150fd9d2-66e6-49fc-95e7-627af619979d',
  })
  @IsString()
  @IsNotEmpty()
  apiKey: string;

  @ApiProperty({
    description:
      'Mendix Personal Access Token (PAT) - required for creating apps. Stored for future use, not validated during connection.',
    example: '7LJE...vk',
  })
  @IsString()
  @IsNotEmpty()
  pat: string;

  @ApiProperty({
    description: 'Mendix username/email - used with API Key for authentication',
    example: 'user@example.com',
  })
  @IsString()
  @IsNotEmpty()
  username: string;
}

@ApiTags('Mendix Connector')
@Controller('connectors/mendix')
export class MendixController {
  private readonly logger = new Logger(MendixController.name);

  constructor(private readonly mendixService: MendixService) {}

  @Public() // Allow unauthenticated access to setup instructions
  @Get('setup-instructions')
  @ApiOperation({
    summary: 'Get instructions for obtaining Mendix API credentials',
  })
  @ApiResponse({ status: 200, description: 'Returns setup instructions' })
  async getSetupInstructions() {
    return {
      steps: [
        'Log in to your Mendix account at https://sprintr.home.mendix.com/',
        'Go to your profile settings',
        'Navigate to "API Keys" section',
        'Create an API Key: Click "Create New API Key", give it a name (e.g., "LDV-Bridge General Access"), copy the generated key',
        'Navigate to "Personal Access Tokens" section',
        'Create a PAT: Click "Create New Token", give it a name (e.g., "LDV-Bridge App Creation"), copy the generated token',
        "You'll need THREE pieces of information: your Mendix username/email, the API Key, and the PAT",
        'Note: API Keys are used for listing projects/environments, PAT is used for creating and managing apps',
      ],
      tokenUrl: 'https://sprintr.home.mendix.com/',
      scopes: [], // Mendix doesn't use OAuth scopes
    };
  }

  @Post('connect')
  @ApiOperation({
    summary: 'Connect Mendix account with API key and PAT',
    description:
      'Validates connection using username + API key. PAT is stored for future app creation operations.',
  })
  @ApiResponse({
    status: 200,
    description: 'Connection successful (validated with username + API key)',
  })
  @ApiBody({ type: MendixCredentialsDto })
  @ApiBearerAuth()
  async connectAccount(
    @CurrentUser() user: AuthenticatedUser,
    @Body() credentials: MendixCredentialsDto,
  ) {
    this.logger.log(
      `User ${user.id} connecting Mendix account for organization ${user.organizationId}`,
    );

    if (!user.id || !user.organizationId) {
      throw new UnauthorizedException(
        'User must complete onboarding before connecting platforms',
      );
    }

    if (!credentials.apiKey || !credentials.pat || !credentials.username) {
      throw new UnauthorizedException(
        'Mendix API key, PAT, and username are required',
      );
    }

    try {
      // Connection is validated using username + API key
      // PAT is stored for future app creation operations (validated when first used)
      await this.mendixService.saveCredentials(
        user.id,
        user.organizationId,
        credentials.apiKey,
        credentials.pat,
        credentials.username,
      );

      return {
        success: true,
        message: 'Mendix account connected successfully',
        platform: 'MENDIX',
      };
    } catch (error) {
      this.logger.error('Failed to connect Mendix account:', error);
      throw error;
    }
  }

  @Post('disconnect')
  @ApiOperation({ summary: 'Disconnect Mendix account' })
  @ApiResponse({ status: 200, description: 'Successfully disconnected' })
  @ApiBearerAuth()
  async disconnect(@CurrentUser() user: AuthenticatedUser) {
    this.logger.log(
      `User ${user.id} disconnecting Mendix for organization ${user.organizationId}`,
    );

    if (!user.id || !user.organizationId) {
      throw new UnauthorizedException(
        'User must complete onboarding before managing connections',
      );
    }

    await this.mendixService.disconnect(user.id, user.organizationId);

    return {
      success: true,
      message: 'Mendix connection removed successfully',
    };
  }

  @Post('test')
  @ApiOperation({ summary: 'Test Mendix connection' })
  @ApiResponse({ status: 200, description: 'Connection test result' })
  @ApiBearerAuth()
  async testConnection(@CurrentUser() user: AuthenticatedUser) {
    this.logger.log(
      `User ${user.id} testing Mendix connection for organization ${user.organizationId}`,
    );

    if (!user.id || !user.organizationId) {
      throw new UnauthorizedException(
        'User must complete onboarding before testing connections',
      );
    }

    const connected = await this.mendixService.testConnection(
      user.id,
      user.organizationId,
    );

    return {
      success: connected,
      connected,
      message: connected
        ? 'Mendix connection is active'
        : 'Mendix connection test failed',
    };
  }

  @Get('status')
  @ApiOperation({ summary: 'Get Mendix connection status' })
  @ApiResponse({ status: 200, description: 'Connection status' })
  @ApiBearerAuth()
  async getStatus(@CurrentUser() user: AuthenticatedUser) {
    if (!user.id || !user.organizationId) {
      throw new UnauthorizedException(
        'User must complete onboarding before checking connection status',
      );
    }

    const status = await this.mendixService.getConnectionStatus(
      user.id,
      user.organizationId,
    );

    return {
      success: true,
      platform: 'MENDIX',
      status,
    };
  }

  @Get('projects')
  @ApiOperation({ summary: 'List Mendix projects' })
  @ApiResponse({ status: 200, description: 'List of projects' })
  @ApiBearerAuth()
  async listProjects(@CurrentUser() user: AuthenticatedUser) {
    this.logger.log(
      `User ${user.id} listing Mendix projects for organization ${user.organizationId}`,
    );

    if (!user.id || !user.organizationId) {
      throw new UnauthorizedException(
        'User must complete onboarding before accessing Mendix resources',
      );
    }

    const projects = await this.mendixService.listProjects(
      user.id,
      user.organizationId,
    );

    return {
      success: true,
      count: projects.length,
      projects,
    };
  }

  @Get('apps')
  @ApiOperation({ summary: 'List Mendix applications' })
  @ApiResponse({ status: 200, description: 'List of apps' })
  @ApiBearerAuth()
  async listApps(
    @CurrentUser() user: AuthenticatedUser,
    @Query('projectId') projectId?: string,
  ) {
    this.logger.log(
      `User ${user.id} listing Mendix apps (project: ${projectId || 'all'}) for organization ${user.organizationId}`,
    );

    if (!user.id || !user.organizationId) {
      throw new UnauthorizedException(
        'User must complete onboarding before accessing Mendix resources',
      );
    }

    const apps = await this.mendixService.listApps(
      user.id,
      user.organizationId,
      projectId,
    );

    return {
      success: true,
      count: apps.length,
      projectId: projectId || 'all',
      apps,
    };
  }

  @Get('apps/:id')
  @ApiOperation({ summary: 'Get Mendix app details' })
  @ApiResponse({ status: 200, description: 'App details' })
  @ApiBearerAuth()
  async getApp(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') appId: string,
  ) {
    this.logger.log(
      `User ${user.id} fetching Mendix app: ${appId} for organization ${user.organizationId}`,
    );

    if (!user.id || !user.organizationId) {
      throw new UnauthorizedException(
        'User must complete onboarding before accessing Mendix resources',
      );
    }

    const app = await this.mendixService.getApp(
      user.id,
      user.organizationId,
      appId,
    );

    return {
      success: true,
      app,
    };
  }

  @Post('apps/:id/sync')
  @ApiOperation({ summary: 'Sync Mendix app to database' })
  @ApiResponse({ status: 200, description: 'Sync result' })
  @ApiBody({
    schema: {
      type: 'object',
      properties: {
        changeTitle: {
          type: 'string',
          description:
            'Title describing what has changed (max 75 chars). Used for version tracking.',
          example: 'Add new login page',
          maxLength: 75,
        },
      },
    },
  })
  @ApiBearerAuth()
  async syncApp(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') appId: string,
    @Body() body?: { changeTitle?: string },
  ) {
    this.logger.log(
      `User ${user.id} syncing Mendix app: ${appId} for organization ${user.organizationId}`,
    );

    if (!user.id || !user.organizationId) {
      throw new UnauthorizedException(
        'User must complete onboarding before syncing Mendix apps',
      );
    }

    const result = await this.mendixService.syncApp(
      user.id,
      user.organizationId,
      appId,
      body?.changeTitle,
    );

    return result;
  }

  @Get('apps/:id/export')
  @ApiOperation({
    summary: 'Export Mendix app package (requires SVN integration)',
  })
  @ApiResponse({
    status: 501,
    description: 'Not yet implemented - requires SVN client',
  })
  @ApiBearerAuth()
  async exportApp(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') appId: string,
    @Res() res: Response,
  ) {
    this.logger.log(
      `User ${user.id} attempting to export Mendix app: ${appId}`,
    );

    try {
      if (!user.id || !user.organizationId) {
        return res.status(HttpStatus.UNAUTHORIZED).json({
          success: false,
          message: 'User must complete onboarding before exporting Mendix apps',
        });
      }

      // This will throw an error explaining SVN requirement
      await this.mendixService.exportApp(user.id, user.organizationId, appId);
    } catch (error) {
      this.logger.error('Export error:', error);
      res.status(HttpStatus.NOT_IMPLEMENTED).json({
        success: false,
        message:
          error.message || 'Mendix app export requires SVN client integration',
        note: 'This feature will be implemented in a future version',
      });
    }
  }
}

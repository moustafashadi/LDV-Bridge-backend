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
  UseGuards,
  Req,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiBearerAuth, ApiQuery } from '@nestjs/swagger';
import type { Response } from 'express';
import { PowerAppsService } from './powerapps.service';
import { CurrentUser } from '../../auth/decorators/current-user.decorator';
import type { AuthenticatedUser } from '../../auth/interfaces/authenticated-user.interface';

@ApiTags('PowerApps Connector')
@Controller('connectors/powerapps')
export class PowerAppsController {
  private readonly logger = new Logger(PowerAppsController.name);

  constructor(private readonly powerAppsService: PowerAppsService) {}

  @Post('connect')
  @ApiOperation({ summary: 'Initiate PowerApps OAuth connection' })
  @ApiResponse({ status: 200, description: 'Returns authorization URL' })
  @ApiBearerAuth()
  async initiateConnection(@CurrentUser() user: AuthenticatedUser) {
    this.logger.log(`User ${user.id} (${user.email}) initiating PowerApps connection for organization ${user.organizationId}`);
    
    // Ensure user has completed onboarding and belongs to an organization
    if (!user.id || !user.organizationId) {
      throw new UnauthorizedException('User must complete onboarding before connecting platforms');
    }
    
    const authorizationUrl = await this.powerAppsService.initiateOAuth(user.id, user.organizationId);
    
    return {
      success: true,
      authorizationUrl,
      message: 'Redirect user to authorization URL',
    };
  }

  @Get('callback')
  @ApiOperation({ summary: 'Handle OAuth callback from Microsoft' })
  @ApiQuery({ name: 'code', required: true, description: 'Authorization code' })
  @ApiQuery({ name: 'state', required: true, description: 'State parameter' })
  @ApiResponse({ status: 200, description: 'Connection successful' })
  async handleCallback(
    @Query('code') code: string,
    @Query('state') state: string,
    @Res() res: Response,
  ) {
    try {
      this.logger.log('Processing PowerApps OAuth callback');
      
      const token = await this.powerAppsService.completeOAuth(code, state);
      
      if (token) {
        // Redirect to frontend success page
        return res.redirect(`${process.env.FRONTEND_URL || 'http://localhost:3000'}/admin/connectors?status=success&platform=powerapps`);
      } else {
        return res.redirect(`${process.env.FRONTEND_URL || 'http://localhost:3000'}/admin/connectors?status=error&message=${encodeURIComponent('Failed to complete OAuth flow')}`);
      }
    } catch (error) {
      this.logger.error('OAuth callback error:', error);
      return res.redirect(`${process.env.FRONTEND_URL || 'http://localhost:3000'}/admin/connectors?status=error&message=${encodeURIComponent(error.message)}`);
    }
  }

  @Post('disconnect')
  @ApiOperation({ summary: 'Disconnect PowerApps account' })
  @ApiResponse({ status: 200, description: 'Successfully disconnected' })
  @ApiBearerAuth()
  async disconnect(@CurrentUser() user: AuthenticatedUser) {
    this.logger.log(`User ${user.id} disconnecting PowerApps for organization ${user.organizationId}`);
    
    if (!user.id || !user.organizationId) {
      throw new UnauthorizedException('User must complete onboarding before managing connections');
    }
    
    const result = await this.powerAppsService.disconnect(user.id, user.organizationId);
    
    return result;
  }

  @Post('test')
  @ApiOperation({ summary: 'Test PowerApps connection' })
  @ApiResponse({ status: 200, description: 'Connection test result' })
  @ApiBearerAuth()
  async testConnection(@CurrentUser() user: AuthenticatedUser) {
    this.logger.log(`User ${user.id} testing PowerApps connection for organization ${user.organizationId}`);
    
    if (!user.id || !user.organizationId) {
      throw new UnauthorizedException('User must complete onboarding before testing connections');
    }
    
    const result = await this.powerAppsService.testConnection(user.id, user.organizationId);
    
    return result;
  }

  @Get('status')
  @ApiOperation({ summary: 'Get PowerApps connection status' })
  @ApiResponse({ status: 200, description: 'Connection status' })
  @ApiBearerAuth()
  async getStatus(@CurrentUser() user: AuthenticatedUser) {
    if (!user.id || !user.organizationId) {
      throw new UnauthorizedException('User must complete onboarding before checking connection status');
    }
    
    const status = await this.powerAppsService.getConnectionStatus(user.id, user.organizationId);
    
    return {
      success: true,
      platform: 'POWERAPPS',
      status,
    };
  }

  @Get('environments')
  @ApiOperation({ summary: 'List PowerApps environments' })
  @ApiResponse({ status: 200, description: 'List of environments' })
  @ApiBearerAuth()
  async listEnvironments(@CurrentUser() user: AuthenticatedUser) {
    this.logger.log(`User ${user.id} listing PowerApps environments for organization ${user.organizationId}`);
    
    if (!user.id || !user.organizationId) {
      throw new UnauthorizedException('User must complete onboarding before accessing PowerApps resources');
    }
    
    const environments = await this.powerAppsService.listEnvironments(user.id, user.organizationId);
    
    return {
      success: true,
      count: environments.length,
      environments,
    };
  }

  @Get('apps')
  @ApiOperation({ summary: 'List PowerApps applications' })
  @ApiQuery({ name: 'environmentId', required: false, description: 'Filter by environment' })
  @ApiResponse({ status: 200, description: 'List of apps' })
  @ApiBearerAuth()
  async listApps(
    @CurrentUser() user: AuthenticatedUser,
    @Query('environmentId') environmentId?: string,
  ) {
    this.logger.log(`User ${user.id} listing PowerApps (environment: ${environmentId || 'all'}) for organization ${user.organizationId}`);
    
    if (!user.id || !user.organizationId) {
      throw new UnauthorizedException('User must complete onboarding before accessing PowerApps resources');
    }
    
    const apps = await this.powerAppsService.listApps(user.id, user.organizationId, environmentId);
    
    return {
      success: true,
      count: apps.length,
      environmentId: environmentId || 'all',
      apps,
    };
  }

  @Get('apps/:id')
  @ApiOperation({ summary: 'Get PowerApp details' })
  @ApiResponse({ status: 200, description: 'App details' })
  @ApiBearerAuth()
  async getApp(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') appId: string,
  ) {
    this.logger.log(`User ${user.id} fetching PowerApp: ${appId} for organization ${user.organizationId}`);
    
    if (!user.id || !user.organizationId) {
      throw new UnauthorizedException('User must complete onboarding before accessing PowerApps resources');
    }
    
    const app = await this.powerAppsService.getApp(user.id, user.organizationId, appId);
    
    return {
      success: true,
      app,
    };
  }

  @Post('apps/:id/sync')
  @ApiOperation({ summary: 'Sync PowerApp to database' })
  @ApiResponse({ status: 200, description: 'Sync result' })
  @ApiBearerAuth()
  async syncApp(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') appId: string,
  ) {
    this.logger.log(`User ${user.id} syncing PowerApp: ${appId} for organization ${user.organizationId}`);
    
    if (!user.id || !user.organizationId) {
      throw new UnauthorizedException('User must complete onboarding before syncing PowerApps');
    }
    
    const result = await this.powerAppsService.syncApp(user.id, user.organizationId, appId);
    
    return result;
  }

  @Get('apps/:id/export')
  @ApiOperation({ summary: 'Export PowerApp package' })
  @ApiResponse({ status: 200, description: 'App package (binary)' })
  @ApiBearerAuth()
  async exportApp(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') appId: string,
    @Res() res: Response,
  ) {
    this.logger.log(`User ${user.id} exporting PowerApp: ${appId} for organization ${user.organizationId}`);
    
    try {
      if (!user.id || !user.organizationId) {
        return res.status(HttpStatus.UNAUTHORIZED).json({
          success: false,
          message: 'User must complete onboarding before exporting PowerApps',
        });
      }
      
      const packageData = await this.powerAppsService.exportApp(user.id, user.organizationId, appId);
      
      // Set response headers for file download
      res.set({
        'Content-Type': 'application/zip',
        'Content-Disposition': `attachment; filename="${appId}.msapp"`,
        'Content-Length': packageData.length,
      });
      
      res.send(packageData);
    } catch (error) {
      this.logger.error('Export error:', error);
      res.status(HttpStatus.INTERNAL_SERVER_ERROR).json({
        success: false,
        message: error.message,
      });
    }
  }
}

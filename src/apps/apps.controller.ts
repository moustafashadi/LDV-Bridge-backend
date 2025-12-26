import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Param,
  Body,
  UseGuards,
  HttpCode,
  HttpStatus,
  Sse,
  MessageEvent,
} from '@nestjs/common';
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiBearerAuth,
} from '@nestjs/swagger';
import {
  Observable,
  map,
  interval,
  takeWhile,
  startWith,
  mergeMap,
  EMPTY,
} from 'rxjs';
import { AppsService } from './apps.service';
import {
  AppCreationProgressService,
  AppCreationProgressEvent,
} from './app-creation-progress.service';
import { MendixService } from '../connectors/mendix/mendix.service';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { Public } from '../auth/decorators/public.decorator';
import type { AuthenticatedUser } from '../auth/interfaces/authenticated-user.interface';
import {
  GrantAppAccessDto,
  UpdateAppAccessDto,
} from './dto/grant-app-access.dto';
import { CreateAppDto } from './dto/create-app.dto';
import {
  CreateMendixAppDto,
  CreateMendixAppResponseDto,
} from './dto/create-mendix-app.dto';
import {
  AppPermissionResponseDto,
  UserAppAccessResponseDto,
} from './dto/app-access-response.dto';
import { UserRole } from '@prisma/client';

@ApiTags('Apps')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Controller('apps')
export class AppsController {
  constructor(
    private readonly appsService: AppsService,
    private readonly mendixService: MendixService,
    private readonly appCreationProgressService: AppCreationProgressService,
  ) {}

  // ============================================
  // APP CRUD
  // ============================================

  @Post()
  @Roles(UserRole.ADMIN, UserRole.PRO_DEVELOPER, UserRole.CITIZEN_DEVELOPER)
  @ApiOperation({ summary: 'Create a new app' })
  @ApiResponse({ status: 201, description: 'App created successfully' })
  @ApiResponse({
    status: 400,
    description: 'Bad request - validation failed or duplicate app',
  })
  async createApp(
    @Body() dto: CreateAppDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    if (!user.id || !user.organizationId) {
      throw new Error(
        'User must be authenticated and belong to an organization',
      );
    }
    return this.appsService.createApp(user.id, user.organizationId, dto);
  }

  @Post('mendix/create')
  @Roles(UserRole.ADMIN, UserRole.PRO_DEVELOPER, UserRole.CITIZEN_DEVELOPER)
  @ApiOperation({
    summary: 'Create a new Mendix app',
    description: `Creates a new Mendix app with full integration:
    1. Creates Mendix project via Build API
    2. Creates GitHub repository for version control (if org has GitHub integration)
    3. Performs initial sync using Model SDK
    
    NOTE: This does NOT create a sandbox/environment. Use the sandbox creation
    endpoint separately if you need a deployed environment.`,
  })
  @ApiResponse({
    status: 201,
    description: 'Mendix app created successfully',
    type: CreateMendixAppResponseDto,
  })
  @ApiResponse({
    status: 400,
    description:
      'Bad request - validation failed, no connector, or Mendix API error',
  })
  @ApiResponse({
    status: 401,
    description: 'Unauthorized - Invalid or missing PAT token',
  })
  async createMendixApp(
    @Body() dto: CreateMendixAppDto,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<CreateMendixAppResponseDto> {
    if (!user.id || !user.organizationId) {
      throw new Error(
        'User must be authenticated and belong to an organization',
      );
    }
    return this.mendixService.createMendixApp(user.id, user.organizationId, {
      name: dto.name,
      description: dto.description,
      connectorId: dto.connectorId,
      tempId: dto.tempId,
    });
  }

  @Sse('creation/:tempId/progress')
  @Public()
  @ApiOperation({
    summary: 'Stream app creation progress via Server-Sent Events',
    description:
      'Subscribe to real-time progress updates for app creation. Uses SSE for streaming.',
  })
  @ApiResponse({
    status: 200,
    description: 'SSE stream of app creation progress events',
  })
  appCreationProgress(
    @Param('tempId') tempId: string,
  ): Observable<MessageEvent> {
    // Create a stream that:
    // 1. Subscribes to progress events for this tempId
    // 2. Keeps connection alive with heartbeats
    // 3. Completes when app creation is done or errors

    let completed = false;

    return interval(1000).pipe(
      startWith(0),
      mergeMap(() => {
        if (completed) {
          return EMPTY;
        }
        return this.appCreationProgressService.getProgressStream(tempId);
      }),
      takeWhile((event) => {
        if (event.status === 'completed' || event.status === 'error') {
          completed = true;
          return true; // Emit this final event then stop
        }
        return true;
      }),
      map((event: AppCreationProgressEvent) => ({
        data: JSON.stringify(event),
      })),
    );
  }

  @Get()
  @Roles(UserRole.ADMIN, UserRole.PRO_DEVELOPER)
  @ApiOperation({ summary: 'Get all apps in the organization' })
  @ApiResponse({ status: 200, description: 'List of all organization apps' })
  async getAllApps(@CurrentUser() user: AuthenticatedUser) {
    if (!user.organizationId) {
      throw new Error('User must belong to an organization');
    }
    return this.appsService.getAllApps(user.organizationId);
  }

  @Get(':id')
  @Roles(UserRole.ADMIN, UserRole.PRO_DEVELOPER, UserRole.CITIZEN_DEVELOPER)
  @ApiOperation({ summary: 'Get a single app by ID' })
  @ApiResponse({ status: 200, description: 'App details' })
  @ApiResponse({ status: 404, description: 'App not found' })
  async getAppById(
    @Param('id') id: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    if (!user.organizationId) {
      throw new Error('User must belong to an organization');
    }
    return this.appsService.getAppById(id, user.organizationId);
  }

  // ============================================
  // APP ACCESS MANAGEMENT
  // ============================================

  @Post(':appId/access')
  @Roles(UserRole.ADMIN, UserRole.PRO_DEVELOPER)
  @ApiOperation({ summary: 'Grant app access to users' })
  @ApiResponse({
    status: 201,
    description: 'Access granted successfully',
    type: [AppPermissionResponseDto],
  })
  @ApiResponse({
    status: 403,
    description: 'Forbidden - Insufficient permissions',
  })
  @ApiResponse({ status: 404, description: 'App or users not found' })
  async grantAccess(
    @Param('appId') appId: string,
    @Body() dto: GrantAppAccessDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    if (!user.id || !user.organizationId) {
      throw new Error(
        'User must be authenticated and belong to an organization',
      );
    }
    return this.appsService.grantAccess(
      appId,
      user.id,
      user.organizationId,
      dto,
    );
  }

  @Get(':appId/access')
  @Roles(UserRole.ADMIN, UserRole.PRO_DEVELOPER)
  @ApiOperation({ summary: 'Get all users with access to an app' })
  @ApiResponse({
    status: 200,
    description: 'List of users with access',
    type: [AppPermissionResponseDto],
  })
  @ApiResponse({ status: 404, description: 'App not found' })
  async getAppAccess(
    @Param('appId') appId: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    if (!user.organizationId) {
      throw new Error('User must belong to an organization');
    }
    return this.appsService.getAppAccess(appId, user.organizationId);
  }

  @Patch(':appId/access/:userId')
  @Roles(UserRole.ADMIN, UserRole.PRO_DEVELOPER)
  @ApiOperation({ summary: 'Update app access level for a user' })
  @ApiResponse({
    status: 200,
    description: 'Access updated successfully',
    type: AppPermissionResponseDto,
  })
  @ApiResponse({
    status: 403,
    description: 'Forbidden - Insufficient permissions',
  })
  @ApiResponse({ status: 404, description: 'App or user access not found' })
  async updateAccess(
    @Param('appId') appId: string,
    @Param('userId') userId: string,
    @Body() dto: UpdateAppAccessDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    if (!user.id || !user.organizationId) {
      throw new Error(
        'User must be authenticated and belong to an organization',
      );
    }
    return this.appsService.updateAccess(
      appId,
      userId,
      user.id,
      user.organizationId,
      dto,
    );
  }

  @Delete(':appId/access/:userId')
  @Roles(UserRole.ADMIN, UserRole.PRO_DEVELOPER)
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Revoke app access from a user' })
  @ApiResponse({ status: 204, description: 'Access revoked successfully' })
  @ApiResponse({
    status: 403,
    description: 'Forbidden - Insufficient permissions',
  })
  @ApiResponse({ status: 404, description: 'App or user access not found' })
  async revokeAccess(
    @Param('appId') appId: string,
    @Param('userId') userId: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    if (!user.id || !user.organizationId) {
      throw new Error(
        'User must be authenticated and belong to an organization',
      );
    }
    return this.appsService.revokeAccess(
      appId,
      userId,
      user.id,
      user.organizationId,
    );
  }

  // ============================================
  // USER'S APPS
  // ============================================

  @Get('users/:userId/apps')
  @Roles(UserRole.ADMIN, UserRole.PRO_DEVELOPER)
  @ApiOperation({ summary: 'Get all apps a user has access to' })
  @ApiResponse({
    status: 200,
    description: 'List of apps user can access',
    type: [UserAppAccessResponseDto],
  })
  async getUserApps(
    @Param('userId') userId: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    if (!user.organizationId) {
      throw new Error('User must belong to an organization');
    }
    // Admin can view any user's apps, others can only view their own
    if (user.role !== 'ADMIN' && userId !== user.id) {
      throw new Error('Forbidden');
    }
    return this.appsService.getUserApps(userId, user.organizationId);
  }

  @Get('me/apps')
  @ApiOperation({ summary: 'Get all apps the current user has access to' })
  @ApiResponse({
    status: 200,
    description: 'List of apps user can access',
    type: [UserAppAccessResponseDto],
  })
  async getMyApps(@CurrentUser() user: AuthenticatedUser) {
    if (!user.id || !user.organizationId) {
      throw new Error(
        'User must be authenticated and belong to an organization',
      );
    }
    return this.appsService.getUserApps(user.id, user.organizationId);
  }
}

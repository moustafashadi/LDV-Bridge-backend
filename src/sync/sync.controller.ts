import {
  Controller,
  Post,
  Get,
  Param,
  Query,
  UseGuards,
  ParseIntPipe,
  ParseEnumPipe,
} from '@nestjs/common';
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiBearerAuth,
  ApiParam,
  ApiQuery,
} from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import type { AuthenticatedUser } from '../auth/interfaces/authenticated-user.interface';
import { SyncService } from './sync.service';
import {
  TriggerSyncResponseDto,
  TriggerSyncDto,
} from './dto/trigger-sync.dto';
import { SyncStatusResponseDto } from './dto/sync-status.dto';
import { SyncHistoryResponseDto } from './dto/sync-history-response.dto';
import { PlatformType, SyncStatus } from '@prisma/client';

@ApiTags('Sync')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Controller('sync')
export class SyncController {
  constructor(private readonly syncService: SyncService) {}

  @Post('trigger/:platform/:appId')
  @ApiOperation({
    summary: 'Manually trigger sync for an app',
    description:
      'Queue a background job to sync app data from PowerApps or Mendix',
  })
  @ApiParam({
    name: 'platform',
    enum: PlatformType,
    description: 'Platform type',
  })
  @ApiParam({
    name: 'appId',
    description: 'App ID',
  })
  @ApiQuery({
    name: 'reason',
    required: false,
    description: 'Optional reason for sync',
  })
  @ApiResponse({
    status: 201,
    description: 'Sync job queued successfully',
    type: TriggerSyncResponseDto,
  })
  @ApiResponse({
    status: 404,
    description: 'App not found',
  })
  @ApiResponse({
    status: 401,
    description: 'No active connection to platform',
  })
  async triggerSync(
    @Param('platform', new ParseEnumPipe(PlatformType)) platform: PlatformType,
    @Param('appId') appId: string,
    @Query('reason') reason?: string,
    @CurrentUser() user?: AuthenticatedUser,
  ): Promise<TriggerSyncResponseDto> {
    if (!user?.id || !user.organizationId) {
      throw new Error('User ID and organization ID are required');
    }

    return this.syncService.triggerManualSync(
      appId,
      user.id,
      user.organizationId,
      reason,
    );
  }

  @Get('status/:appId')
  @ApiOperation({
    summary: 'Get sync status for an app',
    description:
      'Get information about current and past sync operations for an app',
  })
  @ApiParam({
    name: 'appId',
    description: 'App ID',
  })
  @ApiResponse({
    status: 200,
    description: 'Sync status retrieved successfully',
    type: SyncStatusResponseDto,
  })
  @ApiResponse({
    status: 404,
    description: 'App not found',
  })
  async getSyncStatus(
    @Param('appId') appId: string,
    @CurrentUser() user?: AuthenticatedUser,
  ): Promise<SyncStatusResponseDto> {
    if (!user?.organizationId) {
      throw new Error('Organization ID is required');
    }

    return this.syncService.getSyncStatus(appId, user.organizationId);
  }

  @Get('history')
  @ApiOperation({
    summary: 'Get sync history',
    description:
      'Get paginated list of sync operations with optional filters',
  })
  @ApiQuery({
    name: 'page',
    required: false,
    type: Number,
    description: 'Page number (default: 1)',
  })
  @ApiQuery({
    name: 'limit',
    required: false,
    type: Number,
    description: 'Records per page (default: 20)',
  })
  @ApiQuery({
    name: 'appId',
    required: false,
    description: 'Filter by app ID',
  })
  @ApiQuery({
    name: 'status',
    required: false,
    enum: SyncStatus,
    description: 'Filter by sync status',
  })
  @ApiQuery({
    name: 'platform',
    required: false,
    enum: PlatformType,
    description: 'Filter by platform',
  })
  @ApiResponse({
    status: 200,
    description: 'Sync history retrieved successfully',
    type: SyncHistoryResponseDto,
  })
  async getSyncHistory(
    @Query('page', new ParseIntPipe({ optional: true })) page?: number,
    @Query('limit', new ParseIntPipe({ optional: true })) limit?: number,
    @Query('appId') appId?: string,
    @Query('status', new ParseEnumPipe(SyncStatus, { optional: true }))
    status?: SyncStatus,
    @Query('platform', new ParseEnumPipe(PlatformType, { optional: true }))
    platform?: PlatformType,
    @CurrentUser() user?: AuthenticatedUser,
  ): Promise<SyncHistoryResponseDto> {
    if (!user?.organizationId) {
      throw new Error('Organization ID is required');
    }

    return this.syncService.getSyncHistory(user.organizationId, {
      page,
      limit,
      appId,
      status,
      platform,
    });
  }
}

import {
  Injectable,
  NotFoundException,
  BadRequestException,
  UnauthorizedException,
  Logger,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectQueue } from '@nestjs/bull';
import type { Queue } from 'bull';
import { Cron, CronExpression } from '@nestjs/schedule';
import { PrismaService } from '../prisma/prisma.service';
import { PowerAppsService } from '../connectors/powerapps/powerapps.service';
import { MendixService } from '../connectors/mendix/mendix.service';
import { ComponentsService } from '../components/components.service';
import { ChangesService } from '../changes/changes.service';
import {
  PlatformType,
  SyncStatus,
  SyncTriggerType,
  App,
  UserConnection,
} from '@prisma/client';
import {
  SyncHistoryResponseDto,
  SyncHistoryItemDto,
  SyncJobData,
} from './dto/sync-history-response.dto';
import { SyncStatusResponseDto } from './dto/sync-status.dto';
import { TriggerSyncResponseDto } from './dto/trigger-sync.dto';

@Injectable()
export class SyncService {
  private readonly logger = new Logger(SyncService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly powerAppsService: PowerAppsService,
    private readonly mendixService: MendixService,
    private readonly componentsService: ComponentsService,
    private readonly changesService: ChangesService,
    @InjectQueue('app-sync') private readonly syncQueue: Queue,
    private readonly configService: ConfigService,
  ) {}

  /**
   * Trigger manual sync for a specific app
   */
  async triggerManualSync(
    appId: string,
    userId: string,
    organizationId: string,
    reason?: string,
  ): Promise<TriggerSyncResponseDto> {
    // Verify app exists and user has access
    const app = await this.prisma.app.findFirst({
      where: {
        id: appId,
        organizationId,
      },
    });

    if (!app) {
      throw new NotFoundException(`App with ID ${appId} not found`);
    }

    // Verify user has connection to this platform
    const connection = await this.prisma.userConnection.findUnique({
      where: {
        userId_platform: {
          userId,
          platform: app.platform,
        },
      },
    });

    if (!connection || !connection.isActive) {
      throw new UnauthorizedException(
        `No active connection to ${app.platform}. Please connect first.`,
      );
    }

    // Create sync history record
    const syncHistory = await this.prisma.syncHistory.create({
      data: {
        appId: app.id,
        organizationId: app.organizationId,
        platform: app.platform,
        status: SyncStatus.QUEUED,
        triggeredBy: userId,
        triggerType: SyncTriggerType.MANUAL,
        metadata: reason ? { reason } : undefined,
      },
    });

    // Queue sync job
    const job = await this.syncQueue.add(
      'sync-app',
      {
        appId: app.id,
        userId,
        triggerType: SyncTriggerType.MANUAL,
        reason,
      } as SyncJobData,
      {
        attempts: 3,
        backoff: {
          type: 'exponential',
          delay: 2000,
        },
      },
    );

    // Update sync history with job ID
    await this.prisma.syncHistory.update({
      where: { id: syncHistory.id },
      data: { jobId: job.id.toString() },
    });

    this.logger.log(
      `Manual sync queued for app ${app.name} (${app.id}) by user ${userId}`,
    );

    return {
      success: true,
      message: 'Sync job queued successfully',
      data: {
        jobId: job.id.toString(),
        appId: app.id,
        appName: app.name,
        platform: app.platform,
        status: 'queued',
        queuedAt: new Date(),
      },
    };
  }

  /**
   * Perform the actual sync operation (called by processor)
   */
  async performSync(
    appId: string,
    syncHistoryId: string,
  ): Promise<{ itemsSynced: number }> {
    // Get app with connection details
    const app = await this.prisma.app.findUnique({
      where: { id: appId },
      include: {
        owner: {
          include: {
            connections: {
              where: {
                platform: undefined, // Will be set below
                isActive: true,
              },
            },
          },
        },
      },
    });

    if (!app) {
      throw new NotFoundException(`App with ID ${appId} not found`);
    }

    // Get user connection for this platform
    const connection = await this.prisma.userConnection.findFirst({
      where: {
        userId: app.ownerId,
        platform: app.platform,
        isActive: true,
      },
    });

    if (!connection) {
      throw new BadRequestException(
        `No active connection to ${app.platform} for app owner`,
      );
    }

    // Update sync history to in progress
    await this.prisma.syncHistory.update({
      where: { id: syncHistoryId },
      data: {
        status: SyncStatus.IN_PROGRESS,
        startedAt: new Date(),
      },
    });

    try {
      let updatedMetadata: any;
      let itemsSynced = 0;

      // Fetch fresh data from platform
      if (app.platform === PlatformType.POWERAPPS) {
        updatedMetadata = await this.syncPowerAppsApp(app, connection);
        itemsSynced = 1; // One app updated
      } else if (app.platform === PlatformType.MENDIX) {
        updatedMetadata = await this.syncMendixApp(app, connection);
        itemsSynced = 1;
      } else {
        throw new BadRequestException(
          `Sync not implemented for platform: ${app.platform}`,
        );
      }

      // Update app in database
      await this.prisma.app.update({
        where: { id: app.id },
        data: {
          metadata: updatedMetadata,
          lastSyncedAt: new Date(),
        },
      });

      this.logger.log(`Successfully synced app ${app.name} (${app.id})`);

      // Extract components from synced metadata (Task 10)
      try {
        await this.componentsService.extractFromApp(
          app.id,
          'system',
          app.organizationId,
        );
        this.logger.log(`Extracted components for app ${app.id}`);
      } catch (error) {
        this.logger.warn(
          `Failed to extract components for app ${app.id}: ${error.message}`,
        );
      }

      // Detect changes after sync (Task 11)
      try {
        const changeDetection = await this.changesService.detectChanges(
          app.id,
          'system',
          app.organizationId,
        );
        if (changeDetection.totalChanges > 0) {
          this.logger.log(
            `Detected ${changeDetection.totalChanges} changes in app ${app.id}`,
          );
        }
      } catch (error) {
        this.logger.warn(
          `Failed to detect changes for app ${app.id}: ${error.message}`,
        );
      }

      return { itemsSynced };
    } catch (error) {
      this.logger.error(
        `Failed to sync app ${app.name} (${app.id}): ${error.message}`,
        error.stack,
      );
      throw error;
    }
  }

  /**
   * Sync PowerApps app
   */
  private async syncPowerAppsApp(
    app: App,
    connection: UserConnection,
  ): Promise<any> {
    this.logger.log(`Syncing PowerApps app: ${app.name} (${app.externalId})`);

    // Use PowerApps service to fetch latest app metadata
    const appDetails = await this.powerAppsService.getApp(
      connection.userId,
      app.organizationId,
      app.externalId,
    );

    return appDetails;
  }

  /**
   * Sync Mendix app
   */
  private async syncMendixApp(
    app: App,
    connection: UserConnection,
  ): Promise<any> {
    this.logger.log(`Syncing Mendix app: ${app.name} (${app.externalId})`);

    // Use Mendix service to fetch latest app metadata
    const appDetails = await this.mendixService.getApp(
      connection.userId,
      app.organizationId,
      app.externalId,
    );

    return appDetails;
  }

  /**
   * Get sync status for an app
   */
  async getSyncStatus(
    appId: string,
    organizationId: string,
  ): Promise<SyncStatusResponseDto> {
    const app = await this.prisma.app.findFirst({
      where: {
        id: appId,
        organizationId,
      },
    });

    if (!app) {
      throw new NotFoundException(`App with ID ${appId} not found`);
    }

    // Get latest sync history
    const latestSync = await this.prisma.syncHistory.findFirst({
      where: { appId: app.id },
      orderBy: { createdAt: 'desc' },
    });

    // Check for currently running sync
    const currentSync = await this.prisma.syncHistory.findFirst({
      where: {
        appId: app.id,
        status: { in: [SyncStatus.QUEUED, SyncStatus.IN_PROGRESS] },
      },
      orderBy: { createdAt: 'desc' },
    });

    // Calculate next scheduled sync (every hour from last sync)
    let nextScheduledSync: Date | undefined;
    if (app.lastSyncedAt) {
      nextScheduledSync = new Date(app.lastSyncedAt);
      nextScheduledSync.setHours(nextScheduledSync.getHours() + 1);
    }

    return {
      appId: app.id,
      appName: app.name,
      platform: app.platform,
      lastSyncedAt: app.lastSyncedAt || undefined,
      currentSync: currentSync
        ? {
            jobId: currentSync.jobId || 'unknown',
            status: currentSync.status,
            startedAt: currentSync.startedAt || currentSync.createdAt,
            currentOperation: `Syncing ${app.name}`,
          }
        : undefined,
      nextScheduledSync,
      lastSyncItemsCount: latestSync?.itemsSynced ?? undefined,
      lastSyncDuration: latestSync?.duration ?? undefined,
    };
  }

  /**
   * Get sync history with pagination and filters
   */
  async getSyncHistory(
    organizationId: string,
    filters: {
      appId?: string;
      status?: SyncStatus;
      platform?: PlatformType;
      page?: number;
      limit?: number;
    },
  ): Promise<SyncHistoryResponseDto> {
    const page = filters.page || 1;
    const limit = filters.limit || 20;
    const skip = (page - 1) * limit;

    const where: any = {
      organizationId,
    };

    if (filters.appId) {
      where.appId = filters.appId;
    }

    if (filters.status) {
      where.status = filters.status;
    }

    if (filters.platform) {
      where.platform = filters.platform;
    }

    // Get total count
    const total = await this.prisma.syncHistory.count({ where });

    // Get paginated records
    const records = await this.prisma.syncHistory.findMany({
      where,
      skip,
      take: limit,
      orderBy: { createdAt: 'desc' },
      include: {
        app: {
          select: {
            name: true,
          },
        },
      },
    });

    // Get user names for triggeredBy
    const userIds = records
      .map((r) => r.triggeredBy)
      .filter((id) => id !== 'system');
    const users = await this.prisma.user.findMany({
      where: { id: { in: userIds } },
      select: { id: true, name: true, displayName: true },
    });

    const userMap = new Map(
      users.map((u) => [u.id, u.displayName || u.name || u.id]),
    );

    const data: SyncHistoryItemDto[] = records.map((record) => ({
      id: record.id,
      appId: record.appId,
      appName: record.app.name,
      platform: record.platform,
      status: record.status,
      triggeredBy:
        record.triggeredBy === 'system'
          ? 'System (Auto-sync)'
          : userMap.get(record.triggeredBy) || record.triggeredBy,
      triggerType: record.triggerType,
      startedAt: record.startedAt ?? undefined,
      completedAt: record.completedAt ?? undefined,
      duration: record.duration ?? undefined,
      itemsSynced: record.itemsSynced ?? undefined,
      errorMessage: record.errorMessage ?? undefined,
      createdAt: record.createdAt,
    }));

    const totalPages = Math.ceil(total / limit);

    return {
      data,
      pagination: {
        total,
        page,
        limit,
        totalPages,
        hasMore: page < totalPages,
      },
    };
  }

  /**
   * Automatic sync cron job - runs every hour
   */
  @Cron(CronExpression.EVERY_HOUR)
  async scheduledSync() {
    // If automatic sync is disabled via configuration, skip the cron job
    const enabled = this.configService.get<string>('ENABLE_AUTOMATIC_SYNC');
    if (enabled && enabled.toLowerCase() === 'false') {
      this.logger.log(
        'Automatic sync is disabled via ENABLE_AUTOMATIC_SYNC=false; skipping scheduled run',
      );
      return;
    }

    this.logger.log('Running scheduled sync for all apps');

    try {
      // Find apps that haven't been synced in the last hour
      const oneHourAgo = new Date();
      oneHourAgo.setHours(oneHourAgo.getHours() - 1);

      const appsToSync = await this.prisma.app.findMany({
        where: {
          OR: [{ lastSyncedAt: null }, { lastSyncedAt: { lt: oneHourAgo } }],
        },
        include: {
          owner: {
            include: {
              connections: {
                where: {
                  isActive: true,
                },
              },
            },
          },
        },
        take: 50, // Limit to 50 apps per run to avoid overload
      });

      this.logger.log(`Found ${appsToSync.length} apps to sync`);

      for (const app of appsToSync) {
        // Check if user has active connection for this platform
        const hasConnection = app.owner.connections.some(
          (conn) => conn.platform === app.platform && conn.isActive,
        );

        if (!hasConnection) {
          this.logger.warn(
            `Skipping app ${app.name} - owner has no active connection to ${app.platform}`,
          );
          continue;
        }

        // Create sync history record
        const syncHistory = await this.prisma.syncHistory.create({
          data: {
            appId: app.id,
            organizationId: app.organizationId,
            platform: app.platform,
            status: SyncStatus.QUEUED,
            triggeredBy: 'system',
            triggerType: SyncTriggerType.AUTOMATIC,
          },
        });

        // Queue sync job
        const job = await this.syncQueue.add(
          'sync-app',
          {
            appId: app.id,
            userId: app.ownerId,
            triggerType: SyncTriggerType.AUTOMATIC,
          } as SyncJobData,
          {
            attempts: 3,
            backoff: {
              type: 'exponential',
              delay: 2000,
            },
          },
        );

        // Update sync history with job ID
        await this.prisma.syncHistory.update({
          where: { id: syncHistory.id },
          data: { jobId: job.id.toString() },
        });

        this.logger.log(
          `Queued automatic sync for app ${app.name} (${app.id})`,
        );
      }

      this.logger.log(
        `Scheduled sync completed - queued ${appsToSync.length} apps`,
      );
    } catch (error) {
      this.logger.error(`Scheduled sync failed: ${error.message}`, error.stack);
    }
  }
}

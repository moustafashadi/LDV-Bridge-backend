import { Processor, Process } from '@nestjs/bull';
import { Logger } from '@nestjs/common';
import type { Job } from 'bull';
import { PrismaService } from '../../prisma/prisma.service';
import { SyncService } from '../sync.service';
import { SyncJobData } from '../dto/sync-history-response.dto';

@Processor('app-sync')
export class SyncProcessor {
  private readonly logger = new Logger(SyncProcessor.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly syncService: SyncService,
  ) {}

  @Process('sync-app')
  async processSyncJob(job: Job<SyncJobData>) {
    const { appId, userId, triggerType } = job.data;

    this.logger.log(
      `Processing sync job ${job.id} for app ${appId} (${triggerType})`,
    );

    // Find the sync history record for this job
    const syncHistory = await this.prisma.syncHistory.findFirst({
      where: {
        jobId: job.id.toString(),
      },
    });

    if (!syncHistory) {
      this.logger.error(`No sync history found for job ${job.id}`);
      throw new Error(`Sync history not found for job ${job.id}`);
    }

    const startTime = Date.now();

    try {
      // Update sync history to in progress
      await this.prisma.syncHistory.update({
        where: { id: syncHistory.id },
        data: {
          status: 'IN_PROGRESS',
          startedAt: new Date(),
        },
      });

      // Perform the actual sync
      const result = await this.syncService.performSync(appId, syncHistory.id);

      const duration = Date.now() - startTime;

      // Update sync history to completed
      await this.prisma.syncHistory.update({
        where: { id: syncHistory.id },
        data: {
          status: 'COMPLETED',
          completedAt: new Date(),
          duration,
          itemsSynced: result.itemsSynced,
        },
      });

      this.logger.log(
        `Successfully completed sync job ${job.id} for app ${appId} in ${duration}ms`,
      );

      return {
        success: true,
        itemsSynced: result.itemsSynced,
        duration,
      };
    } catch (error) {
      const duration = Date.now() - startTime;

      // Update sync history to failed
      await this.prisma.syncHistory.update({
        where: { id: syncHistory.id },
        data: {
          status: 'FAILED',
          completedAt: new Date(),
          duration,
          errorMessage: error.message,
          errorStack: error.stack,
        },
      });

      this.logger.error(
        `Sync job ${job.id} for app ${appId} failed: ${error.message}`,
        error.stack,
      );

      // Throw error so Bull can retry
      throw error;
    }
  }
}

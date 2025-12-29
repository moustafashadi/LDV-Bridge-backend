import { Module, forwardRef } from '@nestjs/common';
import { ScheduleModule } from '@nestjs/schedule';
import { SandboxesController } from './sandboxes.controller';
import { SandboxesService } from './sandboxes.service';
import { SyncProgressService } from './sync-progress.service';
import { PowerAppsProvisioner } from './provisioners/powerapps.provisioner';
import { MendixProvisioner } from './provisioners/mendix.provisioner';
import { PrismaModule } from '../prisma/prisma.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { AuditModule } from '../common/audit/audit.module';
import { ConnectorsModule } from '../connectors/connectors.module';
import { GitHubModule } from '../github/github.module';
import { ChangesModule } from '../changes/changes.module';
import { ReviewsModule } from '../reviews/reviews.module';

@Module({
  imports: [
    PrismaModule,
    NotificationsModule,
    AuditModule,
    forwardRef(() => ConnectorsModule), // Provides PowerAppsService, MendixService, MendixModelSdkService
    forwardRef(() => GitHubModule), // Provides GitHubService
    forwardRef(() => ChangesModule), // Provides ChangesService
    forwardRef(() => ReviewsModule), // Provides ReviewsService for creating reviews on sandbox submit
    ScheduleModule.forRoot(), // Enable cron jobs
  ],
  controllers: [SandboxesController],
  providers: [
    SandboxesService,
    SyncProgressService,
    PowerAppsProvisioner,
    MendixProvisioner,
  ],
  exports: [SandboxesService, SyncProgressService],
})
export class SandboxesModule {}

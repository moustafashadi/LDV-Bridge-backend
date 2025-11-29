import { Module } from '@nestjs/common';
import { ScheduleModule } from '@nestjs/schedule';
import { SandboxesController } from './sandboxes.controller';
import { SandboxesService } from './sandboxes.service';
import { PowerAppsProvisioner } from './provisioners/powerapps.provisioner';
import { MendixProvisioner } from './provisioners/mendix.provisioner';
import { PrismaModule } from '../prisma/prisma.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { AuditModule } from '../common/audit/audit.module';
import { ConnectorsModule } from '../connectors/connectors.module';

@Module({
  imports: [
    PrismaModule,
    NotificationsModule,
    AuditModule,
    ConnectorsModule, // Provides PowerAppsService and MendixService
    ScheduleModule.forRoot(), // Enable cron jobs
  ],
  controllers: [SandboxesController],
  providers: [
    SandboxesService,
    PowerAppsProvisioner,
    MendixProvisioner,
  ],
  exports: [SandboxesService],
})
export class SandboxesModule {}

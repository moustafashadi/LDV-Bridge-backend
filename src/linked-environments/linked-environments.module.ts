import { Module } from '@nestjs/common';
import { LinkedEnvironmentsController } from './linked-environments.controller';
import { LinkedEnvironmentsService } from './linked-environments.service';
import { PrismaModule } from '../prisma/prisma.module';
import { AuditModule } from '../common/audit/audit.module';
import { ConnectorsModule } from '../connectors/connectors.module';

@Module({
  imports: [
    PrismaModule,
    AuditModule,
    ConnectorsModule, // Provides PowerAppsService
  ],
  controllers: [LinkedEnvironmentsController],
  providers: [LinkedEnvironmentsService],
  exports: [LinkedEnvironmentsService],
})
export class LinkedEnvironmentsModule {}

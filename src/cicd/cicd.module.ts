import { Module } from '@nestjs/common';
import { CicdController } from './cicd.controller';
import { CicdService } from './cicd.service';
import { PrismaModule } from '../prisma/prisma.module';
import { GitHubModule } from '../github/github.module';
import { NotificationsModule } from '../notifications/notifications.module';

/**
 * CI/CD Module
 * Handles integration with GitHub Actions for automated validation of sandbox changes.
 * Provides webhook endpoint for pipeline status updates and service for triggering pipelines.
 */
@Module({
  imports: [PrismaModule, GitHubModule, NotificationsModule],
  controllers: [CicdController],
  providers: [CicdService],
  exports: [CicdService],
})
export class CicdModule {}

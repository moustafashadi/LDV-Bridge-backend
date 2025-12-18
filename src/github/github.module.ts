import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { GitHubService } from './github.service';
import { GitHubController } from './github.controller';
import { PrismaModule } from '../prisma/prisma.module';
import { PowerAppsExtractorService } from './extractors/powerapps.extractor';

@Module({
  imports: [ConfigModule, PrismaModule],
  controllers: [GitHubController],
  providers: [GitHubService, PowerAppsExtractorService],
  exports: [GitHubService, PowerAppsExtractorService],
})
export class GitHubModule {}

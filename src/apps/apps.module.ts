import { Module, forwardRef } from '@nestjs/common';
import { AppsController } from './apps.controller';
import { AppsService } from './apps.service';
import { AppCreationProgressService } from './app-creation-progress.service';
import { PrismaModule } from '../prisma/prisma.module';
import { ConnectorsModule } from '../connectors/connectors.module';

@Module({
  imports: [PrismaModule, forwardRef(() => ConnectorsModule)],
  controllers: [AppsController],
  providers: [AppsService, AppCreationProgressService],
  exports: [AppsService, AppCreationProgressService],
})
export class AppsModule {}

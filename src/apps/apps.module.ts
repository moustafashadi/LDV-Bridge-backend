import { Module, forwardRef } from '@nestjs/common';
import { AppsController } from './apps.controller';
import { AppsService } from './apps.service';
import { PrismaModule } from '../prisma/prisma.module';
import { ConnectorsModule } from '../connectors/connectors.module';

@Module({
  imports: [PrismaModule, forwardRef(() => ConnectorsModule)],
  controllers: [AppsController],
  providers: [AppsService],
  exports: [AppsService],
})
export class AppsModule {}

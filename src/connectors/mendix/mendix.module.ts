import { Module, forwardRef } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { MendixController } from './mendix.controller';
import { MendixService } from './mendix.service';
import { MendixModelSdkService } from './mendix-model-sdk.service';
import { TokenManagerService } from '../services/token-manager.service';
import { PrismaModule } from '../../prisma/prisma.module';
import { WebSocketModule } from '../../websocket/websocket.module';
import { AppsModule } from '../../apps/apps.module';
import { ChangesModule } from '../../changes/changes.module';
import { NotificationsModule } from '../../notifications/notifications.module';
import { GitHubModule } from '../../github/github.module';

@Module({
  imports: [
    ConfigModule,
    PrismaModule,
    WebSocketModule,
    AppsModule,
    forwardRef(() => ChangesModule),
    forwardRef(() => NotificationsModule),
    forwardRef(() => GitHubModule),
  ],
  controllers: [MendixController],
  providers: [MendixService, MendixModelSdkService, TokenManagerService],
  exports: [MendixService, MendixModelSdkService],
})
export class MendixModule {}

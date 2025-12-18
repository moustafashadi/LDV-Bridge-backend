import { Module, forwardRef } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { PowerAppsController } from './powerapps.controller';
import { PowerAppsService } from './powerapps.service';
import { OAuthService } from '../services/oauth.service';
import { TokenManagerService } from '../services/token-manager.service';
import { PrismaModule } from '../../prisma/prisma.module';
import { WebSocketModule } from '../../websocket/websocket.module';
import { AppsModule } from '../../apps/apps.module';
import { GitHubModule } from '../../github/github.module';

@Module({
  imports: [
    ConfigModule,
    PrismaModule,
    WebSocketModule,
    AppsModule,
    forwardRef(() => GitHubModule),
  ],
  controllers: [PowerAppsController],
  providers: [PowerAppsService, OAuthService, TokenManagerService],
  exports: [PowerAppsService],
})
export class PowerAppsModule {}

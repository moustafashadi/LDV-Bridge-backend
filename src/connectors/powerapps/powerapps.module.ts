import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { PowerAppsController } from './powerapps.controller';
import { PowerAppsService } from './powerapps.service';
import { OAuthService } from '../services/oauth.service';
import { TokenManagerService } from '../services/token-manager.service';
import { PrismaModule } from '../../prisma/prisma.module';

@Module({
  imports: [
    ConfigModule,
    PrismaModule,
  ],
  controllers: [PowerAppsController],
  providers: [
    PowerAppsService,
    OAuthService,
    TokenManagerService,
  ],
  exports: [PowerAppsService],
})
export class PowerAppsModule {}

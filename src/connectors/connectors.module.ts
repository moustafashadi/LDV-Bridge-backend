import { Module } from '@nestjs/common';
import { ConnectorsController } from './connectors.controller';
import { TokenManagerService } from './services/token-manager.service';
import { OAuthService } from './services/oauth.service';
import { PowerAppsModule } from './powerapps/powerapps.module';
import { MendixModule } from './mendix/mendix.module';

/**
 * Platform Connectors Module
 * Handles OAuth2 flows and token management for PowerApps & Mendix
 */
@Module({
  imports: [PowerAppsModule, MendixModule],
  controllers: [ConnectorsController],
  providers: [TokenManagerService, OAuthService],
  exports: [TokenManagerService, OAuthService, PowerAppsModule, MendixModule],
})
export class ConnectorsModule {}

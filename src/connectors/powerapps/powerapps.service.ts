import { Injectable, Logger, BadRequestException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios, { AxiosInstance } from 'axios';
import {
  IBaseConnector,
  OAuth2Token,
  ConnectionStatus,
  IPlatformApp,
  ISyncResult,
} from '../interfaces/base-connector.interface';
import { TokenManagerService } from '../services/token-manager.service';
import { OAuthService } from '../services/oauth.service';
import { ConnectorsWebSocketGateway } from '../../websocket/websocket.gateway';

/**
 * PowerApps environment info
 */
export interface PowerAppsEnvironment {
  id: string;
  name: string;
  location: string;
  type: string;
  properties: {
    displayName: string;
    description?: string;
    environmentSku?: string;
    isDefault?: boolean;
  };
}

/**
 * PowerApps application info
 */
export interface PowerAppsApp {
  name: string; // Unique identifier
  id: string; // App ID
  type: string; // Canvas or Model-driven
  properties: {
    displayName: string;
    description?: string;
    createdTime: string;
    lastModifiedTime: string;
    owner: {
      id: string;
      displayName?: string;
      email?: string;
    };
    appVersion?: string;
    isFeaturedApp?: boolean;
    bypassConsent?: boolean;
  };
}

/**
 * PowerApps Connector Service
 * Integrates with Microsoft Power Platform APIs
 */
@Injectable()
export class PowerAppsService implements IBaseConnector {
  private readonly logger = new Logger(PowerAppsService.name);
  private readonly platform = 'POWERAPPS';

  // OAuth2 configuration for Microsoft Identity Platform
  private readonly oauth2Config: {
    authorizationUrl: string;
    tokenUrl: string;
    clientId: string;
    clientSecret: string;
    redirectUri: string;
    scope: string;
  };

  // Power Platform API base URLs
  private readonly powerAppsApiUrl = 'https://api.powerapps.com/providers/Microsoft.PowerApps';
  private readonly bapApiUrl = 'https://api.bap.microsoft.com/providers/Microsoft.BusinessAppPlatform';

  constructor(
    private config: ConfigService,
    private tokenManager: TokenManagerService,
    private oauthService: OAuthService,
    private websocketGateway: ConnectorsWebSocketGateway,
  ) {
    // Initialize OAuth config after constructor injection
    // Multi-tenant: works with any Azure AD organization
    this.oauth2Config = {
      authorizationUrl: 'https://login.microsoftonline.com/common/oauth2/v2.0/authorize',
      tokenUrl: 'https://login.microsoftonline.com/common/oauth2/v2.0/token',
      clientId: this.config.get<string>('POWERAPP_CLIENT_ID') || '',
      clientSecret: this.config.get<string>('POWERAPP_CLIENT_SECRET') || '',
      redirectUri: this.config.get<string>('POWERAPP_REDIRECT_URI') || '',
      // Use Microsoft Graph scopes - available in all Azure AD tenants
      scope: 'User.Read offline_access openid profile email',
    };

    this.validateConfig();
  }

  /**
   * Validate required configuration
   */
  private validateConfig(): void {
    if (!this.oauth2Config.clientId || !this.oauth2Config.clientSecret) {
      this.logger.warn(
        'PowerApps OAuth credentials not configured. Set POWERAPP_CLIENT_ID and POWERAPP_CLIENT_SECRET',
      );
    }
  }

  /**
   * Create authenticated axios instance
   */
  private async getAuthenticatedClient(
    userId: string,
    organizationId: string,
  ): Promise<AxiosInstance> {
    const token = await this.tokenManager.getToken(userId, this.platform);

    if (!token) {
      throw new BadRequestException(
        'No PowerApps connection found. Please connect first.',
      );
    }

    // Check if token is expired and refresh if needed
    const isExpired = await this.tokenManager.isTokenExpired(
      userId,
      this.platform,
    );

    if (isExpired && token.refreshToken) {
      this.logger.log(`Refreshing expired PowerApps token for user ${userId}`);
      const newToken = await this.refreshToken(token.refreshToken);
      await this.tokenManager.saveToken(
        userId,
        organizationId,
        this.platform,
        newToken,
      );
      token.accessToken = newToken.accessToken;
    }

    return axios.create({
      headers: {
        Authorization: `Bearer ${token.accessToken}`,
        'Content-Type': 'application/json',
      },
    });
  }

  /**
   * Initiate OAuth2 flow
   */
  async initiateOAuth(userId: string, organizationId: string): Promise<string> {
    this.logger.log(`Initiating PowerApps OAuth for user ${userId}`);

    const state = this.oauthService.generateState(userId, organizationId);

    const authUrl = this.oauthService.generateAuthUrl(
      this.oauth2Config,
      state,
      {
        response_mode: 'query',
        prompt: 'consent', // Force consent to ensure refresh token
      },
    );

    return authUrl;
  }

  /**
   * Complete OAuth2 flow
   */
  async completeOAuth(code: string, state: string): Promise<OAuth2Token> {
    this.logger.log('Completing PowerApps OAuth flow');

    // Validate and parse state
    const { userId, organizationId } = this.oauthService.parseState(state);

    // Exchange code for token
    const token = await this.oauthService.exchangeCodeForToken(
      this.oauth2Config,
      code,
    );

    // Save encrypted token
    await this.tokenManager.saveToken(
      userId,
      organizationId,
      this.platform,
      token,
    );

    // Update connection status
    await this.tokenManager.updateConnectionStatus(
      userId,
      this.platform,
      ConnectionStatus.CONNECTED,
    );

    // Emit WebSocket event
    this.websocketGateway.emitConnectionStatusChanged({
      platform: this.platform,
      userId,
      status: ConnectionStatus.CONNECTED,
    });

    this.logger.log(`PowerApps connection established for user ${userId}`);

    return token;
  }

  /**
   * Refresh expired access token
   */
  async refreshToken(refreshToken: string): Promise<OAuth2Token> {
    this.logger.log('Refreshing PowerApps access token');

    return this.oauthService.refreshAccessToken(
      this.oauth2Config,
      refreshToken,
    );
  }

  /**
   * Test connection
   */
  async testConnection(
    userId: string,
    organizationId: string,
  ): Promise<boolean> {
    try {
      this.logger.log(`Testing PowerApps connection for user ${userId}`);

      const client = await this.getAuthenticatedClient(
        userId,
        organizationId,
      );

      // First, try to validate token with Microsoft Graph /me endpoint
      // (works when app requested Graph scopes like User.Read)
      try {
        const graphResponse = await client.get('https://graph.microsoft.com/v1.0/me');
        if (graphResponse.status === 200) {
          await this.tokenManager.updateConnectionStatus(
            userId,
            this.platform,
            ConnectionStatus.CONNECTED,
          );

          return true;
        }
      } catch (graphErr) {
        // Graph validation failed - fall back to Power Platform BAP API
        this.logger.debug('Graph /me token validation failed, falling back to BAP API');
      }

      // Try to fetch user's environments as a connection test (PowerApps BAP API)
      const response = await client.get(
        `${this.bapApiUrl}/environments?api-version=2020-10-01`,
      );

      const isConnected = response.status === 200;

      await this.tokenManager.updateConnectionStatus(
        userId,
        this.platform,
        isConnected ? ConnectionStatus.CONNECTED : ConnectionStatus.ERROR,
      );

      return isConnected;
    } catch (error) {
      this.logger.error(
        `PowerApps connection test failed: ${error.message}`,
        error.stack,
      );

      await this.tokenManager.updateConnectionStatus(
        userId,
        this.platform,
        ConnectionStatus.ERROR,
        error.message,
      );

      return false;
    }
  }

  /**
   * Disconnect and revoke tokens
   */
  async disconnect(userId: string, organizationId: string): Promise<void> {
    this.logger.log(`Disconnecting PowerApps for user ${userId}`);

    try {
      const token = await this.tokenManager.getToken(userId, this.platform);

      if (token) {
        // Revoke token at Microsoft
        const revokeUrl = 'https://login.microsoftonline.com/common/oauth2/v2.0/logout';
        await this.oauthService.revokeToken(
          revokeUrl,
          token.accessToken,
          this.oauth2Config,
        );
      }

      // Delete from database
      await this.tokenManager.deleteToken(userId, this.platform);

      this.logger.log(`PowerApps disconnected for user ${userId}`);
    } catch (error) {
      this.logger.error(
        `Failed to disconnect PowerApps: ${error.message}`,
        error.stack,
      );
      throw error;
    }
  }

  /**
   * Get connection status
   */
  async getConnectionStatus(
    userId: string,
    organizationId: string,
  ): Promise<ConnectionStatus> {
    const token = await this.tokenManager.getToken(userId, this.platform);

    if (!token) {
      return ConnectionStatus.DISCONNECTED;
    }

    const isExpired = await this.tokenManager.isTokenExpired(
      userId,
      this.platform,
    );

    if (isExpired) {
      return ConnectionStatus.EXPIRED;
    }

    // Test actual connectivity
    const isConnected = await this.testConnection(userId, organizationId);
    return isConnected ? ConnectionStatus.CONNECTED : ConnectionStatus.ERROR;
  }

  /**
   * List PowerApps environments
   */
  async listEnvironments(
    userId: string,
    organizationId: string,
  ): Promise<PowerAppsEnvironment[]> {
    try {
      this.logger.log(`Fetching PowerApps environments for user ${userId}`);

      const client = await this.getAuthenticatedClient(
        userId,
        organizationId,
      );

      const response = await client.get<{ value: PowerAppsEnvironment[] }>(
        `${this.bapApiUrl}/environments?api-version=2020-10-01`,
      );

      return response.data.value || [];
    } catch (error) {
      this.logger.error(
        `Failed to fetch PowerApps environments: ${error.message}`,
        error.stack,
      );
      throw new BadRequestException(
        `Failed to fetch environments: ${error.message}`,
      );
    }
  }

  /**
   * List PowerApps applications in an environment
   */
  async listApps(
    userId: string,
    organizationId: string,
    environmentId?: string,
  ): Promise<PowerAppsApp[]> {
    try {
      this.logger.log(`Fetching PowerApps for user ${userId}`);

      const client = await this.getAuthenticatedClient(
        userId,
        organizationId,
      );

      let url: string;

      if (environmentId) {
        // Get apps for specific environment
        url = `${this.powerAppsApiUrl}/apps?api-version=2016-11-01&$filter=environment eq '${environmentId}'`;
      } else {
        // Get all apps across all environments
        url = `${this.powerAppsApiUrl}/apps?api-version=2016-11-01`;
      }

      const response = await client.get<{ value: PowerAppsApp[] }>(url);

      return response.data.value || [];
    } catch (error) {
      this.logger.error(
        `Failed to fetch PowerApps: ${error.message}`,
        error.stack,
      );
      throw new BadRequestException(`Failed to fetch apps: ${error.message}`);
    }
  }

  /**
   * Get specific PowerApp details
   */
  async getApp(
    userId: string,
    organizationId: string,
    appId: string,
  ): Promise<PowerAppsApp> {
    try {
      this.logger.log(`Fetching PowerApp ${appId} for user ${userId}`);

      const client = await this.getAuthenticatedClient(
        userId,
        organizationId,
      );

      const response = await client.get<PowerAppsApp>(
        `${this.powerAppsApiUrl}/apps/${appId}?api-version=2016-11-01`,
      );

      return response.data;
    } catch (error) {
      this.logger.error(
        `Failed to fetch PowerApp: ${error.message}`,
        error.stack,
      );
      throw new BadRequestException(
        `Failed to fetch app details: ${error.message}`,
      );
    }
  }

  /**
   * Sync PowerApp to LDV-Bridge database
   * This will be integrated with sync service in Task 9
   */
  async syncApp(
    userId: string,
    organizationId: string,
    appId: string,
  ): Promise<ISyncResult> {
    try {
      this.logger.log(`Syncing PowerApp ${appId} for user ${userId}`);

      // Get app details from PowerApps
      const appDetails = await this.getApp(userId, organizationId, appId);

      // TODO: Task 9 - Integrate with sync service
      // TODO: Task 10 - Extract and store components
      // TODO: Task 11 - Detect changes

      // Placeholder response
      return {
        success: true,
        appId,
        componentsCount: 0,
        changesDetected: 0,
        syncedAt: new Date(),
      };
    } catch (error) {
      this.logger.error(`Failed to sync PowerApp: ${error.message}`, error.stack);

      return {
        success: false,
        appId,
        componentsCount: 0,
        changesDetected: 0,
        syncedAt: new Date(),
        errors: [error.message],
      };
    }
  }

  /**
   * Export PowerApp (download .msapp file)
   * This will download the app package for analysis
   */
  async exportApp(
    userId: string,
    organizationId: string,
    appId: string,
  ): Promise<Buffer> {
    try {
      this.logger.log(`Exporting PowerApp ${appId} for user ${userId}`);

      const client = await this.getAuthenticatedClient(
        userId,
        organizationId,
      );

      // Request app export
      const exportResponse = await client.post(
        `${this.powerAppsApiUrl}/apps/${appId}/exportPackage?api-version=2016-11-01`,
        {},
      );

      const packageLink = exportResponse.data?.packageLink?.value;

      if (!packageLink) {
        throw new BadRequestException('Failed to get app export link');
      }

      // Download the package
      const downloadResponse = await axios.get(packageLink, {
        responseType: 'arraybuffer',
      });

      return Buffer.from(downloadResponse.data);
    } catch (error) {
      this.logger.error(
        `Failed to export PowerApp: ${error.message}`,
        error.stack,
      );
      throw new BadRequestException(
        `Failed to export app: ${error.message}`,
      );
    }
  }
}

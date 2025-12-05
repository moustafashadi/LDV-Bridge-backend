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
import { AppStatus } from '@prisma/client';
import { AppsService } from '../../apps/apps.service';

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
    private appsService: AppsService,
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

      // Get the connector for this user
      const connections = await this.tokenManager['prisma'].platformConnector.findMany({
        where: {
          organizationId,
          platform: 'POWERAPPS',
          isActive: true,
        },
        take: 1,
      });
      
      const connection = connections[0];
      if (!connection) {
        throw new BadRequestException('No active PowerApps connection found');
      }

      // Create or update app in database
      const existingApp = await this.appsService['prisma'].app.findUnique({
        where: {
          organizationId_externalId_platform: {
            organizationId,
            externalId: appId,
            platform: 'POWERAPPS',
          },
        },
      });

      let app;
      if (existingApp) {
        // Update existing app
        app = await this.appsService['prisma'].app.update({
          where: { id: existingApp.id },
          data: {
            name: appDetails.properties.displayName,
            description: appDetails.properties.description,
            metadata: appDetails as any,
            lastSyncedAt: new Date(),
            status: AppStatus.LIVE,
          },
        });
        this.logger.log(`Updated existing app ${app.name} (${app.id})`);
      } else {
        // Create new app
        app = await this.appsService.createApp(userId, organizationId, {
          name: appDetails.properties.displayName,
          description: appDetails.properties.description,
          platform: 'POWERAPPS' as any,
          externalId: appId,
          connectorId: connection.id,
          status: AppStatus.LIVE as any,
          metadata: appDetails as any,
        });
        this.logger.log(`Created new app ${app.name} (${app.id})`);
      }

      return {
        success: true,
        appId: app.id,
        componentsCount: 0, // Will be populated by component extraction
        changesDetected: 0, // Will be populated by change detection
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

  /**
   * Copy/Clone a PowerApps app
   * Creates a copy of an existing app in a target environment
   * @param userId User ID
   * @param organizationId Organization ID
   * @param sourceAppId Source app ID to clone
   * @param targetEnvironmentId Target environment ID
   * @param newDisplayName Display name for the cloned app
   */
  async copyApp(
    userId: string,
    organizationId: string,
    sourceAppId: string,
    targetEnvironmentId: string,
    newDisplayName: string,
  ): Promise<{
    appId: string;
    name: string;
    displayName: string;
  }> {
    try {
      this.logger.log(
        `Copying PowerApp ${sourceAppId} to environment ${targetEnvironmentId}`,
      );

      const client = await this.getAuthenticatedClient(userId, organizationId);

      // Use PowerApps Copy API
      const response = await client.post(
        `${this.powerAppsApiUrl}/apps/${sourceAppId}?api-version=2016-11-01`,
        {
          targetEnvironmentName: targetEnvironmentId,
          displayName: newDisplayName,
        },
        {
          headers: {
            'Content-Type': 'application/json',
          },
        },
      );

      const copiedApp = response.data;

      this.logger.log(
        `Successfully copied app to ${copiedApp.name} in environment ${targetEnvironmentId}`,
      );

      return {
        appId: copiedApp.name,
        name: copiedApp.name,
        displayName: copiedApp.properties?.displayName || newDisplayName,
      };
    } catch (error) {
      this.logger.error(
        `Failed to copy PowerApp: ${error.message}`,
        error.stack,
      );
      throw new BadRequestException(
        `Failed to copy app: ${error.message}`,
      );
    }
  }

  // ==================== SANDBOX MANAGEMENT METHODS ====================

  /**
   * Create a new PowerApps Developer Environment
   * @param userId User ID
   * @param organizationId Organization ID
   * @param config Environment configuration
   */
  async createEnvironment(
    userId: string,
    organizationId: string,
    config: {
      name: string;
      description?: string;
      region?: string;
      type?: 'Developer' | 'Production' | 'Sandbox' | 'Trial';
      sourceAppId?: string; // Optional: Clone an existing app into this environment
    },
  ): Promise<{
    environmentId: string;
    environmentUrl: string;
    status: string;
    appId?: string; // If app was cloned, return the new app ID
    isCloned?: boolean;
  }> {
    try {
      this.logger.log(`Creating PowerApps environment: ${config.name}`);

      const client = await this.getAuthenticatedClient(userId, organizationId);

      // Create environment via BAP API
      const response = await client.post(
        `${this.bapApiUrl}/environments?api-version=2021-04-01`,
        {
          location: config.region || 'unitedstates',
          properties: {
            displayName: config.name,
            description: config.description || '',
            environmentSku: config.type || 'Developer',
            azureRegion: config.region || 'unitedstates',
          },
        },
      );

      const environment = response.data;
      const environmentId = environment.name;

      // If sourceAppId is provided, clone the app into the new environment
      let clonedAppId: string | undefined;
      let isCloned = false;

      if (config.sourceAppId) {
        this.logger.log(
          `Cloning app ${config.sourceAppId} into new environment ${environmentId}`,
        );

        // Auto-prefix the app name with "Sandbox - "
        const clonedAppName = config.name.startsWith('Sandbox - ')
          ? config.name
          : `Sandbox - ${config.name}`;

        try {
          const copiedApp = await this.copyApp(
            userId,
            organizationId,
            config.sourceAppId,
            environmentId,
            clonedAppName,
          );

          clonedAppId = copiedApp.appId;
          isCloned = true;

          this.logger.log(
            `Successfully cloned app ${config.sourceAppId} to ${clonedAppId}`,
          );
        } catch (error) {
          this.logger.error(
            `Failed to clone app into environment: ${error.message}`,
          );
          // Don't fail the entire provisioning - environment was created successfully
          // The clone failure will be logged and can be retried
        }
      }

      return {
        environmentId,
        environmentUrl: `https://admin.powerplatform.microsoft.com/environments/${environmentId}`,
        status: environment.properties?.provisioningState || 'Succeeded',
        appId: clonedAppId,
        isCloned,
      };
    } catch (error) {
      this.logger.error(`Failed to create environment: ${error.message}`, error.stack);
      throw new BadRequestException(`Failed to create environment: ${error.message}`);
    }
  }

  /**
   * Delete a PowerApps environment
   * @param userId User ID
   * @param organizationId Organization ID
   * @param environmentId Environment ID to delete
   */
  async deleteEnvironment(
    userId: string,
    organizationId: string,
    environmentId: string,
  ): Promise<void> {
    try {
      this.logger.log(`Deleting PowerApps environment: ${environmentId}`);

      const client = await this.getAuthenticatedClient(userId, organizationId);

      await client.delete(
        `${this.bapApiUrl}/environments/${environmentId}?api-version=2021-04-01`,
      );

      this.logger.log(`Environment ${environmentId} deleted successfully`);
    } catch (error) {
      this.logger.error(`Failed to delete environment: ${error.message}`, error.stack);
      throw new BadRequestException(`Failed to delete environment: ${error.message}`);
    }
  }

  /**
   * Get environment details
   * @param userId User ID
   * @param organizationId Organization ID
   * @param environmentId Environment ID
   */
  async getEnvironment(
    userId: string,
    organizationId: string,
    environmentId: string,
  ): Promise<PowerAppsEnvironment> {
    try {
      this.logger.log(`Getting PowerApps environment: ${environmentId}`);

      const client = await this.getAuthenticatedClient(userId, organizationId);

      const response = await client.get(
        `${this.bapApiUrl}/environments/${environmentId}?api-version=2021-04-01`,
      );

      return response.data;
    } catch (error) {
      this.logger.error(`Failed to get environment: ${error.message}`, error.stack);
      throw new BadRequestException(`Failed to get environment: ${error.message}`);
    }
  }

  /**
   * Get all apps in a specific environment
   * @param userId User ID
   * @param organizationId Organization ID
   * @param environmentId Environment ID to filter apps
   */
  async getAppsInEnvironment(
    userId: string,
    organizationId: string,
    environmentId: string,
  ): Promise<PowerAppsApp[]> {
    try {
      this.logger.log(`Getting apps in environment: ${environmentId}`);

      const client = await this.getAuthenticatedClient(userId, organizationId);

      const response = await client.get(
        `${this.powerAppsApiUrl}/apps?api-version=2016-11-01&$filter=environment eq '${environmentId}'`,
      );

      return response.data?.value || [];
    } catch (error) {
      this.logger.error(`Failed to get apps in environment: ${error.message}`, error.stack);
      throw new BadRequestException(`Failed to get apps: ${error.message}`);
    }
  }

  /**
   * Delete a PowerApp
   * @param userId User ID
   * @param organizationId Organization ID
   * @param appId App ID to delete
   */
  async deleteApp(
    userId: string,
    organizationId: string,
    appId: string,
  ): Promise<void> {
    try {
      this.logger.log(`Deleting PowerApp: ${appId}`);

      const client = await this.getAuthenticatedClient(userId, organizationId);

      await client.delete(
        `${this.powerAppsApiUrl}/apps/${appId}?api-version=2016-11-01`,
      );

      this.logger.log(`App ${appId} deleted successfully`);
    } catch (error) {
      this.logger.error(`Failed to delete app: ${error.message}`, error.stack);
      throw new BadRequestException(`Failed to delete app: ${error.message}`);
    }
  }

  /**
   * Get environment provisioning status
   * @param userId User ID
   * @param organizationId Organization ID
   * @param environmentId Environment ID
   */
  async getEnvironmentStatus(
    userId: string,
    organizationId: string,
    environmentId: string,
  ): Promise<'Succeeded' | 'Failed' | 'Provisioning' | 'Deleting'> {
    try {
      const environment = await this.getEnvironment(userId, organizationId, environmentId);
      return (environment.properties as any)?.provisioningState || 'Succeeded';
    } catch (error) {
      this.logger.error(`Failed to get environment status: ${error.message}`);
      throw new BadRequestException(`Failed to get status: ${error.message}`);
    }
  }

  /**
   * Get environment resource usage statistics
   * @param userId User ID
   * @param organizationId Organization ID
   * @param environmentId Environment ID
   */
  async getEnvironmentResourceUsage(
    userId: string,
    organizationId: string,
    environmentId: string,
  ): Promise<{
    appsCount: number;
    apiCallsUsed: number;
    storageUsed: number;
  }> {
    try {
      this.logger.log(`Getting resource usage for environment: ${environmentId}`);

      // Get apps count
      const apps = await this.getAppsInEnvironment(userId, organizationId, environmentId);

      // PowerApps doesn't provide direct API for storage/API calls via public APIs
      // Return apps count as the main metric
      return {
        appsCount: apps.length,
        apiCallsUsed: 0, // Not available via API
        storageUsed: 0, // Not available via API
      };
    } catch (error) {
      this.logger.error(`Failed to get resource usage: ${error.message}`, error.stack);
      throw new BadRequestException(`Failed to get resource usage: ${error.message}`);
    }
  }
}

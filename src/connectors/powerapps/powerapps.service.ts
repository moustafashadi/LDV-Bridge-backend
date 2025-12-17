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
  private readonly powerAppsApiUrl = 'https://api.powerplatform.com/powerapps';
  private readonly bapApiUrl =
    'https://api.bap.microsoft.com/providers/Microsoft.BusinessAppPlatform';

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
      authorizationUrl:
        'https://login.microsoftonline.com/common/oauth2/v2.0/authorize',
      tokenUrl: 'https://login.microsoftonline.com/common/oauth2/v2.0/token',
      clientId: this.config.get<string>('POWERAPP_CLIENT_ID') || '',
      clientSecret: this.config.get<string>('POWERAPP_CLIENT_SECRET') || '',
      redirectUri: this.config.get<string>('POWERAPP_REDIRECT_URI') || '',
      // Use the proper Dynamics CRM / Common Data Service scope
      // The BAP API accepts tokens from Dynamics CRM
      // Format: https://<tenant>.crm<region>.dynamics.com for specific tenant
      // Using generic CDS endpoint that works across regions
      // Requires:
      // 1. Dynamics CRM API permission (user_impersonation) - GRANTED ✅
      // 2. PowerApps Runtime Service API permission (user_impersonation) - GRANTED ✅
      // 3. Admin consent granted - DONE ✅
      // 4. User has appropriate Power Platform license
      scope: 'https://service.powerapps.com//.default offline_access',
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
   * Get BAP API token using refresh token
   */
  private async getBAPTokenFromRefreshToken(
    refreshToken: string,
  ): Promise<string | null> {
    try {
      this.logger.debug('Getting Power Platform API token using refresh token');

      const response = await axios.post(
        `https://login.microsoftonline.com/common/oauth2/v2.0/token`,
        new URLSearchParams({
          grant_type: 'refresh_token',
          client_id: this.oauth2Config.clientId,
          client_secret: this.oauth2Config.clientSecret,
          refresh_token: refreshToken,
          scope: 'https://service.powerapps.com//.default',
        }).toString(),
        {
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
          },
        },
      );

      this.logger.debug('Successfully got Power Platform API token');
      return response.data.access_token;
    } catch (error) {
      this.logger.error(
        `Power Platform API token request failed: ${error.response?.data?.error_description || error.message}`,
      );
      return null;
    }
  }

  /**
   * Exchange user token for BAP API token using On-Behalf-Of flow
   */
  private async exchangeForBAPToken(userToken: string): Promise<string> {
    try {
      this.logger.debug('Exchanging user token for Power Platform API token');

      const response = await axios.post(
        `https://login.microsoftonline.com/common/oauth2/v2.0/token`,
        new URLSearchParams({
          grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
          client_id: this.oauth2Config.clientId,
          client_secret: this.oauth2Config.clientSecret,
          assertion: userToken,
          scope: 'https://api.powerplatform.com/.default',
          requested_token_use: 'on_behalf_of',
        }).toString(),
        {
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
          },
        },
      );

      this.logger.debug(
        'Successfully exchanged token for Power Platform API access',
      );
      return response.data.access_token;
    } catch (error) {
      this.logger.error(
        `Token exchange failed: ${error.response?.data?.error_description || error.message}`,
      );
      // If exchange fails, return original token (might work for some APIs)
      return userToken;
    }
  }

  /**
   * Create authenticated axios instance
   */
  private async getAuthenticatedClient(
    userId: string,
    organizationId: string,
  ): Promise<AxiosInstance> {
    this.logger.debug(
      `[AUTH CLIENT] Step 1: Retrieving stored token for user ${userId}`,
    );
    const token = await this.tokenManager.getToken(userId, this.platform);

    if (!token) {
      this.logger.error(`[AUTH CLIENT] ❌ No token found for user ${userId}`);
      throw new BadRequestException(
        'No PowerApps connection found. Please connect first.',
      );
    }
    this.logger.debug(`[AUTH CLIENT] Step 1: ✓ Token retrieved`);

    // Log token details for debugging (without exposing the actual token)
    this.logger.log(`[TOKEN DEBUG] Token expiry: ${token.expiresAt}`);
    this.logger.log(`[TOKEN DEBUG] Has refresh token: ${!!token.refreshToken}`);

    // Decode token to check audience (for debugging)
    try {
      const tokenParts = token.accessToken.split('.');
      if (tokenParts.length === 3) {
        const payload = JSON.parse(
          Buffer.from(tokenParts[1], 'base64').toString(),
        );
        this.logger.log(`[TOKEN DEBUG] Token audience (aud): ${payload.aud}`);
        this.logger.log(
          `[TOKEN DEBUG] Token scopes (scp): ${payload.scp || 'none'}`,
        );
        this.logger.log(`[TOKEN DEBUG] Token issuer (iss): ${payload.iss}`);
      }
    } catch (e) {
      this.logger.warn(`[TOKEN DEBUG] Could not decode token: ${e.message}`);
    }

    // Check if token is expired and refresh if needed
    this.logger.debug(`[AUTH CLIENT] Step 2: Checking token expiration`);
    const isExpired = await this.tokenManager.isTokenExpired(
      userId,
      this.platform,
    );
    this.logger.debug(`[AUTH CLIENT] Step 2: Token expired: ${isExpired}`);

    if (isExpired && token.refreshToken) {
      this.logger.log(
        `[AUTH CLIENT] Step 3: Refreshing expired PowerApps token for user ${userId}`,
      );
      try {
        const newToken = await this.refreshToken(token.refreshToken);
        await this.tokenManager.saveToken(
          userId,
          organizationId,
          this.platform,
          newToken,
        );
        token.accessToken = newToken.accessToken;
        this.logger.log(`[AUTH CLIENT] Step 3: ✓ Token refreshed successfully`);
      } catch (error) {
        this.logger.error(
          `[AUTH CLIENT] ❌ Token refresh failed: ${error.message}`,
        );
        throw new BadRequestException(
          'Failed to refresh PowerApps token. Please reconnect your PowerApps account.',
        );
      }
    } else if (isExpired && !token.refreshToken) {
      this.logger.error(
        `[AUTH CLIENT] ❌ Token expired and no refresh token available`,
      );
      throw new BadRequestException(
        'PowerApps token expired and no refresh token available. Please reconnect your PowerApps account.',
      );
    }

    // Try to get Power Platform API token using refresh token
    this.logger.debug(`[AUTH CLIENT] Step 4: Getting Power Platform API token`);
    let bapToken: string | null = null;
    if (token.refreshToken) {
      this.logger.debug(
        `[AUTH CLIENT] Step 4a: Attempting Power Platform API token via refresh token`,
      );
      bapToken = await this.getBAPTokenFromRefreshToken(token.refreshToken);
      if (bapToken) {
        this.logger.debug(
          `[AUTH CLIENT] Step 4a: ✓ Power Platform API token obtained via refresh token`,
        );

        // Debug: Check the refreshed token's audience
        try {
          const tokenParts = bapToken.split('.');
          if (tokenParts.length === 3) {
            const payload = JSON.parse(
              Buffer.from(tokenParts[1], 'base64').toString(),
            );
            this.logger.log(
              `[REFRESHED TOKEN DEBUG] Token audience (aud): ${payload.aud}`,
            );
            this.logger.log(
              `[REFRESHED TOKEN DEBUG] Token scopes (scp): ${payload.scp}`,
            );
          }
        } catch (e) {
          // Ignore decode errors
        }
      }
    }

    // If refresh token approach failed, use the original token
    // The https://service.powerapps.com token works for api.powerplatform.com endpoints
    if (!bapToken) {
      this.logger.debug(
        `[AUTH CLIENT] Step 4b: Using original token (service.powerapps.com token works for Power Platform API)`,
      );
      bapToken = token.accessToken;
    }

    this.logger.debug(
      `[AUTH CLIENT] Step 5: Creating axios client with Power Platform API token`,
    );
    return axios.create({
      headers: {
        Authorization: `Bearer ${bapToken}`,
        'Content-Type': 'application/json',
      },
    });
  }

  /**
   * Initiate OAuth2 flow
   */
  async initiateOAuth(
    userId: string,
    organizationId: string,
    userRole?: string,
  ): Promise<string> {
    this.logger.log(
      `Initiating PowerApps OAuth for user ${userId} (role: ${userRole})`,
    );

    // Generate PKCE parameters
    const pkce = this.oauthService.generatePKCE();

    // Generate state
    const state = this.oauthService.generateState(
      userId,
      organizationId,
      userRole,
    );

    // Store code_verifier for later use during token exchange
    this.oauthService.storePKCEVerifier(state, pkce.codeVerifier);

    // Generate auth URL with PKCE parameters
    const authUrl = this.oauthService.generateAuthUrl(
      this.oauth2Config,
      state,
      {
        response_mode: 'query',
        prompt: 'select_account', // Allow user to choose account, may bypass admin consent
        domain_hint: 'organizations', // Hint that this is an organizational account
      },
      {
        codeChallenge: pkce.codeChallenge,
        codeChallengeMethod: pkce.codeChallengeMethod,
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
    const { userId, organizationId, userRole } =
      this.oauthService.parseState(state);

    // Retrieve PKCE code_verifier
    const codeVerifier = this.oauthService.retrievePKCEVerifier(state);

    if (!codeVerifier) {
      this.logger.warn(
        'No PKCE code_verifier found for state - continuing without PKCE',
      );
    }

    // Exchange code for token with PKCE code_verifier
    const token = await this.oauthService.exchangeCodeForToken(
      this.oauth2Config,
      code,
      undefined, // no additional params
      codeVerifier, // PKCE code_verifier
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

    this.logger.log(
      `PowerApps connection established for user ${userId} (role: ${userRole})`,
    );

    // Attach userRole to token for callback handler
    (token as any).userRole = userRole;

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

      const client = await this.getAuthenticatedClient(userId, organizationId);

      // First, try to validate token with Microsoft Graph /me endpoint
      // (works when app requested Graph scopes like User.Read)
      try {
        const graphResponse = await client.get(
          'https://graph.microsoft.com/v1.0/me',
        );
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
        this.logger.debug(
          'Graph /me token validation failed, falling back to BAP API',
        );
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
        const revokeUrl =
          'https://login.microsoftonline.com/common/oauth2/v2.0/logout';
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
      this.logger.debug(
        `[LIST ENVIRONMENTS] Starting for user ${userId}, org ${organizationId}`,
      );

      this.logger.debug(
        `[LIST ENVIRONMENTS] Step 1: Getting authenticated client`,
      );
      const client = await this.getAuthenticatedClient(userId, organizationId);
      this.logger.debug(`[LIST ENVIRONMENTS] Step 1: ✓ Client obtained`);

      const url = `${this.bapApiUrl}/environments?api-version=2020-10-01`;
      this.logger.debug(`[LIST ENVIRONMENTS] Step 2: Calling BAP API: ${url}`);

      const response = await client.get<{ value: PowerAppsEnvironment[] }>(url);

      this.logger.debug(
        `[LIST ENVIRONMENTS] Step 2: ✓ API responded with status ${response.status}`,
      );
      this.logger.debug(`[LIST ENVIRONMENTS] Step 3: Processing response data`);

      const environments = response.data.value || [];
      this.logger.log(
        `[LIST ENVIRONMENTS] Step 3: ✓ Found ${environments.length} environments`,
      );

      if (environments.length > 0) {
        this.logger.debug(
          `[LIST ENVIRONMENTS] First environment: ${JSON.stringify({
            name: environments[0].name,
            displayName: environments[0].properties?.displayName,
            id: environments[0].id,
            type: environments[0].type,
            location: environments[0].location,
          })}`,
        );
      } else {
        this.logger.warn(
          `[LIST ENVIRONMENTS] No environments returned from API`,
        );
      }

      return environments;
    } catch (error) {
      this.logger.error(
        `[LIST ENVIRONMENTS] ❌ Failed to fetch PowerApps environments: ${error.message}`,
        error.stack,
      );

      // Log detailed error information
      if (error.response) {
        this.logger.error(
          `[LIST ENVIRONMENTS] HTTP Status: ${error.response.status}`,
        );
        this.logger.error(
          `[LIST ENVIRONMENTS] Response Data: ${JSON.stringify(error.response.data)}`,
        );
      }

      if (error.response?.status === 401) {
        const errorData = error.response.data?.error;
        if (errorData?.code === 'InvalidAuthenticationAudience') {
          throw new BadRequestException(
            `Cannot list PowerApps environments. Your connection requires Power Platform API permissions. ` +
              `See Azure AD app configuration documentation for setup instructions.`,
          );
        }
      }

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

      const client = await this.getAuthenticatedClient(userId, organizationId);

      let url: string;

      if (environmentId) {
        // Get apps for specific environment using Power Apps Maker API (user-scoped, not admin)
        // This API works with the service.powerapps.com token
        const cleanEnvId = environmentId.replace(
          '/providers/Microsoft.BusinessAppPlatform/environments/',
          '',
        );
        // Use the Maker API which is accessible by regular users
        url = `https://api.powerapps.com/providers/Microsoft.PowerApps/apps?api-version=2016-11-01&$filter=environment eq '${cleanEnvId}'`;
        this.logger.debug(`[LIST APPS] Calling Power Apps Maker API: ${url}`);
        this.logger.debug(`[LIST APPS] Clean environment ID: ${cleanEnvId}`);
      } else {
        // Get all apps across all environments using Maker API
        url = `https://api.powerapps.com/providers/Microsoft.PowerApps/apps?api-version=2016-11-01`;
        this.logger.debug(
          `[LIST APPS] Calling Power Apps Maker API (all environments): ${url}`,
        );
      }

      this.logger.debug(`[LIST APPS] Making request to: ${url}`);
      const response = await client.get<{ value: PowerAppsApp[] }>(url);
      this.logger.debug(`[LIST APPS] Response status: ${response.status}`);

      const apps = response.data.value || [];
      this.logger.log(`[LIST APPS] Found ${apps.length} apps`);
      if (apps.length > 0) {
        this.logger.debug(
          `[LIST APPS] First app sample: ${JSON.stringify(apps[0])}`,
        );
      }

      return apps;
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

      const client = await this.getAuthenticatedClient(userId, organizationId);

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
      const connections = await this.tokenManager[
        'prisma'
      ].platformConnector.findMany({
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
      this.logger.error(
        `Failed to sync PowerApp: ${error.message}`,
        error.stack,
      );

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

      const client = await this.getAuthenticatedClient(userId, organizationId);

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
      throw new BadRequestException(`Failed to export app: ${error.message}`);
    }
  }

  /**
   * Create a new blank Canvas App
   * NOTE: Microsoft does not provide a direct REST API to create Canvas Apps from scratch.
   * This method uses a solution-based approach which is the only officially supported method.
   *
   * Architecture:
   * 1. We maintain a minimal template app in a solution
   * 2. Import that solution into the target environment
   * 3. Rename and rebind the app
   *
   * For now, this returns instructions for manual creation until we implement solution import.
   *
   * @param userId User ID
   * @param organizationId Organization ID
   * @param environmentId Environment ID where app will be created
   * @param appName Name for the new app
   */
  async createBlankApp(
    userId: string,
    organizationId: string,
    environmentId: string,
    appName: string,
  ): Promise<{
    message: string;
    studioUrl: string;
    instructions: string[];
  }> {
    try {
      this.logger.log(
        `Creating blank Canvas App "${appName}" in environment ${environmentId}`,
      );

      // Clean environment ID
      const cleanEnvId = environmentId.replace(
        '/providers/Microsoft.BusinessAppPlatform/environments/',
        '',
      );

      // For now, return instructions and link to Power Apps Studio
      // In the future, this will use solution import
      const studioUrl = `https://make.powerapps.com/environments/${cleanEnvId}/home`;

      return {
        message: `Canvas App creation initiated. Please follow the instructions to create your app in Power Apps Studio.`,
        studioUrl,
        instructions: [
          `1. Go to Power Apps Studio: ${studioUrl}`,
          `2. Click "Create" → "Blank canvas app"`,
          `3. Name your app: "${appName}"`,
          `4. Choose tablet or phone layout`,
          `5. Once created, sync it back to LDV-Bridge using the sync button`,
          '',
          'Note: Programmatic Canvas App creation requires solution-based deployment.',
          'We are working on implementing automated solution import/export for seamless app creation.',
        ],
      };
    } catch (error) {
      this.logger.error(
        `Failed to create blank app: ${error.message}`,
        error.stack,
      );
      throw new BadRequestException(
        `Failed to create blank app: ${error.message}`,
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
      throw new BadRequestException(`Failed to copy app: ${error.message}`);
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
      // Valid location/region values: unitedstates, europe, asia, australia, india, japan, canada, unitedkingdom, unitedstatesfirstrelease, southamerica, france, germany, switzerland, norway, korea, southafrica, uaenorth, singapore
      // Note: Use lowercase without spaces (e.g., 'unitedstates' not 'United States')
      const location = config.region || 'unitedstates';

      this.logger.log(
        `POST ${this.bapApiUrl}/environments?api-version=2021-04-01`,
      );
      this.logger.debug(
        `Request body: ${JSON.stringify({
          location: location,
          properties: {
            displayName: config.name,
            description: config.description || '',
            environmentSku: config.type || 'Developer',
          },
        })}`,
      );

      const response = await client.post(
        `${this.bapApiUrl}/environments?api-version=2021-04-01`,
        {
          location: location,
          properties: {
            displayName: config.name,
            description: config.description || '',
            environmentSku: config.type || 'Developer',
            // Don't specify azureRegion separately - it's inferred from location
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
        // Use make.powerapps.com (maker portal) for editing apps, not admin portal
        environmentUrl: `https://make.powerapps.com/environments/${environmentId}/home`,
        status: environment.properties?.provisioningState || 'Succeeded',
        appId: clonedAppId,
        isCloned,
      };
    } catch (error) {
      this.logger.error(
        `Failed to create environment: ${error.message}`,
        error.stack,
      );

      if (error.response) {
        this.logger.error(
          `HTTP Status: ${error.response.status} ${error.response.statusText}`,
        );
        this.logger.error(
          `Response data: ${JSON.stringify(error.response.data)}`,
        );

        if (error.response.status === 401) {
          const errorData = error.response.data?.error;
          const errorCode = errorData?.code;

          if (errorCode === 'InvalidAuthenticationAudience') {
            // Token has wrong audience (e.g., Microsoft Graph instead of Power Platform)
            throw new BadRequestException(
              `PowerApps environment creation requires Power Platform API permissions. ` +
                `Your connection is authenticated but cannot create environments. ` +
                `\n\nTo fix this:\n` +
                `1. Go to Azure Portal → Your App Registration → API permissions\n` +
                `2. Add "Dynamics CRM" or "Common Data Service" API\n` +
                `3. Add delegated permission: user_impersonation\n` +
                `4. Grant admin consent (requires Azure AD admin role)\n` +
                `5. Disconnect and reconnect your PowerApps account\n\n` +
                `Alternatively, you can work with existing PowerApps environments instead of creating new ones.`,
            );
          }

          throw new BadRequestException(
            `PowerApps authentication failed. Your token may have expired or lacks required permissions. ` +
              `Please disconnect and reconnect your PowerApps account. ` +
              `Required API permissions: Dynamics CRM user_impersonation (with admin consent)`,
          );
        }
      }

      throw new BadRequestException(
        `Failed to create environment: ${error.message}`,
      );
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
      this.logger.error(
        `Failed to delete environment: ${error.message}`,
        error.stack,
      );
      throw new BadRequestException(
        `Failed to delete environment: ${error.message}`,
      );
    }
  }

  /**
   * Get environment details
   * @param userId User ID
   * @param organizationId Organization ID
   * @param environmentId Environment ID (can be full resource path or just GUID)
   */
  async getEnvironment(
    userId: string,
    organizationId: string,
    environmentId: string,
  ): Promise<PowerAppsEnvironment> {
    try {
      // Extract just the GUID if a full resource path was provided
      // Format: /providers/Microsoft.BusinessAppPlatform/environments/{guid}
      const envIdMatch = environmentId.match(
        /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i,
      );
      const cleanEnvId = envIdMatch ? envIdMatch[1] : environmentId;

      this.logger.log(`Getting PowerApps environment: ${cleanEnvId}`);

      const client = await this.getAuthenticatedClient(userId, organizationId);

      const response = await client.get(
        `${this.bapApiUrl}/environments/${cleanEnvId}?api-version=2021-04-01`,
      );

      return response.data;
    } catch (error) {
      this.logger.error(
        `Failed to get environment: ${error.message}`,
        error.stack,
      );
      throw new BadRequestException(
        `Failed to get environment: ${error.message}`,
      );
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
      this.logger.error(
        `Failed to get apps in environment: ${error.message}`,
        error.stack,
      );
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
      const environment = await this.getEnvironment(
        userId,
        organizationId,
        environmentId,
      );
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
      this.logger.log(
        `Getting resource usage for environment: ${environmentId}`,
      );

      // Get apps count
      const apps = await this.getAppsInEnvironment(
        userId,
        organizationId,
        environmentId,
      );

      // PowerApps doesn't provide direct API for storage/API calls via public APIs
      // Return apps count as the main metric
      return {
        appsCount: apps.length,
        apiCallsUsed: 0, // Not available via API
        storageUsed: 0, // Not available via API
      };
    } catch (error) {
      this.logger.error(
        `Failed to get resource usage: ${error.message}`,
        error.stack,
      );
      throw new BadRequestException(
        `Failed to get resource usage: ${error.message}`,
      );
    }
  }
}

import {
  Injectable,
  Logger,
  BadRequestException,
  Inject,
  forwardRef,
} from '@nestjs/common';
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
import { GitHubService } from '../../github/github.service';
import { ChangesService } from '../../changes/changes.service';
import { NotificationsService } from '../../notifications/notifications.service';
import { PacCliService } from './pac-cli.service';

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
    private pacCliService: PacCliService,
    @Inject(forwardRef(() => GitHubService))
    private githubService: GitHubService,
    @Inject(forwardRef(() => ChangesService))
    private changesService: ChangesService,
    @Inject(forwardRef(() => NotificationsService))
    private notificationsService: NotificationsService,
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

      // Use the PowerApps Maker API (same as listApps) - this works with service.powerapps.com token
      const url = `https://api.powerapps.com/providers/Microsoft.PowerApps/apps/${appId}?api-version=2016-11-01`;
      this.logger.debug(`[GET APP] Calling PowerApps Maker API: ${url}`);

      const response = await client.get<PowerAppsApp>(url);

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
   * @param changeTitle - Optional user-provided title for this change (used for branch name)
   */
  async syncApp(
    userId: string,
    organizationId: string,
    appId: string,
    changeTitle?: string,
  ): Promise<ISyncResult> {
    try {
      this.logger.log(`Syncing PowerApp ${appId} for user ${userId}`);

      // Get app details from PowerApps
      const appDetails = await this.getApp(userId, organizationId, appId);

      // Get or create the connector for this organization
      let connection = await this.tokenManager[
        'prisma'
      ].platformConnector.findFirst({
        where: {
          organizationId,
          platform: 'POWERAPPS',
          isActive: true,
        },
      });

      // If no connector exists but user has a valid connection, create a default connector
      if (!connection) {
        const userConnection = await this.tokenManager.getToken(
          userId,
          this.platform,
        );
        if (userConnection) {
          this.logger.log(
            `Creating default PowerApps connector for organization ${organizationId}`,
          );
          connection = await this.tokenManager[
            'prisma'
          ].platformConnector.create({
            data: {
              organizationId,
              platform: 'POWERAPPS',
              name: 'PowerApps (Auto-created)',
              isActive: true,
              config: {},
            },
          });
        }
      }

      if (!connection) {
        throw new BadRequestException(
          'No active PowerApps connection found. Please connect PowerApps first.',
        );
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
      let isNewApp = false; // Track if this is a new app (for initial sync logic)

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
        isNewApp = true;
        app = await this.appsService.createApp(userId, organizationId, {
          name: appDetails.properties.displayName,
          description: appDetails.properties.description,
          platform: 'POWERAPPS' as any,
          externalId: appId,
          connectorId: connection.id,
          status: AppStatus.LIVE as any,
          metadata: appDetails as any,
        });

        // Set lastSyncedAt for the newly created app
        app = await this.appsService['prisma'].app.update({
          where: { id: app.id },
          data: {
            lastSyncedAt: new Date(),
          },
        });

        this.logger.log(`Created new app ${app.name} (${app.id})`);
      }

      // === GitHub Integration ===
      // Sync to GitHub if organization has GitHub connected
      // Declare variables at this scope so they're available for return
      let changeResult: any = null;
      let riskAssessment: any = null;
      let stagingBranch: string | undefined = undefined;

      try {
        const organization = await this.appsService[
          'prisma'
        ].organization.findUnique({
          where: { id: organizationId },
        });

        if (organization?.githubInstallationId) {
          this.logger.log(
            `[GITHUB] Organization has GitHub connected, syncing to repository...`,
          );

          // Create GitHub repo if it doesn't exist
          if (!app.githubRepoUrl) {
            this.logger.log(`[GITHUB] Creating repository for app ${app.name}`);
            const repo = await this.githubService.createAppRepository(app);

            // Update app with GitHub repo info
            app = await this.appsService['prisma'].app.update({
              where: { id: app.id },
              data: {
                githubRepoId: repo.node_id,
                githubRepoUrl: repo.html_url,
                githubRepoName: repo.name, // Use repo.name, not full_name (full_name includes org)
              },
            });
            this.logger.log(`[GITHUB] Created repository: ${repo.full_name}`);
          }

          // === CHANGE DETECTION AND RISK ANALYSIS ===
          // Detect changes in the app metadata
          try {
            this.logger.log(`[SYNC] Detecting changes for app ${app.id}...`);
            changeResult = await this.changesService.detectChanges(
              app.id,
              userId,
              organizationId,
            );

            if (changeResult.change) {
              // Run risk analysis synchronously
              this.logger.log(
                `[SYNC] Running risk analysis for change ${changeResult.change.id}...`,
              );
              riskAssessment =
                await this.changesService.analyzeChangeImpactSync(
                  changeResult.change.id,
                );

              if (riskAssessment) {
                this.logger.log(
                  `[SYNC] Risk level: ${riskAssessment.level}, score: ${riskAssessment.score}`,
                );
              }
            }
          } catch (changeError) {
            this.logger.warn(
              `[SYNC] Change detection failed: ${changeError.message}`,
            );
            // Continue with sync even if change detection fails
          }

          // Download and commit the msapp content to STAGING branch
          let stagingBranch: string | null = null;
          try {
            this.logger.log(
              `[GITHUB] Exporting msapp and committing to staging branch...`,
            );

            // Export the msapp file
            const msappBuffer = await this.exportApp(
              userId,
              organizationId,
              appId,
            );

            // Create a temp directory with the msapp content
            const os = require('os');
            const path = require('path');
            const fs = require('fs');

            const tempDir = path.join(
              os.tmpdir(),
              'ldvbridge',
              `app_${app.id}_${Date.now()}`,
            );
            await fs.promises.mkdir(tempDir, { recursive: true });

            // Write msapp and extract it
            const msappPath = path.join(tempDir, 'app.msapp');
            await fs.promises.writeFile(msappPath, msappBuffer);

            // Use unzipper to extract
            const unzipper = require('unzipper');
            const extractPath = path.join(tempDir, 'extracted');
            await fs.promises.mkdir(extractPath, { recursive: true });

            await fs
              .createReadStream(msappPath)
              .pipe(unzipper.Extract({ path: extractPath }))
              .promise();

            // Determine if this is the initial sync (new app, first time syncing)
            // If so, commit directly to main branch. Otherwise, use staging for review.
            // We use isNewApp flag instead of checking lastSyncedAt since we already set it above
            const isInitialSync = isNewApp;

            if (isInitialSync) {
              // Initial sync - commit directly to main branch (like Mendix)
              this.logger.log(
                `[GITHUB] Initial sync - committing directly to main branch`,
              );
              const commitResult = await this.githubService.commitAppSnapshot(
                app,
                extractPath,
                `Initial sync: ${app.name}`,
                undefined, // undefined branch = uses default (main)
              );
              this.logger.log(
                `[GITHUB] Successfully committed initial sync to main: ${commitResult.sha}`,
              );
            } else {
              // Subsequent sync - commit to STAGING branch for review
              // Use changeTitle from user, or generate default
              const titleForBranch =
                changeTitle || `sync-${new Date().toISOString().slice(0, 10)}`;
              const commitResult =
                await this.githubService.commitToStagingBranch(
                  app,
                  extractPath,
                  titleForBranch,
                  `Sync: ${app.name} - ${new Date().toISOString()}`,
                );
              stagingBranch = commitResult.branch;

              this.logger.log(
                `[GITHUB] Successfully committed to staging branch: ${stagingBranch}`,
              );
            }

            // Cleanup temp directory
            await fs.promises.rm(tempDir, { recursive: true, force: true });
          } catch (exportError) {
            this.logger.warn(
              `[GITHUB] Failed to export/commit msapp: ${exportError.message}`,
            );
            // Don't fail the sync if GitHub commit fails
          }

          // === NOTIFY PRO DEVELOPERS FOR HIGH RISK ===
          if (
            riskAssessment &&
            (riskAssessment.level === 'high' ||
              riskAssessment.level === 'critical')
          ) {
            try {
              this.logger.log(
                `[NOTIFY] Notifying pro developers of high-risk change`,
              );
              await this.notificationsService.notifyProDevelopers(
                organizationId,
                'HIGH_RISK_CHANGE_DETECTED',
                `High-risk change detected in ${app.name}`,
                {
                  changeId: changeResult?.change?.id,
                  appId: app.id,
                  appName: app.name,
                  riskLevel: riskAssessment.level,
                  riskScore: riskAssessment.score,
                  stagingBranch,
                },
              );
            } catch (notifyError) {
              this.logger.warn(
                `[NOTIFY] Failed to notify pro developers: ${notifyError.message}`,
              );
            }
          }
        } else {
          this.logger.debug(
            `[GITHUB] Organization does not have GitHub connected, skipping`,
          );
        }
      } catch (githubError) {
        this.logger.warn(`[GITHUB] GitHub sync failed: ${githubError.message}`);
        // Don't fail the main sync if GitHub sync fails
      }

      // Return enhanced sync result
      return {
        success: true,
        appId: app.id,
        componentsCount: 0,
        changesDetected: changeResult?.totalChanges || 0,
        changeId: changeResult?.change?.id,
        riskLevel: riskAssessment?.level,
        riskScore: riskAssessment?.score,
        requiresReview: true, // All changes require pro dev review
        stagingBranch: stagingBranch,
        syncedAt: new Date(),
        githubRepoUrl: app.githubRepoUrl,
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
   *
   * The msapp file URL is available in the app metadata from getApp response
   * at: properties.appUris.documentUri.value
   */
  async exportApp(
    userId: string,
    organizationId: string,
    appId: string,
  ): Promise<Buffer> {
    try {
      this.logger.log(`Exporting PowerApp ${appId} for user ${userId}`);

      // First, get the app details to find the documentUri
      const appDetails = (await this.getApp(
        userId,
        organizationId,
        appId,
      )) as any;

      const documentUri = appDetails?.properties?.appUris?.documentUri?.value;

      if (!documentUri) {
        throw new BadRequestException(
          'Failed to get app document URI. The app may not have been published yet.',
        );
      }

      this.logger.debug(
        `[EXPORT] Downloading msapp from: ${documentUri.substring(0, 100)}...`,
      );

      // Download the msapp file directly from the blob storage URL
      // This URL already contains SAS token authentication
      const downloadResponse = await axios.get(documentUri, {
        responseType: 'arraybuffer',
      });

      this.logger.log(
        `[EXPORT] Successfully downloaded msapp (${downloadResponse.data.byteLength} bytes)`,
      );

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
   * Copy/Clone a PowerApps app to another environment
   * Uses PAC CLI for proper canvas app export/import
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
    studioUrl?: string;
  }> {
    try {
      this.logger.log(
        `Copying PowerApp ${sourceAppId} to environment ${targetEnvironmentId}`,
      );

      // Step 1: Get source app details
      this.logger.log(`Step 1: Getting source app ${sourceAppId} details...`);
      const appDetails = (await this.getApp(
        userId,
        organizationId,
        sourceAppId,
      )) as any;

      const sourceDisplayName = appDetails.properties?.displayName || 'App';
      const sourceEnvironmentId =
        appDetails.properties?.environment?.name ||
        appDetails.properties?.environment?.id?.split('/').pop();

      this.logger.log(
        `Source app: ${sourceDisplayName} in environment ${sourceEnvironmentId}`,
      );

      // Step 2: Try solution-based copy using Dataverse API + PAC CLI
      let pacCliAvailable = false;
      try {
        pacCliAvailable = await this.pacCliService.isAvailable();
      } catch (error) {
        this.logger.warn(`PAC CLI check failed: ${error.message}`);
      }

      if (pacCliAvailable) {
        this.logger.log(
          'Attempting solution-based copy with Dataverse API + PAC CLI',
        );

        // Get Dataverse URL for source environment
        const sourceDataverseUrl = await this.getEnvironmentDataverseUrl(
          userId,
          organizationId,
          sourceEnvironmentId,
        );

        if (sourceDataverseUrl) {
          const solutionName = `LDVBridge_Copy_${Date.now()}`;

          try {
            // Step 2a: Create publisher (or get existing)
            this.logger.log(
              'Step 2a: Getting/creating publisher in Dataverse...',
            );
            const publisher = await this.getOrCreatePublisher(
              userId,
              organizationId,
              sourceDataverseUrl,
            );

            // Step 2b: Create solution in Dataverse
            this.logger.log(
              `Step 2b: Creating solution ${solutionName} in Dataverse...`,
            );
            const solution = await this.createSolutionInDataverse(
              userId,
              organizationId,
              sourceDataverseUrl,
              solutionName,
              publisher.publisherId,
            );

            // Step 2c: Add canvas app to solution
            this.logger.log(
              `Step 2c: Adding canvas app ${sourceAppId} to solution...`,
            );
            await this.addComponentToSolutionViaDataverse(
              userId,
              organizationId,
              sourceDataverseUrl,
              solution.uniqueName,
              sourceAppId,
            );

            // Step 2d: Use PAC CLI to export the solution and import to target
            this.logger.log(
              'Step 2d: Using PAC CLI to export and import solution...',
            );
            const result = await this.pacCliService.exportAndImportSolution(
              solutionName,
              sourceEnvironmentId,
              targetEnvironmentId,
              newDisplayName,
            );

            // Step 2e: Cleanup - delete temporary solution from source
            this.logger.log('Step 2e: Cleaning up temporary solution...');
            await this.deleteSolutionFromDataverse(
              userId,
              organizationId,
              sourceDataverseUrl,
              solutionName,
            );

            return result;
          } catch (solutionError) {
            this.logger.warn(
              `Solution-based copy failed: ${solutionError.message}, falling back to REST API`,
            );
            // Cleanup on failure
            try {
              await this.deleteSolutionFromDataverse(
                userId,
                organizationId,
                sourceDataverseUrl,
                solutionName,
              );
            } catch {
              // Ignore cleanup errors
            }
          }
        } else {
          this.logger.warn(
            'Source environment has no Dataverse, using REST API approach',
          );
        }
      } else {
        this.logger.log('PAC CLI not available, using REST API approach');
      }

      // Step 3: Fallback - Download .msapp via documentUri and create new app
      this.logger.log('Step 3: Downloading source app .msapp...');

      const documentUri = appDetails?.properties?.appUris?.documentUri?.value;
      if (!documentUri) {
        throw new BadRequestException(
          'Cannot copy app: source app has no documentUri. It may not be published.',
        );
      }

      // Download the .msapp
      const downloadResponse = await axios.get(documentUri, {
        responseType: 'arraybuffer',
      });
      const msappBuffer = Buffer.from(downloadResponse.data);
      this.logger.log(`Downloaded .msapp: ${msappBuffer.length} bytes`);

      // Step 4: Since REST API can't import .msapp, we create a placeholder app
      // and store the .msapp for manual import or future PAC CLI integration
      this.logger.log('Step 4: Creating canvas app in target environment...');

      const canvasAppsApiUrl =
        'https://api.powerapps.com/providers/Microsoft.PowerApps';
      const client = await this.getAuthenticatedClient(userId, organizationId);

      const createResponse = await client.post(
        `${canvasAppsApiUrl}/apps?api-version=2016-11-01`,
        {
          properties: {
            displayName: newDisplayName,
            description: `Feature sandbox for ${sourceDisplayName}. Note: This is a new app - source app content requires PAC CLI to copy.`,
            environment: {
              id: `/providers/Microsoft.BusinessAppPlatform/environments/${targetEnvironmentId}`,
              name: targetEnvironmentId,
            },
          },
        },
      );

      const newApp = createResponse.data;
      const newAppId = newApp.name || newApp.id;

      if (!newAppId) {
        throw new Error('Failed to create new app in target environment');
      }

      this.logger.log(
        `Created app ${newAppId} in environment ${targetEnvironmentId}`,
      );

      const studioUrl = `https://make.powerapps.com/e/${targetEnvironmentId}/canvas?action=edit&app-id=/providers/Microsoft.PowerApps/apps/${newAppId}`;

      return {
        appId: newAppId,
        name: newAppId,
        displayName: newDisplayName,
        studioUrl,
      };
    } catch (error) {
      this.logger.error(
        `Failed to copy PowerApp: ${error.message}`,
        error.response?.data || error.stack,
      );

      if (error.response) {
        this.logger.error(`Response status: ${error.response.status}`);
        this.logger.error(
          `Response data: ${JSON.stringify(error.response.data)}`,
        );
      }

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

      // Step 2: Provision Dataverse database in the new environment
      // This is required for solution-based operations
      this.logger.log(
        `Provisioning Dataverse database in environment ${environmentId}...`,
      );
      try {
        await this.provisionDataverseDatabase(
          client,
          environmentId,
          config.name,
        );
        this.logger.log(`Dataverse database provisioned successfully`);
      } catch (dbError) {
        this.logger.error(
          `Failed to provision Dataverse database: ${dbError.message}`,
        );
        // Continue without Dataverse - fallback to REST API will handle app copying
      }

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

  // ==================== Dataverse Web API Methods ====================

  /**
   * Get an access token for Dataverse API using refresh token
   * @param environmentUrl - The Dataverse environment URL (e.g., https://org123.crm.dynamics.com)
   */
  private async getDataverseToken(
    refreshToken: string,
    environmentUrl: string,
  ): Promise<string> {
    try {
      // Remove trailing slash if present
      const cleanUrl = environmentUrl.replace(/\/$/, '');
      const scope = `${cleanUrl}/.default`;

      this.logger.debug(`Getting Dataverse token for scope: ${scope}`);

      const response = await axios.post(
        `https://login.microsoftonline.com/common/oauth2/v2.0/token`,
        new URLSearchParams({
          grant_type: 'refresh_token',
          client_id: this.oauth2Config.clientId,
          client_secret: this.oauth2Config.clientSecret,
          refresh_token: refreshToken,
          scope: scope,
        }).toString(),
        {
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
          },
        },
      );

      this.logger.debug('Successfully obtained Dataverse token');
      return response.data.access_token;
    } catch (error) {
      this.logger.error(
        `Dataverse token request failed: ${error.response?.data?.error_description || error.message}`,
      );
      throw new BadRequestException(
        `Failed to get Dataverse token: ${error.response?.data?.error_description || error.message}`,
      );
    }
  }

  /**
   * Create an authenticated axios client for Dataverse API
   */
  private async getDataverseClient(
    userId: string,
    organizationId: string,
    environmentUrl: string,
  ): Promise<AxiosInstance> {
    const token = await this.tokenManager.getToken(userId, this.platform);

    if (!token?.refreshToken) {
      throw new BadRequestException(
        'No refresh token available. Please reconnect your PowerApps account.',
      );
    }

    const dataverseToken = await this.getDataverseToken(
      token.refreshToken,
      environmentUrl,
    );

    const cleanUrl = environmentUrl.replace(/\/$/, '');

    return axios.create({
      baseURL: `${cleanUrl}/api/data/v9.2`,
      headers: {
        Authorization: `Bearer ${dataverseToken}`,
        'Content-Type': 'application/json',
        'OData-MaxVersion': '4.0',
        'OData-Version': '4.0',
        Accept: 'application/json',
        Prefer: 'return=representation',
      },
    });
  }

  /**
   * Get the Dataverse URL for an environment
   * The URL is in the environment metadata properties
   */
  async getEnvironmentDataverseUrl(
    userId: string,
    organizationId: string,
    environmentId: string,
  ): Promise<string | null> {
    try {
      const client = await this.getAuthenticatedClient(userId, organizationId);
      const response = await client.get(
        `https://api.bap.microsoft.com/providers/Microsoft.BusinessAppPlatform/environments/${environmentId}?api-version=2021-04-01`,
      );

      // The Dataverse URL is typically in properties.linkedEnvironmentMetadata.instanceUrl
      const instanceUrl =
        response.data?.properties?.linkedEnvironmentMetadata?.instanceUrl;

      if (instanceUrl) {
        this.logger.debug(
          `Found Dataverse URL for environment ${environmentId}: ${instanceUrl}`,
        );
        return instanceUrl;
      }

      this.logger.warn(
        `No Dataverse URL found for environment ${environmentId}`,
      );
      return null;
    } catch (error) {
      this.logger.error(`Failed to get Dataverse URL: ${error.message}`);
      return null;
    }
  }

  /**
   * Get or create a publisher in Dataverse
   * Publishers are required for creating solutions
   */
  async getOrCreatePublisher(
    userId: string,
    organizationId: string,
    dataverseUrl: string,
    publisherName = 'LDVBridge',
    publisherPrefix = 'ldv',
  ): Promise<{ publisherId: string; uniqueName: string }> {
    const client = await this.getDataverseClient(
      userId,
      organizationId,
      dataverseUrl,
    );

    try {
      // Try to find existing publisher
      this.logger.debug(`Looking for existing publisher: ${publisherName}`);
      const searchResponse = await client.get(
        `/publishers?$filter=uniquename eq '${publisherName.toLowerCase()}'`,
      );

      if (searchResponse.data.value && searchResponse.data.value.length > 0) {
        const existing = searchResponse.data.value[0];
        this.logger.log(`Found existing publisher: ${existing.publisherid}`);
        return {
          publisherId: existing.publisherid,
          uniqueName: existing.uniquename,
        };
      }

      // Create new publisher
      this.logger.log(`Creating new publisher: ${publisherName}`);
      const createResponse = await client.post('/publishers', {
        uniquename: publisherName.toLowerCase(),
        friendlyname: 'LDV Bridge Publisher',
        customizationprefix: publisherPrefix,
        customizationoptionvalueprefix:
          10000 + Math.floor(Math.random() * 80000),
      });

      // Extract publisher ID from response
      const publisherId =
        createResponse.data.publisherid ||
        createResponse.headers['odata-entityid']?.match(/\(([^)]+)\)/)?.[1];

      this.logger.log(`Created publisher: ${publisherId}`);
      return {
        publisherId,
        uniqueName: publisherName.toLowerCase(),
      };
    } catch (error) {
      this.logger.error(
        `Failed to get/create publisher: ${error.response?.data?.error?.message || error.message}`,
      );
      throw new BadRequestException(
        `Failed to get/create publisher: ${error.response?.data?.error?.message || error.message}`,
      );
    }
  }

  /**
   * Create a solution in Dataverse using Web API
   */
  async createSolutionInDataverse(
    userId: string,
    organizationId: string,
    dataverseUrl: string,
    solutionName: string,
    publisherId: string,
    description = 'Temporary solution for LDV Bridge app copy',
  ): Promise<{ solutionId: string; uniqueName: string }> {
    const client = await this.getDataverseClient(
      userId,
      organizationId,
      dataverseUrl,
    );

    try {
      // Check if solution already exists
      const searchResponse = await client.get(
        `/solutions?$filter=uniquename eq '${solutionName}'`,
      );

      if (searchResponse.data.value && searchResponse.data.value.length > 0) {
        const existing = searchResponse.data.value[0];
        this.logger.log(
          `Solution ${solutionName} already exists: ${existing.solutionid}`,
        );
        return {
          solutionId: existing.solutionid,
          uniqueName: existing.uniquename,
        };
      }

      // Create new solution
      this.logger.log(`Creating solution in Dataverse: ${solutionName}`);
      const createResponse = await client.post('/solutions', {
        uniquename: solutionName,
        friendlyname: solutionName,
        description: description,
        version: '1.0.0.0',
        'publisherid@odata.bind': `/publishers(${publisherId})`,
      });

      // Extract solution ID from response
      const solutionId =
        createResponse.data.solutionid ||
        createResponse.headers['odata-entityid']?.match(/\(([^)]+)\)/)?.[1];

      this.logger.log(`Created solution in Dataverse: ${solutionId}`);
      return {
        solutionId,
        uniqueName: solutionName,
      };
    } catch (error) {
      this.logger.error(
        `Failed to create solution: ${error.response?.data?.error?.message || error.message}`,
      );
      throw new BadRequestException(
        `Failed to create solution in Dataverse: ${error.response?.data?.error?.message || error.message}`,
      );
    }
  }

  /**
   * Add a canvas app component to a solution using Dataverse Web API
   * Uses the AddSolutionComponent action
   */
  async addComponentToSolutionViaDataverse(
    userId: string,
    organizationId: string,
    dataverseUrl: string,
    solutionUniqueName: string,
    canvasAppId: string,
  ): Promise<void> {
    const client = await this.getDataverseClient(
      userId,
      organizationId,
      dataverseUrl,
    );

    try {
      // First, we need to find the Dataverse canvasapp entity ID
      // The PowerApps app ID (e.g., 0a46ced0-df35-4c11-889f-95a5ccbf1234) is stored in the canvasappid field
      // or sometimes matched by name. Let's query the canvasapp table.
      this.logger.log(`Looking up canvas app ${canvasAppId} in Dataverse...`);

      // Try to find by canvasappid (the PowerApps app GUID)
      let canvasAppEntityId: string | null = null;

      // The canvasapp table uses 'canvasappid' as the primary key
      // But we might need to search by the 'name' field which contains the PowerApps app ID
      try {
        // First try: Query canvasapps table directly with the ID
        const searchByIdResponse = await client.get(
          `/canvasapps?$filter=name eq '${canvasAppId}'&$select=canvasappid,name,displayname`,
        );

        if (
          searchByIdResponse.data.value &&
          searchByIdResponse.data.value.length > 0
        ) {
          canvasAppEntityId = searchByIdResponse.data.value[0].canvasappid;
          this.logger.log(`Found canvas app entity ID: ${canvasAppEntityId}`);
        }
      } catch (searchError) {
        this.logger.debug(`Search by name failed: ${searchError.message}`);
      }

      // If not found, try searching by canvasappid directly
      if (!canvasAppEntityId) {
        try {
          const directSearch = await client.get(`/canvasapps(${canvasAppId})`);
          canvasAppEntityId = directSearch.data.canvasappid;
          this.logger.log(`Found canvas app directly: ${canvasAppEntityId}`);
        } catch (directError) {
          this.logger.debug(`Direct lookup failed: ${directError.message}`);
        }
      }

      // If still not found, try listing all canvas apps to find it
      if (!canvasAppEntityId) {
        try {
          const listResponse = await client.get(
            `/canvasapps?$select=canvasappid,name,displayname&$top=100`,
          );

          this.logger.debug(
            `Found ${listResponse.data.value?.length || 0} canvas apps in environment`,
          );

          const matchingApp = listResponse.data.value?.find(
            (app: any) =>
              app.name === canvasAppId ||
              app.canvasappid === canvasAppId ||
              app.name?.includes(canvasAppId),
          );

          if (matchingApp) {
            canvasAppEntityId = matchingApp.canvasappid;
            this.logger.log(
              `Found matching canvas app: ${canvasAppEntityId} (${matchingApp.displayname})`,
            );
          }
        } catch (listError) {
          this.logger.debug(`List canvas apps failed: ${listError.message}`);
        }
      }

      if (!canvasAppEntityId) {
        throw new Error(
          `Canvas app ${canvasAppId} not found in Dataverse. The app may not be saved to the environment yet.`,
        );
      }

      // AddSolutionComponent action
      // Component type 300 = Canvas App
      // See: https://learn.microsoft.com/en-us/power-apps/developer/data-platform/webapi/reference/addsolutioncomponent
      this.logger.log(
        `Adding canvas app ${canvasAppEntityId} to solution ${solutionUniqueName}`,
      );

      await client.post('/AddSolutionComponent', {
        ComponentId: canvasAppEntityId,
        ComponentType: 300, // Canvas App
        SolutionUniqueName: solutionUniqueName,
        AddRequiredComponents: false,
        DoNotIncludeSubcomponents: false,
        IncludedComponentSettingsValues: null,
      });

      this.logger.log(`Added canvas app to solution: ${solutionUniqueName}`);
    } catch (error) {
      this.logger.error(
        `Failed to add component to solution: ${error.response?.data?.error?.message || error.message}`,
      );
      throw new BadRequestException(
        `Failed to add canvas app to solution: ${error.response?.data?.error?.message || error.message}`,
      );
    }
  }

  /**
   * Delete a solution from Dataverse
   */
  async deleteSolutionFromDataverse(
    userId: string,
    organizationId: string,
    dataverseUrl: string,
    solutionUniqueName: string,
  ): Promise<void> {
    const client = await this.getDataverseClient(
      userId,
      organizationId,
      dataverseUrl,
    );

    try {
      // Find the solution by unique name
      const searchResponse = await client.get(
        `/solutions?$filter=uniquename eq '${solutionUniqueName}'&$select=solutionid`,
      );

      if (searchResponse.data.value && searchResponse.data.value.length > 0) {
        const solutionId = searchResponse.data.value[0].solutionid;
        await client.delete(`/solutions(${solutionId})`);
        this.logger.log(
          `Deleted solution from Dataverse: ${solutionUniqueName}`,
        );
      } else {
        this.logger.warn(
          `Solution not found for deletion: ${solutionUniqueName}`,
        );
      }
    } catch (error) {
      this.logger.warn(
        `Failed to delete solution: ${error.response?.data?.error?.message || error.message}`,
      );
      // Don't throw - cleanup errors are non-fatal
    }
  }

  /**
   * Provision a Dataverse database in an environment
   * This is required for solution-based operations
   * @param client Authenticated axios client
   * @param environmentId Environment ID to provision database in
   * @param displayName Display name for the database
   */
  private async provisionDataverseDatabase(
    client: any,
    environmentId: string,
    displayName: string,
  ): Promise<void> {
    // Provision CDS/Dataverse database using BAP API
    // API: POST /providers/Microsoft.BusinessAppPlatform/environments/{environmentId}/provisionInstance
    const provisionUrl = `${this.bapApiUrl}/environments/${environmentId}/provisionInstance?api-version=2021-04-01`;

    this.logger.log(`Provisioning Dataverse at: ${provisionUrl}`);

    const response = await client.post(provisionUrl, {
      baseLanguage: 1033, // English
      currency: {
        code: 'USD',
      },
      // Don't include templates for basic Dataverse - just create empty database
    });

    // Provisioning is async - we need to poll for completion
    // The response may contain an operation URL or we poll the environment status
    this.logger.log(
      `Dataverse provisioning initiated, waiting for completion...`,
    );

    // Poll for database readiness (max 5 minutes)
    const maxWaitTime = 5 * 60 * 1000; // 5 minutes
    const pollInterval = 10 * 1000; // 10 seconds
    const startTime = Date.now();

    while (Date.now() - startTime < maxWaitTime) {
      await new Promise((resolve) => setTimeout(resolve, pollInterval));

      try {
        // Check environment status
        const envResponse = await client.get(
          `${this.bapApiUrl}/environments/${environmentId}?api-version=2021-04-01`,
        );

        const linkedEnvMeta =
          envResponse.data?.properties?.linkedEnvironmentMetadata;
        const provisioningState =
          envResponse.data?.properties?.provisioningState;

        if (linkedEnvMeta?.instanceUrl) {
          this.logger.log(`Dataverse ready at: ${linkedEnvMeta.instanceUrl}`);
          return;
        }

        if (provisioningState === 'Failed') {
          throw new Error('Dataverse provisioning failed');
        }

        const elapsed = Math.round((Date.now() - startTime) / 1000);
        this.logger.debug(
          `Waiting for Dataverse... (${elapsed}s elapsed, state: ${provisioningState})`,
        );
      } catch (pollError) {
        if (pollError.message === 'Dataverse provisioning failed') {
          throw pollError;
        }
        this.logger.debug(`Poll error (will retry): ${pollError.message}`);
      }
    }

    throw new Error('Dataverse provisioning timed out after 5 minutes');
  }
}

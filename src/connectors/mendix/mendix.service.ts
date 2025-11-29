import { Injectable, Logger, BadRequestException, UnauthorizedException } from '@nestjs/common';
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
import { ConnectorsWebSocketGateway } from '../../websocket/websocket.gateway';
import { AppStatus } from '@prisma/client';
import { AppsService } from '../../apps/apps.service';

/**
 * Mendix Connector Service
 * Integrates with Mendix Platform API using Personal Access Token (PAT) authentication
 * 
 * MULTITENANCY FLOW:
 * 1. Each user obtains their own Mendix PAT from Mendix portal
 * 2. User calls POST /connectors/mendix/connect with their apiKey + username
 * 3. saveCredentials() validates and stores the user's PAT (encrypted) in database
 * 4. All subsequent API calls use getAuthenticatedClient() which retrieves 
 *    the user-specific token from database via tokenManager.getToken(userId)
 * 5. Each user's credentials are isolated by userId + platform in UserConnection table
 * 
 * ENV VARIABLES (MENDIX_API_KEY, MENDIX_USERNAME):
 * - NOT required for multitenancy
 * - NOT used in actual API calls
 * - Optional placeholders only
 * 
 * API Documentation: https://docs.mendix.com/apidocs-mxsdk/apidocs/
 */
@Injectable()
export class MendixService implements IBaseConnector {
  private readonly logger = new Logger(MendixService.name);
  private readonly platform = 'MENDIX';

  // Mendix API configuration
  private readonly mendixConfig: {
    apiUrl: string;
    deploymentsApiUrl: string;
    buildApiUrl: string;
  };

  constructor(
    private config: ConfigService,
    private tokenManager: TokenManagerService,
    private websocketGateway: ConnectorsWebSocketGateway,
    private appsService: AppsService,
  ) {
    // Initialize Mendix API URLs
    this.mendixConfig = {
      apiUrl: 'https://deploy.mendix.com/api/1',
      deploymentsApiUrl: 'https://deploy.mendix.com/api/v2',
      buildApiUrl: 'https://home.mendix.com/api/v2',
    };
    
    this.validateConfig();
  }

  /**
   * Validate configuration
   * NOTE: Env variables are NOT required for multitenancy.
   * Each user provides their own Mendix PAT via the /connect endpoint.
   * The env variables are only checked here for informational purposes.
   */
  private validateConfig(): void {
    const apiKey = this.config.get<string>('MENDIX_API_KEY');
    const username = this.config.get<string>('MENDIX_USERNAME');
    
    if (!apiKey || !username) {
      this.logger.log(
        'Mendix env credentials not set - this is normal. Users will provide their own PAT tokens.',
      );
    }
  }

  /**
   * Create authenticated axios instance
   * Note: Mendix uses Personal Access Token (PAT) in username field, password can be empty
   */
  private async getAuthenticatedClient(
    userId: string,
    organizationId: string,
  ): Promise<AxiosInstance> {
    const token = await this.tokenManager.getToken(userId, this.platform);

    if (!token) {
      throw new BadRequestException(
        'No Mendix connection found. Please connect first.',
      );
    }

    // Check if token is expired (for API keys, we check if connection is still valid)
    const isExpired = await this.tokenManager.isTokenExpired(
      userId,
      this.platform,
    );

    if (isExpired) {
      this.logger.warn(`Mendix connection may be expired for user ${userId}`);
      throw new UnauthorizedException('Mendix connection expired. Please reconnect.');
    }

    // Mendix uses API Key authentication with username and API key headers
    const client = axios.create({
      headers: {
        'Content-Type': 'application/json',
        'Mendix-Username': token.refreshToken, // Username stored in refreshToken field
        'Mendix-ApiKey': token.accessToken,    // API key stored in accessToken field
      },
    });

    // Add request interceptor for logging
    client.interceptors.request.use(
      (config) => {
        this.logger.debug(`Mendix API Request: ${config.method?.toUpperCase()} ${config.url}`);
        return config;
      },
      (error) => {
        this.logger.error('Mendix API Request Error:', error);
        return Promise.reject(error);
      },
    );

    // Add response interceptor for error handling
    client.interceptors.response.use(
      (response) => response,
      async (error) => {
        if (error.response?.status === 401) {
          this.logger.warn('Mendix API returned 401 - Invalid or expired PAT');
          await this.tokenManager.updateConnectionStatus(
            userId,
            this.platform,
            ConnectionStatus.ERROR,
          );
        }
        return Promise.reject(error);
      },
    );

    return client;
  }

  /**
   * Initiate "OAuth" flow (for Mendix, this is API key setup, not real OAuth)
   * Returns instructions for obtaining Mendix Personal Access Token
   */
  async initiateOAuth(userId: string, organizationId: string): Promise<string> {
    this.logger.log(`Initiating Mendix connection for user ${userId}`);

    // For Mendix, we don't have an OAuth flow
    // Return instructions URL for obtaining PAT
    return 'https://docs.mendix.com/developerportal/community-tools/mendix-profile/#pat';
  }

  /**
   * Complete "OAuth" flow (for Mendix, this saves the API key)
   * @param code - Personal Access Token
   * @param state - Encrypted state with userId and organizationId
   */
  async completeOAuth(apiKey: string, username: string): Promise<OAuth2Token> {
    this.logger.log('Completing Mendix connection setup');

    if (!apiKey || !username) {
      throw new BadRequestException('Mendix API key and username are required');
    }

    // Validate the API key by making a test request
    try {
      const client = axios.create({
        headers: {
          'Mendix-Username': username,
          'Mendix-ApiKey': apiKey,
        },
      });

      // Test the credentials by fetching user info
      await client.get(`${this.mendixConfig.apiUrl}/apps`);

      // Create a pseudo-OAuth token object
      // For Mendix, we store the API key as accessToken and username as metadata
      const token: OAuth2Token = {
        accessToken: apiKey,
        tokenType: 'ApiKey',
        expiresAt: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000), // 1 year expiry
        refreshToken: username, // Store username in refreshToken field
      };

      return token;
    } catch (error) {
      this.logger.error('Failed to validate Mendix credentials:', error.message);
      throw new UnauthorizedException('Invalid Mendix API key or username');
    }
  }

  /**
   * Refresh token (not applicable for API keys, but required by interface)
   */
  async refreshToken(refreshToken: string): Promise<OAuth2Token> {
    // Mendix PATs don't expire like OAuth tokens
    // We just return the existing token
    throw new BadRequestException('Mendix API keys do not support token refresh. Please provide a new API key.');
  }

  /**
   * Test connection by fetching user's apps
   */
  async testConnection(
    userId: string,
    organizationId: string,
  ): Promise<boolean> {
    this.logger.log(`Testing Mendix connection for user ${userId}`);

    try {
      const client = await this.getAuthenticatedClient(userId, organizationId);
      
      // Test by fetching apps
      const response = await client.get(`${this.mendixConfig.apiUrl}/apps`);
      
      if (response.status === 200) {
        await this.tokenManager.updateConnectionStatus(
          userId,
          this.platform,
          ConnectionStatus.CONNECTED,
        );

        return true;
      }

      return false;
    } catch (error) {
      this.logger.error('Mendix connection test failed:', error.message);
      
      await this.tokenManager.updateConnectionStatus(
        userId,
        this.platform,
        ConnectionStatus.ERROR,
      );

      return false;
    }
  }

  /**
   * Disconnect Mendix account
   */
  async disconnect(
    userId: string,
    organizationId: string,
  ): Promise<void> {
    this.logger.log(`Disconnecting Mendix for user ${userId}`);

    try {
      // Update status to disconnected
      await this.tokenManager.updateConnectionStatus(
        userId,
        this.platform,
        ConnectionStatus.DISCONNECTED,
      );

      this.logger.log('Mendix connection removed successfully');
    } catch (error) {
      this.logger.error('Failed to disconnect Mendix:', error.message);
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

    const isExpired = await this.tokenManager.isTokenExpired(userId, this.platform);
    
    if (isExpired) {
      return ConnectionStatus.EXPIRED;
    }

    return ConnectionStatus.CONNECTED;
  }

  /**
   * List all projects accessible to the user
   */
  async listProjects(
    userId: string,
    organizationId: string,
  ): Promise<any[]> {
    this.logger.log(`Fetching Mendix projects for user ${userId}`);

    try {
      const client = await this.getAuthenticatedClient(userId, organizationId);
      
      // Fetch apps (Mendix calls them "apps" in API)
      const response = await client.get(`${this.mendixConfig.apiUrl}/apps`);
      
      const projects = response.data || [];

      this.logger.log(`Found ${projects.length} Mendix projects`);

      return projects.map((project: any) => ({
        id: project.AppId || project.ProjectId,
        name: project.Name,
        description: project.Description || null,
        projectId: project.ProjectId,
        appId: project.AppId,
        url: project.Url,
      }));
    } catch (error) {
      this.logger.error('Failed to fetch Mendix projects:', error.message);
      throw new BadRequestException('Failed to fetch Mendix projects');
    }
  }

  /**
   * List all apps (same as projects in Mendix)
   */
  async listApps(
    userId: string,
    organizationId: string,
    projectId?: string,
  ): Promise<IPlatformApp[]> {
    this.logger.log(`Fetching Mendix apps for user ${userId}`);

    try {
      const client = await this.getAuthenticatedClient(userId, organizationId);
      
      let apps: any[] = [];

      if (projectId) {
        // Fetch specific project/app
        const response = await client.get(
          `${this.mendixConfig.apiUrl}/apps/${projectId}`,
        );
        apps = [response.data];
      } else {
        // Fetch all apps
        const response = await client.get(`${this.mendixConfig.apiUrl}/apps`);
        apps = response.data || [];
      }

      this.logger.log(`Found ${apps.length} Mendix apps`);

      return apps.map((app: any) => ({
        id: app.AppId || app.ProjectId,
        name: app.Name,
        description: app.Description || undefined,
        createdAt: new Date(), // Mendix API doesn't provide creation date
        modifiedAt: new Date(), // Mendix API doesn't provide modification date
        version: undefined,
        environment: undefined,
        metadata: {
          projectId: app.ProjectId,
          appId: app.AppId,
          url: app.Url,
        },
      }));
    } catch (error) {
      this.logger.error('Failed to fetch Mendix apps:', error.message);
      throw new BadRequestException('Failed to fetch Mendix apps');
    }
  }

  /**
   * Get specific app details
   */
  async getApp(
    userId: string,
    organizationId: string,
    appId: string,
  ): Promise<IPlatformApp> {
    this.logger.log(`Fetching Mendix app ${appId} for user ${userId}`);

    try {
      const client = await this.getAuthenticatedClient(userId, organizationId);
      
      // Get app details
      const appResponse = await client.get(
        `${this.mendixConfig.apiUrl}/apps/${appId}`,
      );

      const app = appResponse.data;

      // Get environments for this app
      let environments = [];
      try {
        const envResponse = await client.get(
          `${this.mendixConfig.apiUrl}/apps/${appId}/environments`,
        );
        environments = envResponse.data || [];
      } catch (error) {
        this.logger.warn(`Could not fetch environments for app ${appId}`);
      }

      return {
        id: app.AppId || app.ProjectId,
        name: app.Name,
        description: app.Description || undefined,
        createdAt: new Date(),
        modifiedAt: new Date(),
        version: undefined,
        environment: undefined,
        metadata: {
          projectId: app.ProjectId,
          appId: app.AppId,
          url: app.Url,
          environments: environments,
        },
      };
    } catch (error) {
      this.logger.error(`Failed to fetch Mendix app ${appId}:`, error.message);
      throw new BadRequestException(`Failed to fetch Mendix app: ${error.message}`);
    }
  }

  /**
   * Sync app to database (placeholder for Task 9)
   */
  async syncApp(
    userId: string,
    organizationId: string,
    appId: string,
  ): Promise<ISyncResult> {
    this.logger.log(`Syncing Mendix app ${appId} for user ${userId}`);

    try {
      // Get app details from Mendix
      const appDetails = await this.getApp(userId, organizationId, appId);

      // Get the connector for this organization
      const connections = await this.tokenManager['prisma'].platformConnector.findMany({
        where: {
          organizationId,
          platform: 'MENDIX',
          isActive: true,
        },
        take: 1,
      });
      
      const connection = connections[0];
      if (!connection) {
        throw new BadRequestException('No active Mendix connection found');
      }

      // Create or update app in database
      const existingApp = await this.appsService['prisma'].app.findUnique({
        where: {
          organizationId_externalId_platform: {
            organizationId,
            externalId: appId,
            platform: 'MENDIX',
          },
        },
      });

      let app;
      if (existingApp) {
        // Update existing app
        app = await this.appsService['prisma'].app.update({
          where: { id: existingApp.id },
          data: {
            name: appDetails.name,
            description: appDetails.description,
            metadata: appDetails as any,
            lastSyncedAt: new Date(),
            status: AppStatus.LIVE,
          },
        });
        this.logger.log(`Updated existing app ${app.name} (${app.id})`);
      } else {
        // Create new app
        app = await this.appsService.createApp(userId, organizationId, {
          name: appDetails.name,
          description: appDetails.description,
          platform: 'MENDIX' as any,
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
        componentsCount: 0,
        changesDetected: 0,
        syncedAt: new Date(),
      };
    } catch (error) {
      this.logger.error(`Failed to sync Mendix app ${appId}:`, error.message);
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
   * Export app package (download Team Server revision)
   * Note: Mendix Team Server uses SVN, so this would download a specific revision
   */
  async exportApp(
    userId: string,
    organizationId: string,
    appId: string,
    branchName?: string,
    revision?: number,
  ): Promise<Buffer> {
    this.logger.log(`Exporting Mendix app ${appId} for user ${userId}`);

    try {
      const client = await this.getAuthenticatedClient(userId, organizationId);

      // Get app details first
      const app = await this.getApp(userId, organizationId, appId);

      // Get Team Server info
      const teamServerResponse = await client.get(
        `${this.mendixConfig.apiUrl}/apps/${appId}/teamserver`,
      );

      const teamServer = teamServerResponse.data;

      if (!teamServer || !teamServer.url) {
        throw new BadRequestException('Team Server information not available for this app');
      }

      // In a real implementation, we would:
      // 1. Use SVN client to checkout/export the repository
      // 2. Create a ZIP archive
      // 3. Return the buffer
      
      // For now, return placeholder
      throw new BadRequestException(
        'Mendix app export requires SVN client integration. This will be implemented in a future version.',
      );
    } catch (error) {
      this.logger.error(`Failed to export Mendix app ${appId}:`, error.message);
      throw error;
    }
  }

  /**
   * Save Mendix API credentials
   */
  async saveCredentials(
    userId: string,
    organizationId: string,
    apiKey: string,
    username: string,
  ): Promise<void> {
    this.logger.log(`Saving Mendix credentials for user ${userId}`);

    // Validate credentials
    const token = await this.completeOAuth(apiKey, username);

    // Save token
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

    this.logger.log(`Mendix connection established for user ${userId}`);
  }

  // ==================== SANDBOX MANAGEMENT METHODS ====================

  /**
   * Create a new Mendix Free Sandbox
   * @param userId User ID
   * @param organizationId Organization ID
   * @param config Sandbox configuration
   */
  async createSandbox(
    userId: string,
    organizationId: string,
    config: {
      name: string;
      appId?: string;
      template?: string;
      mendixVersion?: string;
    },
  ): Promise<{
    environmentId: string;
    environmentUrl: string;
    status: string;
  }> {
    try {
      this.logger.log(`Creating Mendix sandbox: ${config.name}`);

      const client = await this.getAuthenticatedClient(userId, organizationId);

      // Create a new app (which includes a free sandbox environment)
      const response = await client.post(
        `${this.mendixConfig.buildApiUrl}/apps`,
        {
          name: config.name,
          projectId: config.appId || null,
          templateId: config.template || null,
          mendixVersion: config.mendixVersion || null,
        },
      );

      const app = response.data;

      // Get the default environment (sandbox)
      const envResponse = await client.get(
        `${this.mendixConfig.deploymentsApiUrl}/apps/${app.appId}/environments`,
      );

      const sandboxEnv = envResponse.data?.find((env: any) => env.type === 'Free');

      if (!sandboxEnv) {
        throw new BadRequestException('No sandbox environment found for app');
      }

      return {
        environmentId: sandboxEnv.environmentId,
        environmentUrl: sandboxEnv.url || '',
        status: sandboxEnv.status || 'Stopped',
      };
    } catch (error) {
      this.logger.error(`Failed to create sandbox: ${error.message}`, error.stack);
      throw new BadRequestException(`Failed to create sandbox: ${error.message}`);
    }
  }

  /**
   * Delete a Mendix sandbox
   * @param userId User ID
   * @param organizationId Organization ID
   * @param environmentId Environment ID to delete
   */
  async deleteSandbox(
    userId: string,
    organizationId: string,
    environmentId: string,
  ): Promise<void> {
    try {
      this.logger.log(`Deleting Mendix sandbox: ${environmentId}`);

      const client = await this.getAuthenticatedClient(userId, organizationId);

      // Stop the environment first
      try {
        await this.stopEnvironment(userId, organizationId, environmentId);
      } catch (error) {
        this.logger.warn(`Failed to stop environment before deletion: ${error.message}`);
      }

      // Delete the app (which includes the sandbox)
      const appId = await this.getAppIdFromEnvironment(userId, organizationId, environmentId);
      
      await client.delete(
        `${this.mendixConfig.buildApiUrl}/apps/${appId}`,
      );

      this.logger.log(`Sandbox ${environmentId} deleted successfully`);
    } catch (error) {
      this.logger.error(`Failed to delete sandbox: ${error.message}`, error.stack);
      throw new BadRequestException(`Failed to delete sandbox: ${error.message}`);
    }
  }

  /**
   * Start a Mendix environment
   * @param userId User ID
   * @param organizationId Organization ID
   * @param environmentId Environment ID
   */
  async startEnvironment(
    userId: string,
    organizationId: string,
    environmentId: string,
  ): Promise<void> {
    try {
      this.logger.log(`Starting Mendix environment: ${environmentId}`);

      const client = await this.getAuthenticatedClient(userId, organizationId);

      await client.post(
        `${this.mendixConfig.deploymentsApiUrl}/apps/${environmentId}/environments/start`,
        {},
      );

      this.logger.log(`Environment ${environmentId} started successfully`);
    } catch (error) {
      this.logger.error(`Failed to start environment: ${error.message}`, error.stack);
      throw new BadRequestException(`Failed to start environment: ${error.message}`);
    }
  }

  /**
   * Stop a Mendix environment
   * @param userId User ID
   * @param organizationId Organization ID
   * @param environmentId Environment ID
   */
  async stopEnvironment(
    userId: string,
    organizationId: string,
    environmentId: string,
  ): Promise<void> {
    try {
      this.logger.log(`Stopping Mendix environment: ${environmentId}`);

      const client = await this.getAuthenticatedClient(userId, organizationId);

      await client.post(
        `${this.mendixConfig.deploymentsApiUrl}/apps/${environmentId}/environments/stop`,
        {},
      );

      this.logger.log(`Environment ${environmentId} stopped successfully`);
    } catch (error) {
      this.logger.error(`Failed to stop environment: ${error.message}`, error.stack);
      throw new BadRequestException(`Failed to stop environment: ${error.message}`);
    }
  }

  /**
   * Get environment status
   * @param userId User ID
   * @param organizationId Organization ID
   * @param environmentId Environment ID
   */
  async getEnvironmentStatus(
    userId: string,
    organizationId: string,
    environmentId: string,
  ): Promise<'Running' | 'Stopped' | 'Starting' | 'Stopping'> {
    try {
      const details = await this.getEnvironmentDetails(userId, organizationId, environmentId);
      return details.status || 'Stopped';
    } catch (error) {
      this.logger.error(`Failed to get environment status: ${error.message}`);
      throw new BadRequestException(`Failed to get status: ${error.message}`);
    }
  }

  /**
   * Get detailed environment information
   * @param userId User ID
   * @param organizationId Organization ID
   * @param environmentId Environment ID
   */
  async getEnvironmentDetails(
    userId: string,
    organizationId: string,
    environmentId: string,
  ): Promise<{
    environmentId: string;
    name: string;
    url: string;
    status: 'Running' | 'Stopped' | 'Starting' | 'Stopping';
    modelVersion: string;
    mendixVersion: string;
    instances: number;
  }> {
    try {
      this.logger.log(`Getting environment details: ${environmentId}`);

      const client = await this.getAuthenticatedClient(userId, organizationId);

      const response = await client.get(
        `${this.mendixConfig.deploymentsApiUrl}/apps/${environmentId}/environments`,
      );

      const environment = response.data;

      return {
        environmentId: environment.environmentId,
        name: environment.name || '',
        url: environment.url || '',
        status: environment.status || 'Stopped',
        modelVersion: environment.modelVersion || '',
        mendixVersion: environment.runtimeVersion || '',
        instances: environment.instances || 1,
      };
    } catch (error) {
      this.logger.error(`Failed to get environment details: ${error.message}`, error.stack);
      throw new BadRequestException(`Failed to get environment details: ${error.message}`);
    }
  }

  /**
   * Clear environment data (reset sandbox)
   * @param userId User ID
   * @param organizationId Organization ID
   * @param environmentId Environment ID
   */
  async clearEnvironmentData(
    userId: string,
    organizationId: string,
    environmentId: string,
  ): Promise<void> {
    try {
      this.logger.log(`Clearing environment data: ${environmentId}`);

      const client = await this.getAuthenticatedClient(userId, organizationId);

      // Stop environment
      await this.stopEnvironment(userId, organizationId, environmentId);

      // Clear database
      await client.post(
        `${this.mendixConfig.deploymentsApiUrl}/apps/${environmentId}/environments/clear-database`,
        {},
      );

      // Restart environment
      await this.startEnvironment(userId, organizationId, environmentId);

      this.logger.log(`Environment ${environmentId} data cleared successfully`);
    } catch (error) {
      this.logger.error(`Failed to clear environment data: ${error.message}`, error.stack);
      throw new BadRequestException(`Failed to clear environment data: ${error.message}`);
    }
  }

  /**
   * Get environment resource usage
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

      const details = await this.getEnvironmentDetails(userId, organizationId, environmentId);

      // Mendix free sandboxes have 1 app per environment
      return {
        appsCount: 1,
        apiCallsUsed: 0, // Not tracked in free tier
        storageUsed: 0, // Not available via API
      };
    } catch (error) {
      this.logger.error(`Failed to get resource usage: ${error.message}`, error.stack);
      throw new BadRequestException(`Failed to get resource usage: ${error.message}`);
    }
  }

  /**
   * Helper: Get app ID from environment ID
   * @param userId User ID
   * @param organizationId Organization ID
   * @param environmentId Environment ID
   */
  private async getAppIdFromEnvironment(
    userId: string,
    organizationId: string,
    environmentId: string,
  ): Promise<string> {
    try {
      const client = await this.getAuthenticatedClient(userId, organizationId);

      // Get all apps and find the one with this environment
      const response = await client.get(`${this.mendixConfig.buildApiUrl}/apps`);
      const apps = response.data;

      for (const app of apps) {
        const envResponse = await client.get(
          `${this.mendixConfig.deploymentsApiUrl}/apps/${app.appId}/environments`,
        );

        const hasEnv = envResponse.data?.some(
          (env: any) => env.environmentId === environmentId,
        );

        if (hasEnv) {
          return app.appId;
        }
      }

      throw new BadRequestException('App not found for environment');
    } catch (error) {
      this.logger.error(`Failed to get app ID: ${error.message}`);
      throw error;
    }
  }
}

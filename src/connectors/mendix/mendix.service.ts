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

    // Get app details
    const app = await this.getApp(userId, organizationId, appId);

    // TODO: Task 9 will implement actual database sync
    // For now, return a placeholder response
    return {
      success: true,
      appId: app.id,
      componentsCount: 0,
      changesDetected: 0,
      syncedAt: new Date(),
      errors: ['Sync functionality will be implemented in Task 9'],
    };
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
}

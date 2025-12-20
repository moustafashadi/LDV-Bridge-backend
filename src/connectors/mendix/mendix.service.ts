import {
  Injectable,
  Logger,
  BadRequestException,
  UnauthorizedException,
  Inject,
  forwardRef,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios, { AxiosInstance } from 'axios';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
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
import { ChangesService } from '../../changes/changes.service';
import { NotificationsService } from '../../notifications/notifications.service';
import { GitHubService } from '../../github/github.service';
import { MendixModelSdkService } from './mendix-model-sdk.service';

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
    jobsApiUrl: string;
  };

  constructor(
    private config: ConfigService,
    private tokenManager: TokenManagerService,
    private websocketGateway: ConnectorsWebSocketGateway,
    private appsService: AppsService,
    @Inject(forwardRef(() => ChangesService))
    private changesService: ChangesService,
    @Inject(forwardRef(() => NotificationsService))
    private notificationsService: NotificationsService,
    @Inject(forwardRef(() => GitHubService))
    private githubService: GitHubService,
    private mendixModelSdkService: MendixModelSdkService,
  ) {
    // Initialize Mendix API URLs
    this.mendixConfig = {
      apiUrl: 'https://deploy.mendix.com/api/1',
      deploymentsApiUrl: 'https://deploy.mendix.com/api/v2',
      buildApiUrl: 'https://projects-api.home.mendix.com/v2',
      jobsApiUrl: 'https://jobs.home.mendix.com/v1', // Central Jobs API for polling async operations
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
   * Create authenticated axios instance for general API access (listing projects, etc.)
   * Uses API Key authentication with Mendix-Username and Mendix-ApiKey headers
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
      throw new UnauthorizedException(
        'Mendix connection expired. Please reconnect.',
      );
    }

    // Mendix uses API Key authentication with username and API key headers
    const client = axios.create({
      headers: {
        'Content-Type': 'application/json',
        'Mendix-Username': token.refreshToken, // Username stored in refreshToken field
        'Mendix-ApiKey': token.accessToken, // API key stored in accessToken field
      },
    });

    // Add request interceptor for logging
    client.interceptors.request.use(
      (config) => {
        this.logger.debug(
          `Mendix API Request: ${config.method?.toUpperCase()} ${config.url}`,
        );
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
          this.logger.warn(
            'Mendix API returned 401 - Invalid or expired credentials',
          );
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
   * Create authenticated axios instance for app creation operations
   * Uses PAT (Personal Access Token) with Authorization: MxToken header
   */
  private async getPatAuthenticatedClient(
    userId: string,
    organizationId: string,
  ): Promise<AxiosInstance> {
    const token = await this.tokenManager.getToken(userId, this.platform);

    if (!token) {
      throw new BadRequestException(
        'No Mendix connection found. Please connect first.',
      );
    }

    if (!token.metadata?.pat) {
      throw new BadRequestException(
        'No Mendix PAT found. Please reconnect with a Personal Access Token.',
      );
    }

    // Check if token is expired
    const isExpired = await this.tokenManager.isTokenExpired(
      userId,
      this.platform,
    );

    if (isExpired) {
      this.logger.warn(`Mendix connection may be expired for user ${userId}`);
      throw new UnauthorizedException(
        'Mendix connection expired. Please reconnect.',
      );
    }

    // For app creation, use PAT with Authorization: MxToken header
    const client = axios.create({
      headers: {
        'Content-Type': 'application/json',
        Authorization: `MxToken ${token.metadata.pat}`, // PAT authentication
      },
    });

    // Add request interceptor for logging
    client.interceptors.request.use(
      (config) => {
        this.logger.debug(
          `Mendix PAT API Request: ${config.method?.toUpperCase()} ${config.url}`,
        );
        return config;
      },
      (error) => {
        this.logger.error('Mendix PAT API Request Error:', error);
        return Promise.reject(error);
      },
    );

    // Add response interceptor for error handling
    client.interceptors.response.use(
      (response) => response,
      async (error) => {
        // Only mark connection as ERROR for authentication failures (401)
        // Ignore 404 errors as they may occur during job polling
        if (error.response?.status === 401) {
          this.logger.warn('Mendix API returned 401 - Invalid or expired PAT');
          await this.tokenManager.updateConnectionStatus(
            userId,
            this.platform,
            ConnectionStatus.ERROR,
          );
        }
        // Don't update connection status for other errors (like 404 during polling)
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
   * Complete "OAuth" flow (for Mendix, this is a wrapper around credentials validation)
   * The interface requires (code, state) but Mendix doesn't use OAuth
   * @param code - Not used for Mendix (API key setup)
   * @param state - Not used for Mendix
   */
  async completeOAuth(code: string, state: string): Promise<OAuth2Token> {
    // This method is not used for Mendix - use validateCredentials instead
    throw new BadRequestException(
      'Mendix does not use OAuth. Please use the /connect endpoint with API key, PAT, and username.',
    );
  }

  /**
   * Validate Mendix credentials and create token object
   * @param apiKey - Mendix API Key for general API access
   * @param pat - Personal Access Token for app creation (stored but not validated during connection)
   * @param username - Mendix username/email
   */
  private async validateCredentials(
    apiKey: string,
    pat: string,
    username: string,
  ): Promise<OAuth2Token> {
    this.logger.log('Validating Mendix credentials with username + API Key');

    if (!apiKey || !pat || !username) {
      throw new BadRequestException(
        'Mendix API key, PAT, and username are required',
      );
    }

    // Validate ONLY the API key and username by making a test request
    // PAT is stored for future app creation operations but not validated here
    try {
      const client = axios.create({
        headers: {
          'Mendix-Username': username,
          'Mendix-ApiKey': apiKey,
        },
      });

      // Test the credentials by fetching apps (validates username + API key)
      this.logger.debug('Testing Mendix connection with username + API Key');
      await client.get(`${this.mendixConfig.apiUrl}/apps`);
      this.logger.log('Mendix username + API Key validated successfully');

      // Create a pseudo-OAuth token object
      // For Mendix, we store:
      // - API key in accessToken (for general API access)
      // - Username in refreshToken
      // - PAT in metadata (for app creation with MxToken header - validated when first used)
      const token: OAuth2Token = {
        accessToken: apiKey,
        tokenType: 'ApiKey',
        expiresAt: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000), // 1 year expiry
        refreshToken: username, // Store username in refreshToken field
        metadata: {
          pat: pat, // Store PAT separately for app creation operations (not validated during connection)
        },
      };

      return token;
    } catch (error) {
      this.logger.error(
        'Failed to validate Mendix credentials:',
        error.message,
      );
      throw new UnauthorizedException(
        'Invalid Mendix API key or username. Please verify your credentials.',
      );
    }
  }

  /**
   * Refresh token (not applicable for API keys, but required by interface)
   */
  async refreshToken(refreshToken: string): Promise<OAuth2Token> {
    // Mendix PATs don't expire like OAuth tokens
    // We just return the existing token
    throw new BadRequestException(
      'Mendix API keys do not support token refresh. Please provide a new API key.',
    );
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
  async disconnect(userId: string, organizationId: string): Promise<void> {
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

    const isExpired = await this.tokenManager.isTokenExpired(
      userId,
      this.platform,
    );

    if (isExpired) {
      return ConnectionStatus.EXPIRED;
    }

    return ConnectionStatus.CONNECTED;
  }

  /**
   * List all projects accessible to the user
   */
  async listProjects(userId: string, organizationId: string): Promise<any[]> {
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
      throw new BadRequestException(
        `Failed to fetch Mendix app: ${error.message}`,
      );
    }
  }

  /**
   * Export app metadata to a directory structure for GitHub commit
   * Creates JSON files that are diffable
   */
  async exportAppMetadata(
    userId: string,
    organizationId: string,
    appId: string,
  ): Promise<string> {
    this.logger.log(`[EXPORT] Exporting Mendix app ${appId} metadata`);

    const client = await this.getAuthenticatedClient(userId, organizationId);

    // Create temp directory for export
    const exportDir = path.join(
      os.tmpdir(),
      `mendix-export-${appId}-${Date.now()}`,
    );
    fs.mkdirSync(exportDir, { recursive: true });

    try {
      // 1. Export app details
      const appResponse = await client.get(
        `${this.mendixConfig.apiUrl}/apps/${appId}`,
      );
      const appData = appResponse.data;

      fs.writeFileSync(
        path.join(exportDir, 'app.json'),
        JSON.stringify(
          {
            appId: appData.AppId,
            projectId: appData.ProjectId,
            name: appData.Name,
            description: appData.Description,
            url: appData.Url,
            exportedAt: new Date().toISOString(),
          },
          null,
          2,
        ),
      );
      this.logger.debug(`[EXPORT] Wrote app.json`);

      // 2. Export environments
      const envDir = path.join(exportDir, 'environments');
      fs.mkdirSync(envDir, { recursive: true });

      try {
        const envResponse = await client.get(
          `${this.mendixConfig.apiUrl}/apps/${appId}/environments`,
        );
        const environments = envResponse.data || [];

        for (const env of environments) {
          const envFileName = `${(env.Mode || env.Name || 'unknown').toLowerCase().replace(/[^a-z0-9]/g, '_')}.json`;
          fs.writeFileSync(
            path.join(envDir, envFileName),
            JSON.stringify(
              {
                mode: env.Mode,
                url: env.Url,
                status: env.Status,
                modelVersion: env.ModelVersion,
                mendixVersion: env.MendixVersion,
                runtime: env.Runtime,
              },
              null,
              2,
            ),
          );
        }
        this.logger.debug(
          `[EXPORT] Wrote ${environments.length} environment files`,
        );
      } catch (error) {
        this.logger.warn(
          `[EXPORT] Could not fetch environments: ${error.message}`,
        );
        // Write empty environments marker
        fs.writeFileSync(
          path.join(envDir, '_no_environments.json'),
          JSON.stringify({ message: 'No environments available' }, null, 2),
        );
      }

      // 3. Export Team Server info (branches)
      const branchesDir = path.join(exportDir, 'branches');
      fs.mkdirSync(branchesDir, { recursive: true });

      try {
        const teamServerResponse = await client.get(
          `${this.mendixConfig.apiUrl}/apps/${appId}/teamserver`,
        );
        const teamServer = teamServerResponse.data;

        fs.writeFileSync(
          path.join(branchesDir, 'teamserver.json'),
          JSON.stringify(
            {
              url: teamServer?.url,
              type: teamServer?.type || 'svn',
              latestRevision: teamServer?.latestRevision,
            },
            null,
            2,
          ),
        );

        // Try to get branches
        try {
          const branchesResponse = await client.get(
            `${this.mendixConfig.apiUrl}/apps/${appId}/branches`,
          );
          const branches = branchesResponse.data || [];

          fs.writeFileSync(
            path.join(branchesDir, 'branches.json'),
            JSON.stringify(
              branches.map((b: any) => ({
                name: b.Name,
                latestCommit: b.LatestCommit,
                latestRevision: b.LatestRevision,
              })),
              null,
              2,
            ),
          );
          this.logger.debug(`[EXPORT] Wrote ${branches.length} branches`);
        } catch (err) {
          this.logger.debug(`[EXPORT] No branches API available`);
        }
      } catch (error) {
        this.logger.warn(
          `[EXPORT] Could not fetch team server info: ${error.message}`,
        );
      }

      // 4. Create summary file
      fs.writeFileSync(
        path.join(exportDir, 'README.md'),
        `# ${appData.Name || appId}

Mendix App Export

- **App ID:** ${appData.AppId}
- **Project ID:** ${appData.ProjectId}
- **Exported:** ${new Date().toISOString()}

## Structure

- \`app.json\` - App metadata
- \`environments/\` - Deployment environments
- \`branches/\` - Team Server branches

---
*Exported by LDV Bridge*
`,
      );

      this.logger.log(`[EXPORT] Export complete: ${exportDir}`);
      return exportDir;
    } catch (error) {
      // Clean up on failure
      try {
        fs.rmSync(exportDir, { recursive: true, force: true });
      } catch {}
      throw error;
    }
  }

  /**
   * Sync app to database with policy-driven flow
   * All changes go to staging branch until pro dev approves
   */
  async syncApp(
    userId: string,
    organizationId: string,
    appId: string,
  ): Promise<ISyncResult> {
    this.logger.log(`Syncing Mendix app ${appId} for user ${userId}`);

    // Declare variables at this scope for return
    let changeResult: any = null;
    let riskAssessment: any = null;
    let stagingBranch: string | undefined = undefined;

    try {
      // Get app details from Mendix
      const appDetails = await this.getApp(userId, organizationId, appId);

      // Get the connector for this organization
      const connections = await this.tokenManager[
        'prisma'
      ].platformConnector.findMany({
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

      // === CHANGE DETECTION AND RISK ANALYSIS ===
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
          riskAssessment = await this.changesService.analyzeChangeImpactSync(
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

      // === GITHUB INTEGRATION (if configured) ===
      try {
        const organization = await this.appsService[
          'prisma'
        ].organization.findUnique({
          where: { id: organizationId },
        });

        if (organization?.githubInstallationId && app.githubRepoUrl) {
          this.logger.log(
            `[GITHUB] Organization has GitHub connected, exporting full model and committing to staging branch...`,
          );

          // Get PAT token for SDK access
          const token = await this.tokenManager.getToken(userId, 'MENDIX');
          const pat = token?.metadata?.pat;

          if (!pat) {
            this.logger.warn(
              `[GITHUB] No PAT available for SDK export, falling back to metadata export`,
            );
            // Fall back to metadata export
            let exportPath: string | null = null;
            try {
              exportPath = await this.exportAppMetadata(
                userId,
                organizationId,
                appId,
              );
              const changeId = changeResult?.change?.id || `temp-${Date.now()}`;
              const commitResult =
                await this.githubService.commitToStagingBranch(
                  app,
                  exportPath,
                  changeId,
                  `Sync: ${app.name} - ${new Date().toISOString()}`,
                );
              stagingBranch = commitResult.branch;
            } finally {
              if (exportPath) {
                try {
                  fs.rmSync(exportPath, { recursive: true, force: true });
                } catch {}
              }
            }
          } else {
            // Use SDK to export full model
            let exportPath: string | null = null;
            try {
              this.logger.log(`[SDK] Exporting full model using SDK...`);
              exportPath = await this.mendixModelSdkService.exportFullModel(
                appId, // Mendix app ID
                pat,
                'main', // Branch name
              );
              this.logger.log(`[SDK] Exported full model to: ${exportPath}`);

              // Commit to staging branch
              const changeId = changeResult?.change?.id || `temp-${Date.now()}`;
              const commitResult =
                await this.githubService.commitToStagingBranch(
                  app,
                  exportPath,
                  changeId,
                  `Sync: ${app.name} (Full Model) - ${new Date().toISOString()}`,
                );

              stagingBranch = commitResult.branch;
              this.logger.log(
                `[GITHUB] Committed full model to staging branch: ${stagingBranch}`,
              );
            } finally {
              // Clean up temp directory
              if (exportPath) {
                try {
                  fs.rmSync(exportPath, { recursive: true, force: true });
                  this.logger.debug(
                    `[GITHUB] Cleaned up temp export: ${exportPath}`,
                  );
                } catch {}
              }
            }
          }
        }
      } catch (githubError) {
        this.logger.warn(`[GITHUB] GitHub sync failed: ${githubError.message}`);
      }

      // === NOTIFY PRO DEVELOPERS FOR HIGH RISK ===
      if (
        riskAssessment &&
        (riskAssessment.level === 'high' || riskAssessment.level === 'critical')
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
              platform: 'MENDIX',
            },
          );
        } catch (notifyError) {
          this.logger.warn(
            `[NOTIFY] Failed to notify pro developers: ${notifyError.message}`,
          );
        }
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
        stagingBranch,
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
        throw new BadRequestException(
          'Team Server information not available for this app',
        );
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
   * Save Mendix API credentials (API Key + PAT + Username)
   */
  async saveCredentials(
    userId: string,
    organizationId: string,
    apiKey: string,
    pat: string,
    username: string,
  ): Promise<void> {
    this.logger.log(`Saving Mendix credentials for user ${userId}`);

    // Validate credentials
    const token = await this.validateCredentials(apiKey, pat, username);

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
      sourceAppId?: string; // If provided, clone existing app instead of creating new
    },
  ): Promise<{
    environmentId: string;
    environmentUrl: string;
    status: string;
    appId: string;
    isCloned: boolean;
    metadata?: any;
  }> {
    try {
      this.logger.log(`Creating Mendix sandbox: ${config.name}`);

      // Use API Key client for general operations (listing apps)
      const apiKeyClient = await this.getAuthenticatedClient(
        userId,
        organizationId,
      );

      // Use PAT client for app creation operations
      const patClient = await this.getPatAuthenticatedClient(
        userId,
        organizationId,
      );

      let app: any;
      let isCloned = false;

      // If sourceAppId provided, use the existing app's free environment as sandbox
      if (config.sourceAppId) {
        this.logger.log(
          `Using existing app as sandbox base: ${config.sourceAppId}`,
        );

        // Mendix doesn't support app cloning via API
        // Instead, we'll just use the existing app's free environment
        // The user can manually duplicate the app in Mendix Portal if needed

        // Verify the app exists and get its details (use API Key client for reading)
        try {
          const appResponse = await apiKeyClient.get(
            `${this.mendixConfig.apiUrl}/apps/${config.sourceAppId}`,
          );

          app = appResponse.data;
          app.appId = config.sourceAppId; // Ensure appId is set

          this.logger.log(`Found app: ${app.name || config.sourceAppId}`);
          this.logger.warn(
            `Note: Mendix does not support app cloning via API. ` +
              `This sandbox will reference the existing app "${app.name || config.sourceAppId}". ` +
              `To create a true copy, please duplicate the app in Mendix Portal first.`,
          );
        } catch (error) {
          this.logger.error(
            `Failed to fetch Mendix app: ${error.response?.status} ${error.response?.statusText}`,
          );
          this.logger.error(
            `App endpoint: GET ${this.mendixConfig.apiUrl}/apps/${config.sourceAppId}`,
          );
          this.logger.error(
            `Error details: ${JSON.stringify(error.response?.data)}`,
          );

          throw new BadRequestException(
            `Unable to find Mendix app with ID "${config.sourceAppId}". ` +
              `Please ensure the app exists and you have access to it. ` +
              `Error: ${error.message}`,
          );
        }
      } else {
        // Create a new app using Mendix Build API with PAT authentication
        // Note: This requires PAT with appropriate permissions
        // The Build API returns a jobId, not an appId - app creation is asynchronous
        this.logger.log(`Attempting to create new Mendix app using PAT`);

        try {
          const response = await patClient.post(
            `${this.mendixConfig.buildApiUrl}/projects`,
            {
              name: config.name,
            },
          );

          const jobData = response.data;
          this.logger.log(
            `App creation job submitted: ${JSON.stringify(jobData)}`,
          );

          // Mendix Build API returns a jobId for async app creation
          // Poll the job status endpoint to wait for completion
          if (jobData.jobId) {
            this.logger.log(
              `App creation initiated (jobId: ${jobData.jobId}). Polling job status...`,
            );

            // Poll the job status endpoint
            const maxWaitTime = 2 * 60 * 1000; // 2 minutes max
            const startTime = Date.now();
            let pollInterval = 3000; // Start with 3 seconds
            const maxPollInterval = 15000; // Max 15 seconds between polls
            let jobCompleted = false;
            let projectId: string | null = null;

            while (Date.now() - startTime < maxWaitTime && !jobCompleted) {
              await new Promise((resolve) => setTimeout(resolve, pollInterval));

              try {
                // Poll the job status endpoint: GET /projects/jobs/{job-id}
                this.logger.debug(`Checking job status: ${jobData.jobId}`);
                const jobStatusResponse = await patClient.get(
                  `${this.mendixConfig.buildApiUrl}/projects/jobs/${jobData.jobId}`,
                );

                const jobStatus = jobStatusResponse.data;
                this.logger.debug(`Job status: ${JSON.stringify(jobStatus)}`);

                // Check if job is completed
                if (
                  jobStatus.status === 'completed' ||
                  jobStatus.state === 'completed'
                ) {
                  jobCompleted = true;
                  projectId =
                    jobStatus.projectId || jobStatus.result?.projectId;
                  this.logger.log(
                    `App creation completed! Project ID: ${projectId}`,
                  );
                } else if (
                  jobStatus.status === 'failed' ||
                  jobStatus.state === 'failed'
                ) {
                  throw new BadRequestException(
                    `App creation failed: ${jobStatus.error || jobStatus.message || 'Unknown error'}`,
                  );
                } else {
                  // Still processing
                  this.logger.debug(
                    `Job still processing (status: ${jobStatus.status || jobStatus.state}). Will retry in ${Math.round(pollInterval / 1000)}s`,
                  );
                  pollInterval = Math.min(pollInterval * 1.3, maxPollInterval);
                }
              } catch (pollError) {
                if (pollError.response?.status === 404) {
                  // Job not found yet, keep trying
                  this.logger.debug(`Job not found yet, will retry...`);
                  pollInterval = Math.min(pollInterval * 1.3, maxPollInterval);
                } else {
                  this.logger.warn(
                    `Error checking job status: ${pollError.message}`,
                  );
                  // Don't mark connection as error during polling
                  if (Date.now() - startTime >= maxWaitTime) {
                    throw pollError;
                  }
                }
              }
            }

            if (!jobCompleted || !projectId) {
              // Timeout
              this.logger.warn(
                `Job polling timed out after ${Math.round((Date.now() - startTime) / 1000)}s`,
              );
              throw new BadRequestException(
                `App creation verification timed out. The app "${config.name}" may still be creating. ` +
                  `Please check Mendix Portal (https://sprintr.home.mendix.com/) and sync from Connectors page once it appears.`,
              );
            }

            // Job completed successfully, set the app with the projectId
            app = {
              appId: projectId,
              projectId: projectId,
              name: config.name,
            };
          } else {
            // Unexpected response format
            throw new BadRequestException(
              `Unexpected response from Mendix Build API. Expected jobId but got: ${JSON.stringify(jobData)}`,
            );
          }
        } catch (error) {
          this.logger.error(
            `Failed to create new Mendix app via Build API: ${error.response?.status} ${error.response?.statusText}`,
          );
          this.logger.error(
            `Error details: ${JSON.stringify(error.response?.data)}`,
          );

          // Provide helpful error message
          throw new BadRequestException(
            `Unable to create new Mendix app. ` +
              `This may indicate an invalid PAT or insufficient permissions (requires mx:projects:write). ` +
              `Please verify your Personal Access Token has app creation permissions. ` +
              `Alternatively, try creating the app in Mendix Portal first and sync it. ` +
              `Error: ${error.message}`,
          );
        }
      }

      // Get the default environment (sandbox)
      // Note: Newly created apps won't have environments in Deploy API until first deployment
      const appIdToUse = app.appId || config.sourceAppId;

      this.logger.log(`Fetching environments for app ID: ${appIdToUse}`);
      this.logger.debug(`App object from API: ${JSON.stringify(app)}`);

      let envResponse;
      let sandboxEnv;

      try {
        // Use Deploy API v1 for environments (same as in getAppWithDetails) with API Key client
        envResponse = await apiKeyClient.get(
          `${this.mendixConfig.apiUrl}/apps/${appIdToUse}/environments`,
        );

        this.logger.debug(
          `Environments response: ${JSON.stringify(envResponse.data)}`,
        );

        // Mendix Deploy API v1 uses "Mode" field, not "type"
        // Look for "Sandbox" mode (free tier) or "Production: false"
        sandboxEnv = envResponse.data?.find(
          (env: any) => env.Mode === 'Sandbox' || !env.Production,
        );
      } catch (error) {
        // If app not found in Deploy API, it means it's a newly created app without environments yet
        if (
          error.response?.status === 404 &&
          error.response?.data?.errorCode === 'APP_NOT_FOUND'
        ) {
          this.logger.log(
            `App "${appIdToUse}" not found in Deploy API - this is expected for newly created apps. ` +
              `Returning success with project info.`,
          );

          // Return success with project information
          // User can access the app in Mendix Portal and deploy it manually
          return {
            environmentId: appIdToUse, // Use projectId as identifier
            environmentUrl: `https://sprintr.home.mendix.com/link/project/${appIdToUse}`, // Direct link to project
            status: 'created',
            appId: appIdToUse,
            isCloned: isCloned,
            metadata: {
              projectId: appIdToUse,
              appName: config.name,
              createdAt: new Date().toISOString(),
              message:
                'App created successfully! The app needs to be deployed before it has environments. Visit Mendix Portal to deploy your app.',
              portalUrl: `https://sprintr.home.mendix.com/link/project/${appIdToUse}`,
            },
          };
        }

        // For other errors, log and throw
        this.logger.error(
          `Failed to fetch environments: ${error.response?.status} ${error.response?.statusText}`,
        );
        this.logger.error(
          `Environment endpoint: GET ${this.mendixConfig.apiUrl}/apps/${appIdToUse}/environments`,
        );
        this.logger.error(
          `Error details: ${JSON.stringify(error.response?.data)}`,
        );

        throw new BadRequestException(
          `Unable to fetch environments for Mendix app "${appIdToUse}". ` +
            `This app may not have any environments, or the app ID format is incorrect. ` +
            `Error: ${error.message}`,
        );
      }

      if (!sandboxEnv) {
        this.logger.warn(
          `No Sandbox environment found. Available environments: ${JSON.stringify(envResponse.data)}`,
        );
        throw new BadRequestException(
          `No sandbox environment found for app "${appIdToUse}". ` +
            `Available environments do not include a free sandbox. ` +
            `Please ensure this app has a free sandbox environment in Mendix Portal.`,
        );
      }

      this.logger.log(`Found sandbox environment: ${sandboxEnv.EnvironmentId}`);

      // Construct the Mendix Developer Portal URL
      // Note: As of Mendix 10, Studio (web) has been merged into Studio Pro (desktop)
      // The Developer Portal is the web-accessible entry point where users can:
      // - View project details and manage settings
      // - Access "Edit in Studio Pro" button (requires desktop install)
      // - View the running app
      const projectId = app.ProjectId || app.projectId;

      // Use Developer Portal as the primary URL (web-accessible)
      const portalUrl = projectId
        ? `https://sprintr.home.mendix.com/link/project/${projectId}`
        : sandboxEnv.Url; // Fallback to app URL if no project ID

      this.logger.log(`Mendix Developer Portal URL: ${portalUrl}`);

      return {
        environmentId: sandboxEnv.EnvironmentId, // Note: Capital E in API response
        environmentUrl: portalUrl, // Developer Portal (web-accessible)
        status: sandboxEnv.Status || 'Stopped', // Note: Capital S in API response
        appId: app.appId,
        isCloned,
        metadata: {
          runtimeUrl: sandboxEnv.Url, // The running app URL
          projectId: projectId,
          mode: sandboxEnv.Mode,
          mendixVersion: sandboxEnv.MendixVersion,
          editorType: 'studio-pro-desktop', // Indicates desktop app required for editing
          studioPro: {
            required: true,
            downloadUrl: 'https://marketplace.mendix.com/link/studiopro/',
            note: 'As of Mendix 10, Studio Web has been merged into Studio Pro (desktop)',
          },
        },
      };
    } catch (error) {
      this.logger.error(
        `Failed to create sandbox: ${error.message}`,
        error.stack,
      );
      throw new BadRequestException(
        `Failed to create sandbox: ${error.message}`,
      );
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

      const apiKeyClient = await this.getAuthenticatedClient(
        userId,
        organizationId,
      );
      const patClient = await this.getPatAuthenticatedClient(
        userId,
        organizationId,
      );

      // First, try to determine if this is a deployed app or newly created project
      // For newly created apps, environmentId is actually the projectId

      try {
        // Try Deploy API first (for deployed apps with actual environments)
        // Stop the environment first
        try {
          await this.stopEnvironment(userId, organizationId, environmentId);
        } catch (stopError) {
          this.logger.warn(
            `Failed to stop environment (may not be running): ${stopError.message}`,
          );
        }

        // Try to get app ID and delete via Deploy API
        const appId = await this.getAppIdFromEnvironment(
          userId,
          organizationId,
          environmentId,
        );

        await apiKeyClient.delete(`${this.mendixConfig.apiUrl}/apps/${appId}`);
        this.logger.log(`Sandbox ${environmentId} deleted via Deploy API`);
      } catch (deployError) {
        // If Deploy API fails (404), this is likely a newly created project
        // Try to delete via Build API using projectId
        this.logger.log(
          `Deploy API deletion failed (${deployError.message}). Attempting Build API deletion for project ${environmentId}...`,
        );

        try {
          // Delete project via Build API using PAT
          await patClient.delete(
            `${this.mendixConfig.buildApiUrl}/projects/${environmentId}`,
          );
          this.logger.log(`Project ${environmentId} deleted via Build API`);
        } catch (buildError) {
          // If both APIs fail, log but don't throw - the app might already be deleted
          if (buildError.response?.status === 404) {
            this.logger.warn(
              `Project ${environmentId} not found in Build API either - may already be deleted`,
            );
          } else {
            throw buildError;
          }
        }
      }

      this.logger.log(`Sandbox ${environmentId} deletion completed`);
    } catch (error) {
      this.logger.error(
        `Failed to delete sandbox: ${error.message}`,
        error.stack,
      );
      throw new BadRequestException(
        `Failed to delete sandbox: ${error.message}`,
      );
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
      this.logger.error(
        `Failed to start environment: ${error.message}`,
        error.stack,
      );
      throw new BadRequestException(
        `Failed to start environment: ${error.message}`,
      );
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
      this.logger.error(
        `Failed to stop environment: ${error.message}`,
        error.stack,
      );
      throw new BadRequestException(
        `Failed to stop environment: ${error.message}`,
      );
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
      const details = await this.getEnvironmentDetails(
        userId,
        organizationId,
        environmentId,
      );
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
      this.logger.error(
        `Failed to get environment details: ${error.message}`,
        error.stack,
      );
      throw new BadRequestException(
        `Failed to get environment details: ${error.message}`,
      );
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
      this.logger.error(
        `Failed to clear environment data: ${error.message}`,
        error.stack,
      );
      throw new BadRequestException(
        `Failed to clear environment data: ${error.message}`,
      );
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
      this.logger.log(
        `Getting resource usage for environment: ${environmentId}`,
      );

      const details = await this.getEnvironmentDetails(
        userId,
        organizationId,
        environmentId,
      );

      // Mendix free sandboxes have 1 app per environment
      return {
        appsCount: 1,
        apiCallsUsed: 0, // Not tracked in free tier
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
      const response = await client.get(
        `${this.mendixConfig.buildApiUrl}/apps`,
      );
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

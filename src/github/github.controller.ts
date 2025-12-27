import {
  Controller,
  Get,
  Post,
  Delete,
  Body,
  Param,
  UseGuards,
  HttpCode,
  HttpStatus,
  HttpException,
  Query,
  Logger,
  Res,
  Req,
} from '@nestjs/common';
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiBearerAuth,
  ApiExcludeEndpoint,
} from '@nestjs/swagger';
import * as express from 'express';
import { ConfigService } from '@nestjs/config';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { GitHubService } from './github.service';
import { PrismaService } from '../prisma/prisma.service';
import {
  ConnectGitHubDto,
  CreateRepoDto,
  GitHubConnectionStatusDto,
  GitHubRepoDto,
} from './dto';

@ApiTags('GitHub')
@Controller('github')
export class GitHubController {
  private readonly logger = new Logger(GitHubController.name);

  constructor(
    private readonly githubService: GitHubService,
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {}

  // ========================================
  // PUBLIC ENDPOINTS (No Auth Required)
  // ========================================

  /**
   * GitHub App installation callback
   * Called when user installs the GitHub App on their org
   */
  @Get('callback')
  @ApiExcludeEndpoint()
  async handleCallback(
    @Query('code') code: string,
    @Query('installation_id') installationId: string,
    @Query('setup_action') setupAction: string,
    @Res() res: express.Response,
  ): Promise<void> {
    this.logger.log(
      `GitHub callback received: installation_id=${installationId}, setup_action=${setupAction}`,
    );

    const frontendUrl = this.config.get<string>(
      'FRONTEND_URL',
      'http://localhost:3000',
    );

    if (setupAction === 'install' && installationId) {
      // Get installation details from GitHub to find org name
      let orgName = '';
      try {
        // For now, we'll get the org name when the user connects via the frontend
        // The frontend will call /connect with the installation ID
        this.logger.log(`GitHub App installed successfully: ${installationId}`);
      } catch (error) {
        this.logger.error(`Error fetching installation details: ${error}`);
      }

      // Redirect to frontend with installation ID
      res.redirect(
        `${frontendUrl}/admin/connectors/github?installation_id=${installationId}&status=success`,
      );
    } else if (setupAction === 'update') {
      res.redirect(`${frontendUrl}/admin/connectors/github?status=updated`);
    } else {
      res.redirect(`${frontendUrl}/admin/connectors/github?status=cancelled`);
    }
  }

  /**
   * GitHub webhook handler
   * Called by GitHub when events occur (push, PR, etc.)
   */
  @Post('webhook')
  @ApiExcludeEndpoint()
  @HttpCode(HttpStatus.OK)
  async handleWebhook(
    @Body() payload: any,
    @Req() req: express.Request,
  ): Promise<{ received: boolean }> {
    const event = req.headers['x-github-event'] as string;
    const deliveryId = req.headers['x-github-delivery'] as string;

    this.logger.log(
      `GitHub webhook received: event=${event}, delivery=${deliveryId}, action=${payload.action || 'N/A'}`,
    );

    // TODO: Verify webhook signature using GITHUB_APP_WEBHOOK_SECRET
    // const signature = req.headers['x-hub-signature-256'];

    // Handle different event types
    switch (event) {
      case 'installation':
        if (payload.action === 'created') {
          this.logger.log(
            `GitHub App installed on: ${payload.installation?.account?.login}`,
          );
        } else if (payload.action === 'deleted') {
          this.logger.log(
            `GitHub App uninstalled from: ${payload.installation?.account?.login}`,
          );
        }
        break;

      case 'push':
        this.logger.log(
          `Push to ${payload.repository?.full_name}: ${payload.ref}`,
        );
        break;

      case 'pull_request':
        this.logger.log(
          `PR ${payload.action} on ${payload.repository?.full_name}: #${payload.pull_request?.number}`,
        );
        break;
    }

    return { received: true };
  }

  // ========================================
  // AUTHENTICATED ENDPOINTS
  // ========================================

  @Get('status')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Get GitHub connection status' })
  @ApiResponse({ status: 200, type: GitHubConnectionStatusDto })
  async getStatus(
    @CurrentUser('organizationId') organizationId: string,
  ): Promise<GitHubConnectionStatusDto> {
    return this.githubService.getConnectionStatus(organizationId);
  }

  @Post('connect')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Connect GitHub to organization' })
  @ApiResponse({ status: 200, description: 'GitHub connected' })
  @HttpCode(HttpStatus.OK)
  async connect(
    @CurrentUser('organizationId') organizationId: string,
    @Body() dto: ConnectGitHubDto,
  ): Promise<{ success: boolean; message: string }> {
    // Get organization name from GitHub using the installation ID
    let orgName = dto.organizationName || '';
    let accountType = 'User'; // Default to User, can be 'Organization'

    // Debug: Log config availability
    const appId = this.config.get<string>('GITHUB_APP_ID');
    this.logger.log(
      `[DEBUG] GITHUB_APP_ID from config: ${appId ? 'Present' : 'MISSING'}`,
    );

    if (!orgName) {
      try {
        // Try to get org name from GitHub API
        const appJwt = this.generateTempJwt();

        // Decode JWT to verify contents (for debugging)
        const jwt = require('jsonwebtoken');
        const decoded = jwt.decode(appJwt);
        this.logger.log(`[JWT] Decoded payload: ${JSON.stringify(decoded)}`);

        this.logger.log(
          `Fetching installation details for: ${dto.installationId}`,
        );

        // First, let's list all installations to debug
        const listResponse = await fetch(
          `https://api.github.com/app/installations`,
          {
            headers: {
              Accept: 'application/vnd.github+json',
              Authorization: `Bearer ${appJwt}`,
              'X-GitHub-Api-Version': '2022-11-28',
            },
          },
        );

        if (listResponse.ok) {
          const installations = await listResponse.json();
          this.logger.log(
            `[GitHub] Found ${installations.length} installations for this app`,
          );
          installations.forEach((inst: any) => {
            this.logger.log(
              `[GitHub] Installation: id=${inst.id}, account=${inst.account?.login}, type=${inst.account?.type}`,
            );
          });

          // Try to find the installation in our list
          const matchingInstallation = installations.find(
            (inst: any) => inst.id.toString() === dto.installationId,
          );

          if (matchingInstallation) {
            orgName = matchingInstallation.account?.login || '';
            accountType = matchingInstallation.account?.type || 'User';
            this.logger.log(
              `[GitHub] Found matching installation: ${orgName} (${accountType})`,
            );
          } else {
            this.logger.warn(
              `[GitHub] Installation ${dto.installationId} not found in app's installations`,
            );
            // Maybe the installation ID is from a different app?
          }
        } else {
          const errorText = await listResponse.text();
          this.logger.warn(
            `[GitHub] Failed to list installations: ${listResponse.status} - ${errorText}`,
          );

          // Fall back to direct fetch
          const response = await fetch(
            `https://api.github.com/app/installations/${dto.installationId}`,
            {
              headers: {
                Accept: 'application/vnd.github+json',
                Authorization: `Bearer ${appJwt}`,
                'X-GitHub-Api-Version': '2022-11-28',
              },
            },
          );

          if (response.ok) {
            const data = await response.json();
            orgName = data.account?.login || '';
            accountType = data.account?.type || 'User';
            this.logger.log(
              `GitHub account detected: ${orgName} (type: ${accountType})`,
            );
          } else {
            const errorText = await response.text();
            this.logger.warn(
              `GitHub API returned ${response.status}: ${errorText}`,
            );
          }
        }
      } catch (error) {
        this.logger.warn(`Could not fetch org name: ${error}`);
      }
    }

    if (!orgName) {
      throw new HttpException(
        'Could not detect GitHub organization/user. Please ensure the GitHub App is installed correctly.',
        HttpStatus.BAD_REQUEST,
      );
    }

    await this.githubService.connectGitHub(
      organizationId,
      dto.installationId,
      orgName,
    );

    return {
      success: true,
      message: `GitHub connected successfully to ${orgName}`,
    };
  }

  @Delete('disconnect')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Disconnect GitHub from organization' })
  @ApiResponse({ status: 200, description: 'GitHub disconnected' })
  @HttpCode(HttpStatus.OK)
  async disconnect(
    @CurrentUser('organizationId') organizationId: string,
  ): Promise<{ success: boolean; message: string }> {
    await this.githubService.disconnectGitHub(organizationId);

    return {
      success: true,
      message: 'GitHub disconnected',
    };
  }

  // ========================================
  // REPOSITORY MANAGEMENT
  // ========================================

  @Post('repos')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Create GitHub repository for an app' })
  @ApiResponse({ status: 201, type: GitHubRepoDto })
  async createRepository(
    @CurrentUser('organizationId') organizationId: string,
    @CurrentUser('id') userId: string,
    @Body() dto: CreateRepoDto,
  ): Promise<GitHubRepoDto> {
    this.logger.log(
      `Creating repository for app ${dto.appId} by user ${userId}`,
    );

    const app = await this.prisma.app.findFirst({
      where: { id: dto.appId, organizationId },
    });

    if (!app) {
      throw new Error('App not found');
    }

    const repo = await this.githubService.createAppRepository(app);

    return {
      id: repo.node_id,
      name: repo.name,
      fullName: repo.full_name,
      htmlUrl: repo.html_url,
      cloneUrl: repo.clone_url,
      defaultBranch: repo.default_branch,
      private: repo.private,
    };
  }

  // ========================================
  // DIFF & COMPARISON
  // ========================================

  @Get('diff')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Get file diff between branches' })
  @ApiResponse({ status: 200, description: 'File diffs' })
  async getDiff(
    @CurrentUser('organizationId') organizationId: string,
    @Query('repo') repo: string,
    @Query('base') base: string,
    @Query('head') head: string,
  ): Promise<any[]> {
    return this.githubService.getFileDiff(repo, base, head, organizationId);
  }

  // ========================================
  // HELPER METHODS
  // ========================================

  private generateTempJwt(): string {
    const appId = this.config.get<string>('GITHUB_APP_ID');
    const privateKey = this.config.get<string>('GITHUB_APP_PRIVATE_KEY');
    const privateKeyPath = this.config.get<string>(
      'GITHUB_APP_PRIVATE_KEY_PATH',
    );

    if (!appId) {
      throw new Error('GITHUB_APP_ID not configured');
    }

    let key = privateKey;
    if (!key && privateKeyPath) {
      const fs = require('fs');
      const path = require('path');

      // Resolve relative paths from the project root (backend folder)
      let resolvedPath = privateKeyPath;
      if (!path.isAbsolute(privateKeyPath)) {
        resolvedPath = path.resolve(process.cwd(), privateKeyPath);
      }

      this.logger.debug(`[JWT] Private key path: ${privateKeyPath}`);
      this.logger.debug(`[JWT] Resolved path: ${resolvedPath}`);
      this.logger.debug(`[JWT] Current working dir: ${process.cwd()}`);

      if (fs.existsSync(resolvedPath)) {
        key = fs.readFileSync(resolvedPath, 'utf8');
        this.logger.debug(
          `[JWT] Successfully loaded key from file (${key?.length || 0} chars)`,
        );
      } else {
        this.logger.error(`[JWT] Private key file not found: ${resolvedPath}`);
      }
    }

    if (!key) {
      throw new Error('GitHub private key not configured');
    }

    const jwt = require('jsonwebtoken');
    const now = Math.floor(Date.now() / 1000);

    // GitHub JWTs must expire within 10 minutes, use 5 minutes to be safe
    // iat should be no more than 60 seconds in the past
    const payload = {
      iat: now - 30, // 30 seconds in the past (less aggressive)
      exp: now + 300, // 5 minutes (well within 10 min limit)
      iss: appId,
    };

    this.logger.debug(
      `[JWT] Generating JWT with iat=${payload.iat}, exp=${payload.exp}, now=${now}`,
    );
    this.logger.debug(`[JWT] Current time: ${new Date().toISOString()}`);
    this.logger.debug(
      `[JWT] Token valid from: ${new Date(payload.iat * 1000).toISOString()}`,
    );
    this.logger.debug(
      `[JWT] Token expires at: ${new Date(payload.exp * 1000).toISOString()}`,
    );

    // Process the key - handle both escaped newlines and base64 encoded keys
    let processedKey = key;

    // If key contains literal \n (escaped), replace with actual newlines
    if (key.includes('\\n')) {
      processedKey = key.replace(/\\n/g, '\n');
    }

    // Debug key format
    this.logger.debug(`[JWT] Key length: ${processedKey.length} chars`);
    this.logger.debug(
      `[JWT] Key starts with: ${processedKey.substring(0, 40)}...`,
    );
    this.logger.debug(
      `[JWT] Key ends with: ...${processedKey.substring(processedKey.length - 40)}`,
    );

    // Verify key format
    if (
      !processedKey.includes('-----BEGIN RSA PRIVATE KEY-----') &&
      !processedKey.includes('-----BEGIN PRIVATE KEY-----')
    ) {
      this.logger.error(`[JWT] Private key does not have valid PEM header!`);
      this.logger.error(`[JWT] Key preview: ${processedKey.substring(0, 100)}`);
    }

    return jwt.sign(payload, processedKey, { algorithm: 'RS256' });
  }
}

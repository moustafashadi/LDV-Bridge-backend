import { Injectable, Logger, HttpException, HttpStatus } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../prisma/prisma.service';
import { App, Sandbox, Review, Organization } from '@prisma/client';
import * as jwt from 'jsonwebtoken';
import * as fs from 'fs';
import * as path from 'path';

interface GitHubInstallationToken {
  token: string;
  expiresAt: Date;
}

interface GitHubRepo {
  id: number;
  node_id: string;
  name: string;
  full_name: string;
  html_url: string;
  clone_url: string;
  default_branch: string;
  private: boolean;
}

interface GitHubCommit {
  sha: string;
  html_url: string;
  commit: {
    message: string;
    author: {
      name: string;
      email: string;
      date: string;
    };
  };
}

interface GitHubBranch {
  name: string;
  commit: {
    sha: string;
  };
  protected: boolean;
}

interface GitHubPullRequest {
  number: number;
  title: string;
  html_url: string;
  state: 'open' | 'closed';
  head: { ref: string };
  base: { ref: string };
  merged_at: string | null;
}

interface FileDiff {
  filename: string;
  status: 'added' | 'removed' | 'modified' | 'renamed';
  additions: number;
  deletions: number;
  patch?: string;
}

@Injectable()
export class GitHubService {
  private readonly logger = new Logger(GitHubService.name);
  private readonly appId: string;
  private readonly privateKey: string;
  private installationTokenCache: Map<string, GitHubInstallationToken> =
    new Map();

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {
    this.appId = this.config.get<string>('GITHUB_APP_ID') || '';
    const privateKeyPath = this.config.get<string>(
      'GITHUB_APP_PRIVATE_KEY_PATH',
    );
    const privateKeyEnv = this.config.get<string>('GITHUB_APP_PRIVATE_KEY');

    if (privateKeyPath && fs.existsSync(privateKeyPath)) {
      this.privateKey = fs.readFileSync(privateKeyPath, 'utf8');
    } else if (privateKeyEnv) {
      // Handle newlines in environment variable
      this.privateKey = privateKeyEnv.replace(/\\n/g, '\n');
    } else {
      this.logger.warn('GitHub App private key not configured');
      this.privateKey = '';
    }
  }

  // ========================================
  // JWT & AUTH
  // ========================================

  /**
   * Generate a JWT for GitHub App authentication
   */
  private generateAppJwt(): string {
    if (!this.appId || !this.privateKey) {
      throw new HttpException(
        'GitHub App not configured',
        HttpStatus.SERVICE_UNAVAILABLE,
      );
    }

    const now = Math.floor(Date.now() / 1000);
    const payload = {
      iat: now - 30, // 30 seconds in the past (less aggressive)
      exp: now + 300, // 5 minutes (safer, well within 10 min limit)
      iss: this.appId,
    };

    // Debug logging
    this.logger.debug(`[JWT DEBUG] App ID: ${this.appId}`);
    this.logger.debug(`[JWT DEBUG] Current timestamp: ${now}`);
    this.logger.debug(
      `[JWT DEBUG] iat: ${payload.iat} (${new Date(payload.iat * 1000).toISOString()})`,
    );
    this.logger.debug(
      `[JWT DEBUG] exp: ${payload.exp} (${new Date(payload.exp * 1000).toISOString()})`,
    );
    this.logger.debug(
      `[JWT DEBUG] Private key length: ${this.privateKey.length} chars`,
    );
    this.logger.debug(
      `[JWT DEBUG] Private key starts with: ${this.privateKey.substring(0, 30)}...`,
    );

    return jwt.sign(payload, this.privateKey, { algorithm: 'RS256' });
  }

  /**
   * Get an installation access token for an organization
   */
  async getInstallationToken(organizationId: string): Promise<string> {
    const org = await this.prisma.organization.findUnique({
      where: { id: organizationId },
    });

    if (!org?.githubInstallationId) {
      throw new HttpException(
        'GitHub not connected for this organization',
        HttpStatus.BAD_REQUEST,
      );
    }

    // Check cache
    const cached = this.installationTokenCache.get(org.githubInstallationId);
    if (cached && cached.expiresAt > new Date()) {
      return cached.token;
    }

    // Fetch new token
    const appJwt = this.generateAppJwt();
    const response = await fetch(
      `https://api.github.com/app/installations/${org.githubInstallationId}/access_tokens`,
      {
        method: 'POST',
        headers: {
          Accept: 'application/vnd.github+json',
          Authorization: `Bearer ${appJwt}`,
          'X-GitHub-Api-Version': '2022-11-28',
        },
      },
    );

    if (!response.ok) {
      const error = await response.text();
      this.logger.error(`Failed to get installation token: ${error}`);
      throw new HttpException(
        'Failed to authenticate with GitHub',
        HttpStatus.BAD_GATEWAY,
      );
    }

    const data = await response.json();
    const token: GitHubInstallationToken = {
      token: data.token,
      expiresAt: new Date(data.expires_at),
    };

    this.installationTokenCache.set(org.githubInstallationId, token);
    return token.token;
  }

  // ========================================
  // CONNECTION STATUS
  // ========================================

  /**
   * Check if GitHub is connected for an organization
   */
  async getConnectionStatus(organizationId: string): Promise<{
    connected: boolean;
    installationId?: string;
    organizationName?: string;
    installationUrl?: string;
  }> {
    const org = await this.prisma.organization.findUnique({
      where: { id: organizationId },
    });

    if (!org?.githubInstallationId) {
      const installationUrl = `https://github.com/apps/${this.config.get('GITHUB_APP_NAME', 'ldv-bridge')}/installations/new`;
      return {
        connected: false,
        installationUrl,
      };
    }

    return {
      connected: true,
      installationId: org.githubInstallationId,
      organizationName: org.githubOrgName || undefined,
    };
  }

  /**
   * Connect GitHub to an organization (called after OAuth callback)
   */
  async connectGitHub(
    organizationId: string,
    installationId: string,
    orgName: string,
  ): Promise<void> {
    await this.prisma.organization.update({
      where: { id: organizationId },
      data: {
        githubInstallationId: installationId,
        githubOrgName: orgName,
      },
    });

    this.logger.log(
      `GitHub connected for organization ${organizationId}: installation=${installationId}, org=${orgName}`,
    );
  }

  /**
   * Disconnect GitHub from an organization
   */
  async disconnectGitHub(organizationId: string): Promise<void> {
    await this.prisma.organization.update({
      where: { id: organizationId },
      data: {
        githubInstallationId: null,
        githubOrgName: null,
      },
    });

    this.logger.log(`GitHub disconnected for organization ${organizationId}`);
  }

  // ========================================
  // REPOSITORY MANAGEMENT
  // ========================================

  /**
   * Create a GitHub repository for an app
   */
  async createAppRepository(app: App): Promise<GitHubRepo> {
    const org = await this.prisma.organization.findUnique({
      where: { id: app.organizationId },
    });

    if (!org?.githubOrgName) {
      throw new HttpException(
        'GitHub not connected for this organization',
        HttpStatus.BAD_REQUEST,
      );
    }

    const token = await this.getInstallationToken(app.organizationId);
    const repoName = this.generateRepoName(app.name);

    // Try to create repository under the organization first
    // For user accounts, we'll use /user/repos instead of /orgs/
    let response = await fetch(
      `https://api.github.com/orgs/${org.githubOrgName}/repos`,
      {
        method: 'POST',
        headers: {
          Accept: 'application/vnd.github+json',
          Authorization: `Bearer ${token}`,
          'X-GitHub-Api-Version': '2022-11-28',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          name: repoName,
          description: `LDV-Bridge managed: ${app.name} (${app.platform})`,
          private: true,
          auto_init: true, // Initialize with README
        }),
      },
    );

    // If org endpoint fails (404 = not an org), try user endpoint
    if (!response.ok && response.status === 404) {
      this.logger.log(
        `Org endpoint failed, trying user repos endpoint for ${org.githubOrgName}`,
      );

      response = await fetch(`https://api.github.com/user/repos`, {
        method: 'POST',
        headers: {
          Accept: 'application/vnd.github+json',
          Authorization: `Bearer ${token}`,
          'X-GitHub-Api-Version': '2022-11-28',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          name: repoName,
          description: `LDV-Bridge managed: ${app.name} (${app.platform})`,
          private: true,
          auto_init: true,
        }),
      });
    }

    // Handle "name already exists" error - fetch existing repo instead
    if (!response.ok && response.status === 422) {
      const error = await response.json();
      const nameExistsError = error.errors?.some(
        (e: any) => e.field === 'name' && e.message?.includes('already exists'),
      );

      if (nameExistsError) {
        this.logger.log(
          `Repository ${repoName} already exists, fetching existing repo...`,
        );

        // Fetch the existing repository
        const getRepoResponse = await fetch(
          `https://api.github.com/repos/${org.githubOrgName}/${repoName}`,
          {
            headers: {
              Accept: 'application/vnd.github+json',
              Authorization: `Bearer ${token}`,
              'X-GitHub-Api-Version': '2022-11-28',
            },
          },
        );

        if (getRepoResponse.ok) {
          const existingRepo: GitHubRepo = await getRepoResponse.json();

          // Update app with GitHub info
          await this.prisma.app.update({
            where: { id: app.id },
            data: {
              githubRepoId: existingRepo.node_id,
              githubRepoUrl: existingRepo.html_url,
              githubRepoName: existingRepo.name,
            },
          });

          this.logger.log(
            `Using existing GitHub repository for app ${app.id}: ${existingRepo.full_name}`,
          );
          return existingRepo;
        }
      }

      // If we couldn't handle the error, throw it
      this.logger.error(
        `Failed to create repository: ${JSON.stringify(error)}`,
      );
      throw new HttpException(
        error.message || 'Failed to create GitHub repository',
        HttpStatus.BAD_GATEWAY,
      );
    }

    if (!response.ok) {
      const error = await response.json();
      this.logger.error(
        `Failed to create repository: ${JSON.stringify(error)}`,
      );
      throw new HttpException(
        error.message || 'Failed to create GitHub repository',
        HttpStatus.BAD_GATEWAY,
      );
    }

    const repo: GitHubRepo = await response.json();

    // Update app with GitHub info
    await this.prisma.app.update({
      where: { id: app.id },
      data: {
        githubRepoId: repo.node_id,
        githubRepoUrl: repo.html_url,
        githubRepoName: repo.name,
      },
    });

    this.logger.log(
      `Created GitHub repository for app ${app.id}: ${repo.full_name}`,
    );
    return repo;
  }

  /**
   * Delete the GitHub repository for an app
   */
  async deleteAppRepository(app: App): Promise<void> {
    if (!app.githubRepoName) {
      return;
    }

    const org = await this.prisma.organization.findUnique({
      where: { id: app.organizationId },
    });

    if (!org?.githubOrgName) {
      return;
    }

    const token = await this.getInstallationToken(app.organizationId);

    const response = await fetch(
      `https://api.github.com/repos/${org.githubOrgName}/${app.githubRepoName}`,
      {
        method: 'DELETE',
        headers: {
          Accept: 'application/vnd.github+json',
          Authorization: `Bearer ${token}`,
          'X-GitHub-Api-Version': '2022-11-28',
        },
      },
    );

    if (!response.ok && response.status !== 404) {
      const error = await response.text();
      this.logger.error(`Failed to delete repository: ${error}`);
    }

    // Clear GitHub info from app
    await this.prisma.app.update({
      where: { id: app.id },
      data: {
        githubRepoId: null,
        githubRepoUrl: null,
        githubRepoName: null,
      },
    });

    this.logger.log(`Deleted GitHub repository for app ${app.id}`);
  }

  // ========================================
  // COMMIT & FILE OPERATIONS
  // ========================================

  /**
   * Commit extracted app content to the repository
   */
  async commitAppSnapshot(
    app: App,
    extractedPath: string,
    message: string,
    branch?: string,
  ): Promise<GitHubCommit> {
    const org = await this.prisma.organization.findUnique({
      where: { id: app.organizationId },
    });

    if (!org?.githubOrgName || !app.githubRepoName) {
      throw new HttpException(
        'GitHub repository not configured for this app',
        HttpStatus.BAD_REQUEST,
      );
    }

    let token = await this.getInstallationToken(app.organizationId);
    const repoFullName = `${org.githubOrgName}/${app.githubRepoName}`;

    this.logger.log(`[COMMIT] Committing to repo: ${repoFullName}`);
    this.logger.log(
      `[COMMIT] GitHub org: ${org.githubOrgName}, Installation ID: ${org.githubInstallationId}`,
    );

    // Check if repo exists first
    try {
      const repoCheck = await fetch(
        `https://api.github.com/repos/${repoFullName}`,
        {
          headers: {
            Accept: 'application/vnd.github+json',
            Authorization: `Bearer ${token}`,
            'X-GitHub-Api-Version': '2022-11-28',
          },
        },
      );
      if (!repoCheck.ok) {
        const errorData = await repoCheck.json();
        this.logger.warn(
          `[COMMIT] Repository ${repoFullName} not accessible: ${repoCheck.status} - ${errorData.message}`,
        );

        // Try to create the repository if it doesn't exist
        if (repoCheck.status === 404) {
          this.logger.log(
            `[COMMIT] Repository not found, attempting to create it...`,
          );
          try {
            await this.createAppRepository(app);
            this.logger.log(
              `[COMMIT] Successfully created repository ${repoFullName}`,
            );
            // Get fresh token after repo creation
            token = await this.getInstallationToken(app.organizationId);
          } catch (createError) {
            this.logger.error(
              `[COMMIT] Failed to create repository: ${createError.message}`,
            );
            throw new HttpException(
              `Repository ${repoFullName} not found and could not be created: ${createError.message}`,
              HttpStatus.NOT_FOUND,
            );
          }
        } else {
          throw new HttpException(
            `Repository ${repoFullName} not accessible. Please ensure the GitHub App has access to this repository.`,
            HttpStatus.FORBIDDEN,
          );
        }
      } else {
        this.logger.log(`[COMMIT] Repository ${repoFullName} is accessible`);
      }
    } catch (error) {
      if (error instanceof HttpException) throw error;
      this.logger.error(
        `[COMMIT] Failed to check repository: ${error.message}`,
      );
      throw error;
    }

    // Get actual default branch from repo if not specified
    let targetBranch = branch;
    if (!targetBranch) {
      const repoInfo = await this.getRepoInfo(repoFullName, token);
      targetBranch = repoInfo.default_branch || 'main';
      this.logger.debug(`[COMMIT] Using default branch: ${targetBranch}`);
    }

    // Try to get the current branch ref; if it fails (empty repo), we'll create an orphan commit
    let branchRef: string | null = null;
    let baseTreeSha: string | null = null;

    try {
      branchRef = await this.getBranchRef(repoFullName, targetBranch, token);
      baseTreeSha = await this.getTreeSha(repoFullName, branchRef, token);
    } catch (error) {
      this.logger.log(
        `Branch ${targetBranch} not found, will create initial commit`,
      );
      // Empty repo - we'll create an orphan commit
    }

    // Create tree from files (pass organizationId for token refresh during long operations)
    const tree = await this.createTreeFromDirectory(
      repoFullName,
      extractedPath,
      baseTreeSha, // null for empty repo
      app.organizationId,
    );

    // Refresh token before commit (in case tree creation took a while)
    const commitToken = await this.getInstallationToken(app.organizationId);

    // Create commit
    const commit = await this.createCommit(
      repoFullName,
      tree.sha,
      branchRef, // null for empty repo (orphan commit)
      message,
      commitToken,
    );

    // Update or create branch reference
    if (branchRef) {
      await this.updateBranchRef(
        repoFullName,
        targetBranch,
        commit.sha,
        commitToken,
      );
    } else {
      // Create new branch for empty repo
      await this.createBranchRef(
        repoFullName,
        targetBranch,
        commit.sha,
        commitToken,
      );
    }

    this.logger.log(`Committed app snapshot for ${app.id}: ${commit.sha}`);
    return commit;
  }

  /**
   * Get repository info including default branch
   */
  private async getRepoInfo(
    repoFullName: string,
    token: string,
  ): Promise<{ default_branch: string; [key: string]: any }> {
    this.logger.debug(`[REPO INFO] Fetching info for: ${repoFullName}`);

    const response = await fetch(
      `https://api.github.com/repos/${repoFullName}`,
      {
        headers: {
          Accept: 'application/vnd.github+json',
          Authorization: `Bearer ${token}`,
          'X-GitHub-Api-Version': '2022-11-28',
        },
      },
    );

    if (!response.ok) {
      const errorBody = await response.text();
      this.logger.error(
        `[REPO INFO] Failed: ${response.status} - ${errorBody}`,
      );
      throw new HttpException(
        `Failed to get repository info`,
        HttpStatus.BAD_GATEWAY,
      );
    }

    return response.json();
  }

  /**
   * Create a new branch reference (for empty repos)
   */
  private async createBranchRef(
    repoFullName: string,
    branch: string,
    sha: string,
    token: string,
  ): Promise<void> {
    const response = await fetch(
      `https://api.github.com/repos/${repoFullName}/git/refs`,
      {
        method: 'POST',
        headers: {
          Accept: 'application/vnd.github+json',
          Authorization: `Bearer ${token}`,
          'X-GitHub-Api-Version': '2022-11-28',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          ref: `refs/heads/${branch}`,
          sha,
        }),
      },
    );

    if (!response.ok) {
      const error = await response.json();
      this.logger.error(`Failed to create branch: ${JSON.stringify(error)}`);
      throw new HttpException(
        error.message || 'Failed to create branch',
        HttpStatus.BAD_GATEWAY,
      );
    }

    this.logger.log(`Created branch ${branch} for repo ${repoFullName}`);
  }

  // ========================================
  // BRANCH MANAGEMENT (SANDBOXES)
  // ========================================

  /**
   * Create a branch for a sandbox
   */
  async createSandboxBranch(sandbox: Sandbox): Promise<GitHubBranch> {
    if (!sandbox.appId) {
      throw new HttpException(
        'Sandbox must be linked to an app to create a branch',
        HttpStatus.BAD_REQUEST,
      );
    }

    const app = await this.prisma.app.findUnique({
      where: { id: sandbox.appId },
    });

    if (!app?.githubRepoName) {
      throw new HttpException(
        'App does not have a GitHub repository',
        HttpStatus.BAD_REQUEST,
      );
    }

    const org = await this.prisma.organization.findUnique({
      where: { id: sandbox.organizationId },
    });

    if (!org?.githubOrgName) {
      throw new HttpException('GitHub not connected', HttpStatus.BAD_REQUEST);
    }

    const token = await this.getInstallationToken(sandbox.organizationId);
    const repoFullName = `${org.githubOrgName}/${app.githubRepoName}`;
    const branchName = `sandbox/${sandbox.name.replace(' ', '-')}`; //replace spaces with -

    // Get main branch SHA
    const mainSha = await this.getBranchRef(repoFullName, 'main', token);

    // Create branch
    const response = await fetch(
      `https://api.github.com/repos/${repoFullName}/git/refs`,
      {
        method: 'POST',
        headers: {
          Accept: 'application/vnd.github+json',
          Authorization: `Bearer ${token}`,
          'X-GitHub-Api-Version': '2022-11-28',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          ref: `refs/heads/${branchName}`,
          sha: mainSha,
        }),
      },
    );

    if (!response.ok) {
      const error = await response.json();
      throw new HttpException(
        error.message || 'Failed to create branch',
        HttpStatus.BAD_GATEWAY,
      );
    }

    // Update sandbox with branch name
    await this.prisma.sandbox.update({
      where: { id: sandbox.id },
      data: { githubBranch: branchName },
    });

    this.logger.log(`Created branch ${branchName} for sandbox ${sandbox.id}`);

    return {
      name: branchName,
      commit: { sha: mainSha },
      protected: false,
    };
  }

  /**
   * Delete sandbox branch
   */
  async deleteSandboxBranch(sandbox: Sandbox): Promise<void> {
    if (!sandbox.githubBranch || !sandbox.appId) {
      return;
    }

    const app = await this.prisma.app.findUnique({
      where: { id: sandbox.appId },
    });

    if (!app?.githubRepoName) {
      return;
    }

    const org = await this.prisma.organization.findUnique({
      where: { id: sandbox.organizationId },
    });

    if (!org?.githubOrgName) {
      return;
    }

    const token = await this.getInstallationToken(sandbox.organizationId);
    const repoFullName = `${org.githubOrgName}/${app.githubRepoName}`;

    const response = await fetch(
      `https://api.github.com/repos/${repoFullName}/git/refs/heads/${sandbox.githubBranch}`,
      {
        method: 'DELETE',
        headers: {
          Accept: 'application/vnd.github+json',
          Authorization: `Bearer ${token}`,
          'X-GitHub-Api-Version': '2022-11-28',
        },
      },
    );

    if (!response.ok && response.status !== 404) {
      this.logger.warn(`Failed to delete branch ${sandbox.githubBranch}`);
    }

    await this.prisma.sandbox.update({
      where: { id: sandbox.id },
      data: { githubBranch: null },
    });
  }

  // ========================================
  // STAGING BRANCHES (CHANGE SYNC)
  // ========================================

  /**
   * Generate staging branch name from a change title
   * Sanitizes the title: lowercase, spaces to hyphens, remove special chars, max 75 chars
   */
  getStagingBranchName(changeTitle: string): string {
    // Sanitize: lowercase, replace spaces with hyphens, remove special chars
    const sanitized = changeTitle
      .toLowerCase()
      .trim()
      .replace(/\s+/g, '-')
      .replace(/[^a-z0-9-]/g, '')
      .replace(/-+/g, '-') // Remove consecutive hyphens
      .replace(/^-|-$/g, '') // Remove leading/trailing hyphens
      .slice(0, 75);

    // Fallback if sanitization results in empty string
    if (!sanitized) {
      return `staging/change-${Date.now()}`;
    }

    return `staging/${sanitized}`;
  }

  /**
   * Commit app snapshot to a staging branch for review
   * Creates the staging branch if it doesn't exist
   * @param changeTitle - User-provided title for this change (used to create branch name)
   */
  async commitToStagingBranch(
    app: App,
    extractedPath: string,
    changeTitle: string,
    message: string,
  ): Promise<{ commit: GitHubCommit; branch: string }> {
    const org = await this.prisma.organization.findUnique({
      where: { id: app.organizationId },
    });

    if (!org?.githubOrgName || !app.githubRepoName) {
      throw new HttpException(
        'GitHub repository not configured for this app',
        HttpStatus.BAD_REQUEST,
      );
    }

    const token = await this.getInstallationToken(app.organizationId);
    const repoFullName = `${org.githubOrgName}/${app.githubRepoName}`;
    const stagingBranch = this.getStagingBranchName(changeTitle);

    // Check if branch already exists - if so, return conflict error
    try {
      await this.getBranchRef(repoFullName, stagingBranch, token);
      // If we get here, branch exists
      throw new HttpException(
        'A change with this title already exists. Please choose a different title.',
        HttpStatus.CONFLICT,
      );
    } catch (error) {
      // If it's our conflict error, rethrow it
      if (
        error instanceof HttpException &&
        error.getStatus() === HttpStatus.CONFLICT
      ) {
        throw error;
      }
      // Otherwise, branch doesn't exist - this is expected, continue
    }

    // Get default branch SHA to base staging branch on
    const repoInfo = await this.getRepoInfo(repoFullName, token);
    const defaultBranch = repoInfo.default_branch || 'main';

    // Create staging branch from default
    let branchRef: string | null = null;
    let baseTreeSha: string | null = null;

    this.logger.log(
      `[STAGING] Creating staging branch ${stagingBranch} from ${defaultBranch}`,
    );
    try {
      const defaultRef = await this.getBranchRef(
        repoFullName,
        defaultBranch,
        token,
      );
      await this.createBranchRef(
        repoFullName,
        stagingBranch,
        defaultRef,
        token,
      );
      branchRef = defaultRef;
      baseTreeSha = await this.getTreeSha(repoFullName, branchRef, token);
    } catch (createError) {
      this.logger.warn(
        `[STAGING] Could not create from ${defaultBranch}, creating orphan branch`,
      );
      // Default branch might not exist (empty repo), create orphan
    }

    // Create tree from files
    const tree = await this.createTreeFromDirectory(
      repoFullName,
      extractedPath,
      baseTreeSha,
      token,
    );

    // Create commit
    const commit = await this.createCommit(
      repoFullName,
      tree.sha,
      branchRef,
      message,
      token,
    );

    // Update or create branch reference
    if (branchRef) {
      await this.updateBranchRef(
        repoFullName,
        stagingBranch,
        commit.sha,
        token,
      );
    } else {
      await this.createBranchRef(
        repoFullName,
        stagingBranch,
        commit.sha,
        token,
      );
    }

    this.logger.log(`[STAGING] Committed to ${stagingBranch}: ${commit.sha}`);

    return { commit, branch: stagingBranch };
  }

  /**
   * Merge staging branch to main (called when review is approved)
   */
  async mergeStagingToMain(
    app: App,
    changeId: string,
    commitMessage: string,
  ): Promise<{ merged: boolean; sha?: string }> {
    const org = await this.prisma.organization.findUnique({
      where: { id: app.organizationId },
    });

    if (!org?.githubOrgName || !app.githubRepoName) {
      throw new HttpException(
        'GitHub repository not configured for this app',
        HttpStatus.BAD_REQUEST,
      );
    }

    const token = await this.getInstallationToken(app.organizationId);
    const repoFullName = `${org.githubOrgName}/${app.githubRepoName}`;
    const stagingBranch = this.getStagingBranchName(changeId);

    // Get default branch
    const repoInfo = await this.getRepoInfo(repoFullName, token);
    const defaultBranch = repoInfo.default_branch || 'main';

    // Merge staging into main
    const response = await fetch(
      `https://api.github.com/repos/${repoFullName}/merges`,
      {
        method: 'POST',
        headers: {
          Accept: 'application/vnd.github+json',
          Authorization: `Bearer ${token}`,
          'X-GitHub-Api-Version': '2022-11-28',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          base: defaultBranch,
          head: stagingBranch,
          commit_message: commitMessage,
        }),
      },
    );

    if (!response.ok) {
      const error = await response.json();

      // 409 means nothing to merge (already up to date)
      if (response.status === 409) {
        this.logger.log(
          `[STAGING] Branch ${stagingBranch} already merged or up to date`,
        );
        return { merged: true };
      }

      this.logger.error(`[STAGING] Merge failed: ${JSON.stringify(error)}`);
      throw new HttpException(
        error.message || 'Failed to merge staging branch',
        HttpStatus.BAD_GATEWAY,
      );
    }

    const mergeResult = await response.json();
    this.logger.log(
      `[STAGING] Merged ${stagingBranch} to ${defaultBranch}: ${mergeResult.sha}`,
    );

    // Delete staging branch after successful merge
    await this.deleteBranch(repoFullName, stagingBranch, token);

    return { merged: true, sha: mergeResult.sha };
  }

  /**
   * Delete a branch
   */
  private async deleteBranch(
    repoFullName: string,
    branch: string,
    token: string,
  ): Promise<void> {
    const response = await fetch(
      `https://api.github.com/repos/${repoFullName}/git/refs/heads/${branch}`,
      {
        method: 'DELETE',
        headers: {
          Accept: 'application/vnd.github+json',
          Authorization: `Bearer ${token}`,
          'X-GitHub-Api-Version': '2022-11-28',
        },
      },
    );

    if (!response.ok && response.status !== 404) {
      this.logger.warn(`[STAGING] Failed to delete branch ${branch}`);
    } else {
      this.logger.log(`[STAGING] Deleted branch ${branch}`);
    }
  }

  // ========================================
  // PULL REQUESTS (REVIEWS)
  // ========================================

  /**
   * Create a pull request for a review
   */
  async createReviewPR(
    review: Review,
    change: { id: string; appId: string; title: string; description?: string },
    sandboxBranch: string,
  ): Promise<GitHubPullRequest> {
    const app = await this.prisma.app.findUnique({
      where: { id: change.appId },
    });

    if (!app?.githubRepoName) {
      throw new HttpException(
        'App does not have a GitHub repository',
        HttpStatus.BAD_REQUEST,
      );
    }

    const org = await this.prisma.organization.findUnique({
      where: { id: app.organizationId },
    });

    if (!org?.githubOrgName) {
      throw new HttpException('GitHub not connected', HttpStatus.BAD_REQUEST);
    }

    const token = await this.getInstallationToken(app.organizationId);
    const repoFullName = `${org.githubOrgName}/${app.githubRepoName}`;

    const response = await fetch(
      `https://api.github.com/repos/${repoFullName}/pulls`,
      {
        method: 'POST',
        headers: {
          Accept: 'application/vnd.github+json',
          Authorization: `Bearer ${token}`,
          'X-GitHub-Api-Version': '2022-11-28',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          title: `[LDV-Bridge] ${change.title}`,
          body: change.description || 'Change requested via LDV-Bridge',
          head: sandboxBranch,
          base: 'main',
        }),
      },
    );

    if (!response.ok) {
      const error = await response.json();
      throw new HttpException(
        error.message || 'Failed to create pull request',
        HttpStatus.BAD_GATEWAY,
      );
    }

    const pr: GitHubPullRequest = await response.json();

    // Update review with PR info
    await this.prisma.review.update({
      where: { id: review.id },
      data: {
        githubPrNumber: pr.number,
        githubPrUrl: pr.html_url,
      },
    });

    this.logger.log(`Created PR #${pr.number} for review ${review.id}`);
    return pr;
  }

  /**
   * Merge a pull request
   */
  async mergePR(
    prNumber: number,
    repoFullName: string,
    organizationId: string,
    mergeMethod: 'merge' | 'squash' | 'rebase' = 'squash',
  ): Promise<void> {
    const token = await this.getInstallationToken(organizationId);

    const response = await fetch(
      `https://api.github.com/repos/${repoFullName}/pulls/${prNumber}/merge`,
      {
        method: 'PUT',
        headers: {
          Accept: 'application/vnd.github+json',
          Authorization: `Bearer ${token}`,
          'X-GitHub-Api-Version': '2022-11-28',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          merge_method: mergeMethod,
        }),
      },
    );

    if (!response.ok) {
      const error = await response.json();
      throw new HttpException(
        error.message || 'Failed to merge pull request',
        HttpStatus.BAD_GATEWAY,
      );
    }

    this.logger.log(`Merged PR #${prNumber} in ${repoFullName}`);
  }

  /**
   * Close a pull request without merging
   */
  async closePR(
    prNumber: number,
    repoFullName: string,
    organizationId: string,
  ): Promise<void> {
    const token = await this.getInstallationToken(organizationId);

    const response = await fetch(
      `https://api.github.com/repos/${repoFullName}/pulls/${prNumber}`,
      {
        method: 'PATCH',
        headers: {
          Accept: 'application/vnd.github+json',
          Authorization: `Bearer ${token}`,
          'X-GitHub-Api-Version': '2022-11-28',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          state: 'closed',
        }),
      },
    );

    if (!response.ok) {
      const error = await response.json();
      throw new HttpException(
        error.message || 'Failed to close pull request',
        HttpStatus.BAD_GATEWAY,
      );
    }
  }

  // ========================================
  // DIFF & COMPARISON
  // ========================================

  /**
   * Get file diffs between two branches/commits
   */
  async getFileDiff(
    repoFullName: string,
    base: string,
    head: string,
    organizationId: string,
  ): Promise<FileDiff[]> {
    const token = await this.getInstallationToken(organizationId);

    const response = await fetch(
      `https://api.github.com/repos/${repoFullName}/compare/${base}...${head}`,
      {
        headers: {
          Accept: 'application/vnd.github+json',
          Authorization: `Bearer ${token}`,
          'X-GitHub-Api-Version': '2022-11-28',
        },
      },
    );

    if (!response.ok) {
      const error = await response.json();
      throw new HttpException(
        error.message || 'Failed to get diff',
        HttpStatus.BAD_GATEWAY,
      );
    }

    const data = await response.json();
    return data.files.map((f: any) => ({
      filename: f.filename,
      status: f.status,
      additions: f.additions,
      deletions: f.deletions,
      patch: f.patch,
    }));
  }

  /**
   * Get file content at a specific commit SHA
   */
  async getFileContentAtCommit(
    repoFullName: string,
    filePath: string,
    commitSha: string,
    organizationId: string,
  ): Promise<string | null> {
    try {
      const token = await this.getInstallationToken(organizationId);

      const response = await fetch(
        `https://api.github.com/repos/${repoFullName}/contents/${filePath}?ref=${commitSha}`,
        {
          headers: {
            Accept: 'application/vnd.github.raw+json',
            Authorization: `Bearer ${token}`,
            'X-GitHub-Api-Version': '2022-11-28',
          },
        },
      );

      if (!response.ok) {
        if (response.status === 404) {
          return null; // File doesn't exist at this commit
        }
        throw new Error(`Failed to fetch file: ${response.statusText}`);
      }

      return await response.text();
    } catch (error) {
      this.logger.warn(
        `Failed to get file content at ${commitSha}: ${error.message}`,
      );
      return null;
    }
  }

  /**
   * Get raw diff content between two commits (unified diff format)
   */
  async getRawDiff(
    repoFullName: string,
    base: string,
    head: string,
    organizationId: string,
  ): Promise<string> {
    const token = await this.getInstallationToken(organizationId);

    const response = await fetch(
      `https://api.github.com/repos/${repoFullName}/compare/${base}...${head}`,
      {
        headers: {
          Accept: 'application/vnd.github.diff',
          Authorization: `Bearer ${token}`,
          'X-GitHub-Api-Version': '2022-11-28',
        },
      },
    );

    if (!response.ok) {
      const error = await response.text();
      throw new HttpException(
        error || 'Failed to get raw diff',
        HttpStatus.BAD_GATEWAY,
      );
    }

    return await response.text();
  }

  // ========================================
  // HELPER METHODS
  // ========================================

  private generateRepoName(appName: string): string {
    // Convert to lowercase, replace spaces with hyphens, remove special chars
    const slug = appName
      .toLowerCase()
      .replace(/\s+/g, '-')
      .replace(/[^a-z0-9-]/g, '')
      .slice(0, 50);
    return `ldvbridge-${slug}`;
  }

  private async getBranchRef(
    repoFullName: string,
    branch: string,
    token: string,
    maxRetries: number = 3,
  ): Promise<string> {
    // Retry logic for newly created repos where branch may not be immediately available
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      const response = await fetch(
        `https://api.github.com/repos/${repoFullName}/git/refs/heads/${branch}`,
        {
          headers: {
            Accept: 'application/vnd.github+json',
            Authorization: `Bearer ${token}`,
            'X-GitHub-Api-Version': '2022-11-28',
          },
        },
      );

      if (response.ok) {
        const data = await response.json();
        return data.object.sha;
      }

      // If not found and we have retries left, wait and try again
      if (response.status === 404 && attempt < maxRetries) {
        this.logger.log(
          `Branch ${branch} not found (attempt ${attempt}/${maxRetries}), waiting...`,
        );
        await new Promise((resolve) => setTimeout(resolve, 2000)); // Wait 2 seconds
        continue;
      }

      throw new HttpException(
        `Branch ${branch} not found`,
        HttpStatus.NOT_FOUND,
      );
    }

    throw new HttpException(
      `Branch ${branch} not found after ${maxRetries} attempts`,
      HttpStatus.NOT_FOUND,
    );
  }

  private async getTreeSha(
    repoFullName: string,
    commitSha: string,
    token: string,
  ): Promise<string> {
    const response = await fetch(
      `https://api.github.com/repos/${repoFullName}/git/commits/${commitSha}`,
      {
        headers: {
          Accept: 'application/vnd.github+json',
          Authorization: `Bearer ${token}`,
          'X-GitHub-Api-Version': '2022-11-28',
        },
      },
    );

    if (!response.ok) {
      throw new HttpException('Failed to get commit', HttpStatus.BAD_GATEWAY);
    }

    const data = await response.json();
    return data.tree.sha;
  }

  /**
   * Check if a file is binary based on extension
   */
  private isBinaryFile(filePath: string): boolean {
    const binaryExtensions = [
      '.mxunit',
      '.mpr',
      '.mpk',
      '.png',
      '.jpg',
      '.jpeg',
      '.gif',
      '.ico',
      '.svg',
      '.woff',
      '.woff2',
      '.ttf',
      '.eot',
      '.pdf',
      '.zip',
      '.jar',
      '.class',
      '.exe',
      '.dll',
      '.so',
      '.dylib',
    ];
    const ext = path.extname(filePath).toLowerCase();
    return binaryExtensions.includes(ext);
  }

  /**
   * Create a blob for a file (needed for binary files)
   */
  private async createBlob(
    repoFullName: string,
    content: string,
    encoding: 'utf-8' | 'base64',
    token: string,
  ): Promise<string> {
    const response = await fetch(
      `https://api.github.com/repos/${repoFullName}/git/blobs`,
      {
        method: 'POST',
        headers: {
          Accept: 'application/vnd.github+json',
          Authorization: `Bearer ${token}`,
          'X-GitHub-Api-Version': '2022-11-28',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ content, encoding }),
      },
    );

    if (!response.ok) {
      const error = await response.json();
      throw new HttpException(
        error.message || 'Failed to create blob',
        HttpStatus.BAD_GATEWAY,
      );
    }

    const data = await response.json();
    return data.sha;
  }

  private async createTreeFromDirectory(
    repoFullName: string,
    dirPath: string,
    baseTreeSha: string | null,
    organizationId: string,
  ): Promise<{ sha: string }> {
    const treeItems: any[] = [];
    const binaryFiles: { relativePath: string; content: string }[] = [];

    // Track files for logging
    let textFileCount = 0;
    let binaryFileCount = 0;

    // Get initial token
    let token = await this.getInstallationToken(organizationId);

    // First pass: collect all files (don't create blobs yet)
    const processDir = (currentPath: string, prefix: string = '') => {
      const entries = fs.readdirSync(currentPath, { withFileTypes: true });

      for (const entry of entries) {
        const fullPath = path.join(currentPath, entry.name);
        const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;

        if (entry.name.startsWith('.')) continue; // Skip hidden files

        if (entry.isDirectory()) {
          processDir(fullPath, relativePath);
        } else {
          // Check if binary file
          if (this.isBinaryFile(fullPath)) {
            binaryFileCount++;
            const content = fs.readFileSync(fullPath).toString('base64');
            binaryFiles.push({ relativePath, content });
          } else {
            // For text files, include content directly
            try {
              const content = fs.readFileSync(fullPath, 'utf8');
              textFileCount++;
              treeItems.push({
                path: relativePath,
                mode: '100644',
                type: 'blob',
                content,
              });
            } catch (readError) {
              // If UTF-8 read fails, treat as binary
              binaryFileCount++;
              const content = fs.readFileSync(fullPath).toString('base64');
              binaryFiles.push({ relativePath, content });
            }
          }
        }
      }
    };

    processDir(dirPath);

    this.logger.log(
      `[TREE] Processing ${textFileCount} text files and ${binaryFileCount} binary files`,
    );

    // Second pass: create blobs for binary files in small sequential batches
    const BATCH_SIZE = 10; // Smaller batches to avoid connection issues
    for (let i = 0; i < binaryFiles.length; i += BATCH_SIZE) {
      const batch = binaryFiles.slice(i, i + BATCH_SIZE);

      // Get fresh token for each batch
      token = await this.getInstallationToken(organizationId);

      // Process batch sequentially to avoid overwhelming connections
      for (const file of batch) {
        try {
          const sha = await this.createBlob(
            repoFullName,
            file.content,
            'base64',
            token,
          );
          treeItems.push({
            path: file.relativePath,
            mode: '100644',
            type: 'blob',
            sha,
          });
        } catch (blobError) {
          this.logger.error(
            `[TREE] Failed to create blob for ${file.relativePath}: ${(blobError as any).message}`,
          );
          throw blobError;
        }
      }

      if (i + BATCH_SIZE < binaryFiles.length) {
        this.logger.log(
          `[TREE] Created ${Math.min(i + BATCH_SIZE, binaryFiles.length)}/${binaryFiles.length} blobs...`,
        );
        // Small delay between batches to avoid rate limiting
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    }

    this.logger.log(
      `[TREE] All blobs created. Building tree with ${treeItems.length} items...`,
    );

    // Get fresh token before creating tree (blob creation might have taken a while)
    token = await this.getInstallationToken(organizationId);

    const response = await fetch(
      `https://api.github.com/repos/${repoFullName}/git/trees`,
      {
        method: 'POST',
        headers: {
          Accept: 'application/vnd.github+json',
          Authorization: `Bearer ${token}`,
          'X-GitHub-Api-Version': '2022-11-28',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          ...(baseTreeSha && { base_tree: baseTreeSha }),
          tree: treeItems,
        }),
      },
    );

    if (!response.ok) {
      const error = await response.json();
      throw new HttpException(
        error.message || 'Failed to create tree',
        HttpStatus.BAD_GATEWAY,
      );
    }

    return response.json();
  }

  private async createCommit(
    repoFullName: string,
    treeSha: string,
    parentSha: string | null,
    message: string,
    token: string,
  ): Promise<GitHubCommit> {
    const response = await fetch(
      `https://api.github.com/repos/${repoFullName}/git/commits`,
      {
        method: 'POST',
        headers: {
          Accept: 'application/vnd.github+json',
          Authorization: `Bearer ${token}`,
          'X-GitHub-Api-Version': '2022-11-28',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          message,
          tree: treeSha,
          ...(parentSha && { parents: [parentSha] }),
        }),
      },
    );

    if (!response.ok) {
      const error = await response.json();
      throw new HttpException(
        error.message || 'Failed to create commit',
        HttpStatus.BAD_GATEWAY,
      );
    }

    return response.json();
  }

  private async updateBranchRef(
    repoFullName: string,
    branch: string,
    sha: string,
    token: string,
  ): Promise<void> {
    const response = await fetch(
      `https://api.github.com/repos/${repoFullName}/git/refs/heads/${branch}`,
      {
        method: 'PATCH',
        headers: {
          Accept: 'application/vnd.github+json',
          Authorization: `Bearer ${token}`,
          'X-GitHub-Api-Version': '2022-11-28',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          sha,
          force: false,
        }),
      },
    );

    if (!response.ok) {
      const error = await response.json();
      throw new HttpException(
        error.message || 'Failed to update branch',
        HttpStatus.BAD_GATEWAY,
      );
    }
  }

  // ========================================
  // WORKFLOW DISPATCH
  // ========================================

  /**
   * Trigger a GitHub Actions workflow via workflow_dispatch event
   * @param repoFullName Repository full name (owner/repo)
   * @param workflowId Workflow filename or ID (e.g., 'lcnc-validation.yml')
   * @param ref Branch or tag to run the workflow on
   * @param inputs Workflow inputs (key-value pairs)
   * @param token Installation token
   * @returns Workflow run ID if available
   */
  async triggerWorkflowDispatch(
    repoFullName: string,
    workflowId: string,
    ref: string,
    inputs: Record<string, string> = {},
    token: string,
  ): Promise<{ triggered: boolean; runId?: string }> {
    this.logger.log(
      `Triggering workflow ${workflowId} on ${repoFullName}/${ref}`,
    );

    try {
      // POST /repos/{owner}/{repo}/actions/workflows/{workflow_id}/dispatches
      const response = await fetch(
        `https://api.github.com/repos/${repoFullName}/actions/workflows/${workflowId}/dispatches`,
        {
          method: 'POST',
          headers: {
            Accept: 'application/vnd.github+json',
            Authorization: `Bearer ${token}`,
            'X-GitHub-Api-Version': '2022-11-28',
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            ref,
            inputs,
          }),
        },
      );

      // GitHub returns 204 No Content on success
      if (response.status === 204) {
        this.logger.log(`Workflow ${workflowId} triggered successfully`);

        // GitHub doesn't return the run ID directly; we'd have to poll for it
        // For now, return that it was triggered
        return { triggered: true };
      }

      const error = await response.json().catch(() => ({}));
      this.logger.error(
        `Failed to trigger workflow: ${response.status} - ${JSON.stringify(error)}`,
      );

      return { triggered: false };
    } catch (error) {
      this.logger.error(`Error triggering workflow dispatch: ${error.message}`);
      return { triggered: false };
    }
  }

  /**
   * Convenience method: Trigger LdV-Bridge CI/CD workflow for a change
   * @param app The app containing the GitHub repo info
   * @param changeId The change ID to validate
   * @param branch The branch to run validation on
   * @param organizationId For getting installation token
   */
  async triggerValidationWorkflow(
    app: App,
    changeId: string,
    branch: string,
    organizationId: string,
  ): Promise<{ triggered: boolean; message: string }> {
    // Build repo full name from app's GitHub repo info
    // The format should be 'owner/repo'
    const repoFullName = app.githubRepoName;

    if (!repoFullName) {
      return {
        triggered: false,
        message: 'App does not have a GitHub repository configured',
      };
    }

    const token = await this.getInstallationToken(organizationId);

    const result = await this.triggerWorkflowDispatch(
      repoFullName,
      'lcnc-validation.yml',
      branch,
      { changeId },
      token,
    );

    if (result.triggered) {
      return {
        triggered: true,
        message: `Validation workflow triggered for change ${changeId}`,
      };
    }

    return {
      triggered: false,
      message: 'Failed to trigger validation workflow',
    };
  }
}

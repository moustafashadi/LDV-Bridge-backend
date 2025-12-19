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
      iat: now - 60, // 60 seconds in the past
      exp: now + 600, // 10 minutes
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
    branch: string = 'main',
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

    const token = await this.getInstallationToken(app.organizationId);
    const repoFullName = `${org.githubOrgName}/${app.githubRepoName}`;

    // Get the current commit SHA of the branch
    const branchRef = await this.getBranchRef(repoFullName, branch, token);
    const baseTreeSha = await this.getTreeSha(repoFullName, branchRef, token);

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

    // Update branch reference
    await this.updateBranchRef(repoFullName, branch, commit.sha, token);

    this.logger.log(`Committed app snapshot for ${app.id}: ${commit.sha}`);
    return commit;
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
    const branchName = `sandbox/${sandbox.id.slice(0, 8)}`;

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

  private async createTreeFromDirectory(
    repoFullName: string,
    dirPath: string,
    baseTreeSha: string,
    token: string,
  ): Promise<{ sha: string }> {
    const treeItems: any[] = [];

    const processDir = (currentPath: string, prefix: string = '') => {
      const entries = fs.readdirSync(currentPath, { withFileTypes: true });

      for (const entry of entries) {
        const fullPath = path.join(currentPath, entry.name);
        const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;

        if (entry.name.startsWith('.')) continue; // Skip hidden files

        if (entry.isDirectory()) {
          processDir(fullPath, relativePath);
        } else {
          const content = fs.readFileSync(fullPath, 'utf8');
          treeItems.push({
            path: relativePath,
            mode: '100644',
            type: 'blob',
            content,
          });
        }
      }
    };

    processDir(dirPath);

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
          base_tree: baseTreeSha,
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
    parentSha: string,
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
          parents: [parentSha],
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
}

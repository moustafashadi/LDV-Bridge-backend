import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { GitHubService } from '../github/github.service';
import { NotificationsService } from '../notifications/notifications.service';
import {
  PipelineWebhookDto,
  PipelineCheckResult,
} from './dto/pipeline-webhook.dto';

// Pipeline status enum matching Prisma schema
// Using local definition until Prisma client is regenerated
enum PipelineStatus {
  PENDING = 'PENDING',
  RUNNING = 'RUNNING',
  PASSED = 'PASSED',
  FAILED = 'FAILED',
}

/**
 * CI/CD Service
 * Manages CI/CD pipeline integration for sandbox validation.
 * Handles pipeline triggering, status updates, and result processing.
 */
@Injectable()
export class CicdService {
  private readonly logger = new Logger(CicdService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly githubService: GitHubService,
    private readonly notificationsService: NotificationsService,
  ) {}

  /**
   * Trigger validation pipeline for a sandbox change.
   * Creates a GitHub Actions workflow dispatch for the sandbox branch.
   */
  async triggerValidationPipeline(
    changeId: string,
    sandboxId: string,
    _organizationId: string,
  ): Promise<{ runId?: string; runUrl?: string }> {
    const change = await this.prisma.change.findUnique({
      where: { id: changeId },
      include: {
        app: true,
      },
    });

    if (!change) {
      throw new NotFoundException(`Change ${changeId} not found`);
    }

    // Get sandbox separately due to Prisma client not being regenerated
    const sandbox = await this.prisma.sandbox.findUnique({
      where: { id: sandboxId },
    });

    if (!sandbox) {
      throw new NotFoundException(
        `Sandbox ${sandboxId} not found for change ${changeId}`,
      );
    }

    const githubBranch = (sandbox as any).githubBranch;

    if (!githubBranch) {
      this.logger.warn(
        `No GitHub branch for sandbox ${sandboxId}, skipping pipeline trigger`,
      );
      return {};
    }

    // Update change to PENDING status
    await this.prisma.change.update({
      where: { id: changeId },
      data: {
        pipelineStatus: PipelineStatus.PENDING,
        pipelineStartedAt: new Date(),
        pipelineRunId: null,
        pipelineUrl: null,
        pipelineCompletedAt: null,
        pipelineResults: null,
      } as any,
    });

    // Trigger GitHub Actions workflow via workflow_dispatch
    const result = await this.githubService.triggerValidationWorkflow(
      change.app,
      changeId,
      githubBranch,
      change.app.organizationId,
    );

    if (result.triggered) {
      this.logger.log(
        `Validation pipeline triggered for change ${changeId} on branch ${githubBranch}`,
      );

      // Update status to RUNNING
      await this.prisma.change.update({
        where: { id: changeId },
        data: {
          pipelineStatus: PipelineStatus.RUNNING,
        } as any,
      });

      return {
        runId: undefined, // GitHub workflow_dispatch doesn't return run ID directly
        runUrl: undefined, // Would need to poll for this
      };
    }

    // Workflow dispatch failed
    this.logger.error(
      `Failed to trigger pipeline for change ${changeId}: ${result.message}`,
    );

    await this.prisma.change.update({
      where: { id: changeId },
      data: {
        pipelineStatus: PipelineStatus.FAILED,
        pipelineCompletedAt: new Date(),
        pipelineResults: {
          error: result.message,
        },
      } as any,
    });

    return {};
  }

  /**
   * Handle pipeline status update from webhook.
   * Updates Change record with pipeline status and results.
   */
  async handlePipelineUpdate(payload: PipelineWebhookDto): Promise<void> {
    const { changeId, status, runId, runUrl, checks, logs } = payload;

    const change = await this.prisma.change.findUnique({
      where: { id: changeId },
      include: {
        app: true,
        author: true,
      },
    });

    if (!change) {
      this.logger.warn(`Change ${changeId} not found for pipeline update`);
      return;
    }

    // Get sandbox if linked
    let sandbox: any = null;
    if ((change as any).sandboxId) {
      sandbox = await this.prisma.sandbox.findUnique({
        where: { id: (change as any).sandboxId },
        include: { createdBy: true },
      });
    }

    // Map webhook status to PipelineStatus enum
    const pipelineStatus = this.mapToPipelineStatus(status);
    const isCompleted = status === 'passed' || status === 'failed';

    // Build results object
    const pipelineResults = {
      checks: checks || [],
      logs: logs || null,
      updatedAt: new Date().toISOString(),
    };

    // Update change record
    await this.prisma.change.update({
      where: { id: changeId },
      data: {
        pipelineStatus,
        pipelineRunId: runId || (change as any).pipelineRunId,
        pipelineUrl: runUrl || (change as any).pipelineUrl,
        pipelineCompletedAt: isCompleted ? new Date() : null,
        pipelineResults: pipelineResults,
      } as any,
    });

    this.logger.log(
      `Updated pipeline status for change ${changeId}: ${status}`,
    );

    // Send notifications for completed pipelines
    if (isCompleted && sandbox?.createdBy) {
      await this.sendPipelineNotification(
        change,
        sandbox,
        pipelineStatus,
        checks,
      );
    }
  }

  /**
   * Handle GitHub workflow_run webhook event.
   * Extracts change info from workflow run and updates accordingly.
   */
  async handleGitHubWorkflowRun(payload: any): Promise<void> {
    const workflowRun = payload.workflow_run;
    if (!workflowRun) {
      this.logger.warn('No workflow_run in payload');
      return;
    }

    // Extract changeId from workflow run inputs or name
    // The workflow should pass changeId as an input or include it in the run name
    const changeId = this.extractChangeIdFromWorkflowRun(workflowRun);

    if (!changeId) {
      this.logger.debug(`No changeId found in workflow run ${workflowRun.id}`);
      return;
    }

    const status = workflowRun.conclusion || workflowRun.status;
    const runUrl = workflowRun.html_url;
    const runId = String(workflowRun.id);

    // Map GitHub conclusion to our status
    let mappedStatus: 'pending' | 'running' | 'passed' | 'failed';
    switch (status) {
      case 'success':
        mappedStatus = 'passed';
        break;
      case 'failure':
      case 'cancelled':
      case 'timed_out':
        mappedStatus = 'failed';
        break;
      case 'in_progress':
      case 'queued':
        mappedStatus = 'running';
        break;
      default:
        mappedStatus = 'pending';
    }

    await this.handlePipelineUpdate({
      changeId,
      status: mappedStatus,
      runId,
      runUrl,
    });
  }

  /**
   * Get pipeline status for a change.
   */
  async getPipelineStatus(changeId: string): Promise<{
    status: string | null;
    runId: string | null;
    runUrl: string | null;
    startedAt: Date | null;
    completedAt: Date | null;
    results: any | null;
  }> {
    const change = await this.prisma.change.findUnique({
      where: { id: changeId },
    });

    if (!change) {
      throw new NotFoundException(`Change ${changeId} not found`);
    }

    const changeAny = change as any;
    return {
      status: changeAny.pipelineStatus,
      runId: changeAny.pipelineRunId,
      runUrl: changeAny.pipelineUrl,
      startedAt: changeAny.pipelineStartedAt,
      completedAt: changeAny.pipelineCompletedAt,
      results: changeAny.pipelineResults,
    };
  }

  /**
   * Check if pipeline passed for a change.
   * Used by Reviews to gate approval.
   */
  async isPipelinePassed(changeId: string): Promise<boolean> {
    const change = await this.prisma.change.findUnique({
      where: { id: changeId },
    });

    return (change as any)?.pipelineStatus === PipelineStatus.PASSED;
  }

  /**
   * Helper: Map webhook status string to PipelineStatus enum.
   */
  private mapToPipelineStatus(status: string): PipelineStatus {
    switch (status) {
      case 'pending':
        return PipelineStatus.PENDING;
      case 'running':
        return PipelineStatus.RUNNING;
      case 'passed':
        return PipelineStatus.PASSED;
      case 'failed':
        return PipelineStatus.FAILED;
      default:
        return PipelineStatus.PENDING;
    }
  }

  /**
   * Helper: Extract changeId from GitHub workflow run.
   */
  private extractChangeIdFromWorkflowRun(workflowRun: any): string | null {
    // Try to get from inputs if workflow_dispatch
    if (workflowRun.inputs?.changeId) {
      return workflowRun.inputs.changeId;
    }

    // Try to extract from run name (e.g., "LCNC Validation - change-abc123")
    const match = workflowRun.name?.match(/change-([a-f0-9-]+)/i);
    if (match) {
      return match[1];
    }

    // Try to get from head_commit message
    const commitMatch = workflowRun.head_commit?.message?.match(
      /\[change:([a-f0-9-]+)\]/i,
    );
    if (commitMatch) {
      return commitMatch[1];
    }

    return null;
  }

  /**
   * Helper: Send notification about pipeline completion.
   */
  private async sendPipelineNotification(
    change: any,
    sandbox: any,
    status: PipelineStatus,
    checks?: PipelineCheckResult[],
  ): Promise<void> {
    const userId = sandbox?.createdBy?.id || change.author?.id;
    if (!userId) return;

    const isPassed = status === PipelineStatus.PASSED;
    const failedChecks = checks?.filter((c) => c.status === 'failed') || [];

    let message: string;
    if (isPassed) {
      message = `All validation checks passed for "${change.title}". Your changes are ready for review.`;
    } else {
      const failedNames = failedChecks.map((c) => c.name).join(', ');
      message = `Validation failed for "${change.title}". Failed checks: ${failedNames || 'Unknown'}. Please review and fix the issues.`;
    }

    await this.notificationsService.sendNotification({
      userId,
      type: isPassed ? 'DEPLOYMENT_SUCCESS' : 'DEPLOYMENT_FAILED',
      title: isPassed ? 'Validation Passed' : 'Validation Failed',
      message,
      data: {
        changeId: change.id,
        pipelineUrl: change.pipelineUrl,
      },
    });
  }
}

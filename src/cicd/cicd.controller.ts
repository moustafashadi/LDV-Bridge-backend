import {
  Controller,
  Post,
  Body,
  Headers,
  HttpCode,
  HttpStatus,
  Logger,
  UnauthorizedException,
  Req,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiBody } from '@nestjs/swagger';
import { CicdService } from './cicd.service';
import { PipelineWebhookDto } from './dto/pipeline-webhook.dto';
import { ConfigService } from '@nestjs/config';
import * as crypto from 'crypto';

/**
 * CI/CD Controller
 * Handles webhook callbacks from GitHub Actions pipelines reporting validation results.
 */
@ApiTags('CI/CD')
@Controller('cicd')
export class CicdController {
  private readonly logger = new Logger(CicdController.name);
  private readonly webhookSecret: string;

  constructor(
    private readonly cicdService: CicdService,
    private readonly configService: ConfigService,
  ) {
    this.webhookSecret =
      this.configService.get<string>('CICD_WEBHOOK_SECRET') || '';
  }

  /**
   * Verify GitHub webhook signature using HMAC-SHA256
   * @param payload Raw body as string
   * @param signature The x-hub-signature-256 header value
   * @returns true if signature is valid
   */
  private verifyGitHubSignature(payload: string, signature: string): boolean {
    if (!this.webhookSecret) {
      this.logger.warn(
        'No CICD_WEBHOOK_SECRET configured, skipping signature verification',
      );
      return true; // Skip verification if no secret configured
    }

    if (!signature) {
      return false;
    }

    // GitHub sends signature as 'sha256=<hash>'
    const [algorithm, hash] = signature.split('=');
    if (algorithm !== 'sha256' || !hash) {
      return false;
    }

    // Calculate expected signature
    const expectedSignature = crypto
      .createHmac('sha256', this.webhookSecret)
      .update(payload)
      .digest('hex');

    // Use timingSafeEqual to prevent timing attacks
    try {
      return crypto.timingSafeEqual(
        Buffer.from(hash, 'hex'),
        Buffer.from(expectedSignature, 'hex'),
      );
    } catch {
      return false;
    }
  }

  /**
   * Webhook endpoint for GitHub Actions pipeline status updates.
   * Called by the lcnc-validation.yml workflow to report check results.
   */
  @Post('webhook')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Receive pipeline status updates from GitHub Actions',
  })
  @ApiResponse({ status: 200, description: 'Webhook processed successfully' })
  @ApiResponse({ status: 401, description: 'Invalid webhook secret' })
  @ApiBody({ type: PipelineWebhookDto })
  async handlePipelineWebhook(
    @Body() payload: PipelineWebhookDto,
    @Headers('x-webhook-secret') secret?: string,
  ): Promise<{ received: boolean }> {
    // Validate webhook secret if configured
    if (this.webhookSecret && secret !== this.webhookSecret) {
      this.logger.warn('Invalid webhook secret received');
      throw new UnauthorizedException('Invalid webhook secret');
    }

    this.logger.log(
      `Received pipeline webhook for change ${payload.changeId}: ${payload.status}`,
    );

    await this.cicdService.handlePipelineUpdate(payload);

    return { received: true };
  }

  /**
   * GitHub webhook endpoint for workflow_run events.
   * Can be used instead of manual webhook calls from the workflow.
   */
  @Post('github-webhook')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Receive GitHub workflow_run webhook events' })
  @ApiResponse({ status: 200, description: 'Webhook processed successfully' })
  @ApiResponse({ status: 401, description: 'Invalid signature' })
  async handleGitHubWebhook(
    @Req() req: any,
    @Body() payload: any,
    @Headers('x-hub-signature-256') signature?: string,
    @Headers('x-github-event') event?: string,
  ): Promise<{ received: boolean }> {
    // Verify GitHub signature
    const rawBody = req.rawBody?.toString() || JSON.stringify(payload);
    if (!this.verifyGitHubSignature(rawBody, signature || '')) {
      this.logger.warn('Invalid GitHub webhook signature');
      throw new UnauthorizedException('Invalid webhook signature');
    }

    // Only process workflow_run events
    if (event !== 'workflow_run') {
      this.logger.debug(`Ignoring GitHub event: ${event}`);
      return { received: true };
    }

    this.logger.log(`Received GitHub workflow_run event: ${payload.action}`);

    if (payload.action === 'completed') {
      await this.cicdService.handleGitHubWorkflowRun(payload);
    }

    return { received: true };
  }
}

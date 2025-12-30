import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Body,
  Param,
  Query,
  UseGuards,
  HttpCode,
  HttpStatus,
  Sse,
  MessageEvent,
} from '@nestjs/common';
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiBearerAuth,
  ApiQuery,
} from '@nestjs/swagger';
import {
  Observable,
  map,
  interval,
  takeWhile,
  startWith,
  mergeMap,
  EMPTY,
} from 'rxjs';
import { SandboxesService } from './sandboxes.service';
import {
  SyncProgressService,
  SyncProgressEvent,
} from './sync-progress.service';
import { CreateSandboxDto } from './dto/create-sandbox.dto';
import { UpdateSandboxDto } from './dto/update-sandbox.dto';
import { LinkExistingEnvironmentDto } from './dto/link-existing-environment.dto';
import {
  SandboxResponseDto,
  SandboxStatsDto,
  ExtendExpirationDto,
  AssignUsersDto,
  UnassignUsersDto,
} from './dto/sandbox-response.dto';
import { CreateFeatureSandboxDto } from './dto/create-feature-sandbox.dto';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { Public } from '../auth/decorators/public.decorator';
import { UserRole } from '@prisma/client';
import {
  SandboxPlatform,
  SandboxStatus,
  SandboxType,
} from './interfaces/sandbox-environment.interface';

@ApiTags('Sandboxes')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Controller('sandboxes')
export class SandboxesController {
  constructor(
    private readonly sandboxesService: SandboxesService,
    private readonly syncProgressService: SyncProgressService,
  ) {}

  @Post()
  @ApiOperation({
    summary: 'Create a new sandbox with environment provisioning',
  })
  @ApiResponse({
    status: 201,
    description: 'Sandbox created and provisioning started',
    type: SandboxResponseDto,
  })
  @ApiResponse({ status: 400, description: 'Bad Request' })
  async create(
    @Body() createSandboxDto: CreateSandboxDto,
    @CurrentUser('id') userId: string,
    @CurrentUser('organizationId') organizationId: string,
  ): Promise<SandboxResponseDto> {
    return this.sandboxesService.create(
      createSandboxDto,
      userId,
      organizationId,
    );
  }

  @Post('link-existing')
  @ApiOperation({
    summary: 'Link an existing PowerApps/Mendix environment to LDV-Bridge',
  })
  @ApiResponse({
    status: 201,
    description: 'Existing environment linked successfully',
    type: SandboxResponseDto,
  })
  @ApiResponse({
    status: 400,
    description: 'Bad Request - Environment not found or invalid',
  })
  async linkExisting(
    @Body() linkDto: LinkExistingEnvironmentDto,
    @CurrentUser('id') userId: string,
    @CurrentUser('organizationId') organizationId: string,
  ): Promise<SandboxResponseDto> {
    return this.sandboxesService.linkExistingEnvironment(
      linkDto,
      userId,
      organizationId,
    );
  }

  @Get()
  @ApiOperation({ summary: 'List all sandboxes in organization' })
  @ApiQuery({ name: 'platform', enum: SandboxPlatform, required: false })
  @ApiQuery({ name: 'status', enum: SandboxStatus, required: false })
  @ApiQuery({ name: 'type', enum: SandboxType, required: false })
  @ApiQuery({ name: 'page', type: Number, required: false, example: 1 })
  @ApiQuery({ name: 'limit', type: Number, required: false, example: 20 })
  @ApiResponse({
    status: 200,
    description: 'List of sandboxes',
    type: [SandboxResponseDto],
  })
  async findAll(
    @CurrentUser('organizationId') organizationId: string,
    @Query('platform') platform?: SandboxPlatform,
    @Query('status') status?: SandboxStatus,
    @Query('type') type?: SandboxType,
    @Query('page') page?: number,
    @Query('limit') limit?: number,
  ): Promise<{ data: SandboxResponseDto[]; total: number }> {
    return this.sandboxesService.findAll(
      organizationId,
      { platform, status, type },
      page ? Number(page) : 1,
      limit ? Number(limit) : 20,
    );
  }

  @Get('my')
  @ApiOperation({ summary: 'List my sandboxes' })
  @ApiResponse({
    status: 200,
    description: 'List of user sandboxes',
    type: [SandboxResponseDto],
  })
  async findMy(
    @CurrentUser('id') userId: string,
    @CurrentUser('organizationId') organizationId: string,
  ): Promise<{ data: SandboxResponseDto[]; total: number }> {
    return this.sandboxesService.findAll(organizationId, { userId });
  }

  @Get('review-queue')
  @Roles(UserRole.PRO_DEVELOPER, UserRole.ADMIN)
  @ApiOperation({
    summary: 'Get sandboxes pending review (Pro Developer queue)',
    description:
      'Returns sandboxes with PENDING_REVIEW status, enriched with change details, review assignments, and SLA information',
  })
  @ApiQuery({
    name: 'page',
    type: Number,
    required: false,
    example: 1,
  })
  @ApiQuery({
    name: 'limit',
    type: Number,
    required: false,
    example: 20,
  })
  @ApiResponse({
    status: 200,
    description: 'Review queue items',
  })
  async getReviewQueue(
    @CurrentUser('organizationId') organizationId: string,
    @CurrentUser('id') userId: string,
    @Query('page') page?: number,
    @Query('limit') limit?: number,
  ) {
    return this.sandboxesService.getReviewQueue(
      organizationId,
      userId,
      page ? Number(page) : 1,
      limit ? Number(limit) : 20,
    );
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get sandbox by ID' })
  @ApiResponse({
    status: 200,
    description: 'Sandbox details',
    type: SandboxResponseDto,
  })
  @ApiResponse({ status: 404, description: 'Sandbox not found' })
  async findOne(
    @Param('id') id: string,
    @CurrentUser('organizationId') organizationId: string,
  ): Promise<SandboxResponseDto> {
    return this.sandboxesService.findOne(id, organizationId);
  }

  @Get(':id/review-details')
  @Roles(UserRole.PRO_DEVELOPER, UserRole.ADMIN)
  @ApiOperation({
    summary: 'Get sandbox review details for Pro Developer review page',
    description:
      'Returns comprehensive data including sandbox, latest change with diff, review assignment, comments, and submitter stats',
  })
  @ApiResponse({
    status: 200,
    description: 'Sandbox review details',
  })
  @ApiResponse({ status: 404, description: 'Sandbox not found' })
  async getReviewDetails(
    @Param('id') id: string,
    @CurrentUser('id') userId: string,
    @CurrentUser('organizationId') organizationId: string,
  ) {
    return this.sandboxesService.getReviewDetails(id, userId, organizationId);
  }

  @Patch(':id')
  @ApiOperation({ summary: 'Update sandbox' })
  @ApiResponse({
    status: 200,
    description: 'Sandbox updated',
    type: SandboxResponseDto,
  })
  @ApiResponse({ status: 404, description: 'Sandbox not found' })
  async update(
    @Param('id') id: string,
    @Body() updateSandboxDto: UpdateSandboxDto,
    @CurrentUser('id') userId: string,
    @CurrentUser('organizationId') organizationId: string,
  ): Promise<SandboxResponseDto> {
    return this.sandboxesService.update(
      id,
      organizationId,
      updateSandboxDto,
      userId,
    );
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Delete sandbox and deprovision environment' })
  @ApiResponse({ status: 204, description: 'Sandbox deleted' })
  @ApiResponse({ status: 404, description: 'Sandbox not found' })
  async remove(
    @Param('id') id: string,
    @CurrentUser('id') userId: string,
    @CurrentUser('organizationId') organizationId: string,
  ): Promise<void> {
    return this.sandboxesService.remove(id, organizationId, userId);
  }

  @Post(':id/start')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Start sandbox environment' })
  @ApiResponse({ status: 204, description: 'Sandbox started' })
  @ApiResponse({ status: 404, description: 'Sandbox not found' })
  async start(
    @Param('id') id: string,
    @CurrentUser('id') userId: string,
    @CurrentUser('organizationId') organizationId: string,
  ): Promise<void> {
    return this.sandboxesService.start(id, organizationId, userId);
  }

  @Post(':id/stop')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Stop sandbox environment' })
  @ApiResponse({ status: 204, description: 'Sandbox stopped' })
  @ApiResponse({ status: 404, description: 'Sandbox not found' })
  async stop(
    @Param('id') id: string,
    @CurrentUser('id') userId: string,
    @CurrentUser('organizationId') organizationId: string,
  ): Promise<void> {
    return this.sandboxesService.stop(id, organizationId, userId);
  }

  @Get(':id/stats')
  @ApiOperation({ summary: 'Get sandbox resource usage statistics' })
  @ApiResponse({
    status: 200,
    description: 'Sandbox statistics',
    type: SandboxStatsDto,
  })
  @ApiResponse({ status: 404, description: 'Sandbox not found' })
  async getStats(
    @Param('id') id: string,
    @CurrentUser('organizationId') organizationId: string,
  ): Promise<SandboxStatsDto> {
    return this.sandboxesService.getStats(id, organizationId);
  }

  @Post(':id/extend')
  @ApiOperation({ summary: 'Extend sandbox expiration date' })
  @ApiResponse({
    status: 200,
    description: 'Expiration extended',
    type: SandboxResponseDto,
  })
  @ApiResponse({ status: 404, description: 'Sandbox not found' })
  async extendExpiration(
    @Param('id') id: string,
    @Body() dto: ExtendExpirationDto,
    @CurrentUser('id') userId: string,
    @CurrentUser('organizationId') organizationId: string,
  ): Promise<SandboxResponseDto> {
    // Calculate new expiration date by adding days to current date
    const newExpiresAt = new Date();
    newExpiresAt.setDate(newExpiresAt.getDate() + dto.days);

    return this.sandboxesService.extendExpiration(
      id,
      organizationId,
      newExpiresAt,
      userId,
    );
  }

  @Post(':id/assign')
  @Roles(UserRole.ADMIN, UserRole.PRO_DEVELOPER)
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Assign users to sandbox (Admin/Pro only)' })
  @ApiResponse({ status: 204, description: 'Users assigned' })
  @ApiResponse({ status: 404, description: 'Sandbox not found' })
  async assignUsers(
    @Param('id') id: string,
    @Body() dto: AssignUsersDto,
    @CurrentUser('organizationId') organizationId: string,
  ): Promise<void> {
    // TODO: Implement user assignment (requires junction table)
    // This is placeholder for future implementation
  }

  @Post(':id/unassign')
  @Roles(UserRole.ADMIN, UserRole.PRO_DEVELOPER)
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Unassign users from sandbox (Admin/Pro only)' })
  @ApiResponse({ status: 204, description: 'Users unassigned' })
  @ApiResponse({ status: 404, description: 'Sandbox not found' })
  async unassignUsers(
    @Param('id') id: string,
    @Body() dto: UnassignUsersDto,
    @CurrentUser('organizationId') organizationId: string,
  ): Promise<void> {
    // TODO: Implement user removal (requires junction table)
    // This is placeholder for future implementation
  }

  @Get(':id/users')
  @ApiOperation({ summary: 'List users assigned to sandbox' })
  @ApiResponse({ status: 200, description: 'List of assigned users' })
  @ApiResponse({ status: 404, description: 'Sandbox not found' })
  async getAssignedUsers(
    @Param('id') id: string,
    @CurrentUser('organizationId') organizationId: string,
  ): Promise<any[]> {
    // TODO: Implement user listing (requires junction table)
    // This is placeholder for future implementation
    return [];
  }

  // ========================================
  // FEATURE SANDBOX WORKFLOW ENDPOINTS
  // ========================================

  @Post('feature')
  @ApiOperation({
    summary: 'Create a feature sandbox with Mendix and GitHub branches',
    description:
      'Creates a new feature sandbox with corresponding Mendix and GitHub branches for feature development',
  })
  @ApiResponse({
    status: 201,
    description: 'Feature sandbox created with branches',
    type: SandboxResponseDto,
  })
  @ApiResponse({
    status: 400,
    description: 'Bad Request - Invalid app or feature name',
  })
  @ApiResponse({
    status: 403,
    description: 'Forbidden - Not authorized to create sandbox for this app',
  })
  async createMendixFeatureSandbox(
    @Body() dto: CreateFeatureSandboxDto,
    @CurrentUser('id') userId: string,
    @CurrentUser('organizationId') organizationId: string,
  ): Promise<SandboxResponseDto> {
    return this.sandboxesService.createMendixFeatureSandbox(
      dto.appId,
      dto.featureName,
      userId,
      organizationId,
      dto.description,
    );
  }

  @Post('powerapps/feature')
  @ApiOperation({
    summary: 'Create PowerApps feature sandbox',
    description:
      'Creates a new feature sandbox for a PowerApps app. This creates a dev environment, ' +
      'copies the app to it, and sets up a GitHub branch for version control.',
  })
  @ApiResponse({
    status: 201,
    description: 'PowerApps feature sandbox created successfully',
    type: SandboxResponseDto,
  })
  @ApiResponse({ status: 404, description: 'App not found' })
  @ApiResponse({
    status: 403,
    description: 'Forbidden - Not authorized to create sandbox for this app',
  })
  @ApiResponse({
    status: 400,
    description: 'Bad Request - Failed to create dev environment or copy app',
  })
  async createPowerAppsFeatureSandbox(
    @Body() dto: CreateFeatureSandboxDto,
    @CurrentUser('id') userId: string,
    @CurrentUser('organizationId') organizationId: string,
  ): Promise<SandboxResponseDto> {
    return this.sandboxesService.createPowerAppsFeatureSandbox(
      dto.appId,
      dto.featureName,
      userId,
      organizationId,
      dto.description,
    );
  }

  @Post(':id/submit-for-review')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Submit sandbox for Pro Developer review',
    description:
      'Transitions sandbox to PENDING_REVIEW status and notifies Pro Developers',
  })
  @ApiResponse({
    status: 200,
    description: 'Sandbox submitted for review',
    type: SandboxResponseDto,
  })
  @ApiResponse({ status: 404, description: 'Sandbox not found' })
  @ApiResponse({
    status: 400,
    description: 'Bad Request - Sandbox not in valid state for submission',
  })
  async submitForReview(
    @Param('id') id: string,
    @CurrentUser('id') userId: string,
    @CurrentUser('organizationId') organizationId: string,
  ): Promise<SandboxResponseDto> {
    return this.sandboxesService.submitForReview(id, userId, organizationId);
  }

  @Post(':id/sync')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Sync sandbox - Export from Team Server and commit to GitHub',
    description:
      'Exports the current state from Mendix Team Server and commits it to the GitHub sandbox branch. Triggers change detection and CI/CD pipeline.',
  })
  @ApiResponse({
    status: 200,
    description: 'Sync completed',
    schema: {
      type: 'object',
      properties: {
        success: { type: 'boolean' },
        message: { type: 'string' },
        commitSha: { type: 'string' },
        commitUrl: { type: 'string' },
        changesDetected: { type: 'number' },
        pipelineTriggered: { type: 'boolean' },
      },
    },
  })
  @ApiResponse({ status: 404, description: 'Sandbox not found' })
  async syncSandbox(
    @Param('id') id: string,
    @Body() dto: { changeTitle?: string },
    @CurrentUser('id') userId: string,
    @CurrentUser('organizationId') organizationId: string,
  ): Promise<{
    success: boolean;
    message: string;
    commitSha?: string;
    commitUrl?: string;
    changesDetected: number;
    pipelineTriggered: boolean;
  }> {
    return this.sandboxesService.syncSandbox(
      id,
      userId,
      organizationId,
      dto.changeTitle,
    );
  }

  @Post(':id/powerapps/sync')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'Sync PowerApps sandbox - Export from dev environment and commit to GitHub',
    description:
      'Exports the current state of the copied app from the dev environment and commits it to the GitHub sandbox branch.',
  })
  @ApiResponse({
    status: 200,
    description: 'Sync completed successfully',
    schema: {
      type: 'object',
      properties: {
        success: { type: 'boolean' },
        message: { type: 'string' },
        commitSha: { type: 'string' },
        commitUrl: { type: 'string' },
        changesDetected: { type: 'number' },
        pipelineTriggered: { type: 'boolean' },
      },
    },
  })
  @ApiResponse({ status: 404, description: 'Sandbox not found' })
  @ApiResponse({ status: 400, description: 'Not a PowerApps feature sandbox' })
  async syncPowerAppsSandbox(
    @Param('id') id: string,
    @Body() dto: { changeTitle?: string },
    @CurrentUser('id') userId: string,
    @CurrentUser('organizationId') organizationId: string,
  ): Promise<{
    success: boolean;
    message: string;
    commitSha?: string;
    commitUrl?: string;
    changesDetected: number;
    pipelineTriggered: boolean;
  }> {
    return this.sandboxesService.syncPowerAppsSandbox(
      id,
      userId,
      organizationId,
      dto.changeTitle,
    );
  }

  @Post(':id/powerapps/merge')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Merge PowerApps sandbox to main',
    description:
      'Merges the approved sandbox branch to main and cleans up the dev environment and copied app.',
  })
  @ApiResponse({
    status: 200,
    description: 'Sandbox merged successfully',
    schema: {
      type: 'object',
      properties: {
        success: { type: 'boolean' },
        message: { type: 'string' },
        mergeCommitSha: { type: 'string' },
      },
    },
  })
  @ApiResponse({ status: 404, description: 'Sandbox not found' })
  @ApiResponse({
    status: 400,
    description: 'Sandbox not approved or not a PowerApps sandbox',
  })
  async mergePowerAppsSandbox(
    @Param('id') id: string,
    @CurrentUser('id') userId: string,
    @CurrentUser('organizationId') organizationId: string,
  ): Promise<{
    success: boolean;
    message: string;
    mergeCommitSha?: string;
  }> {
    return this.sandboxesService.mergePowerAppsSandbox(
      id,
      userId,
      organizationId,
    );
  }

  @Sse(':id/sync/progress')
  @Public() // SSE/EventSource doesn't support custom headers, so we make this public
  @ApiOperation({
    summary: 'Stream sync progress updates via Server-Sent Events',
    description:
      'Subscribe to real-time progress updates for a sandbox sync operation. ' +
      'Returns a stream of progress events with step number, status, and message. ' +
      'Note: This endpoint is public as SSE does not support custom auth headers.',
  })
  @ApiResponse({
    status: 200,
    description: 'SSE stream of progress events',
    schema: {
      type: 'object',
      properties: {
        sandboxId: { type: 'string' },
        step: { type: 'number' },
        totalSteps: { type: 'number' },
        status: {
          type: 'string',
          enum: ['pending', 'in-progress', 'completed', 'error'],
        },
        message: { type: 'string' },
        details: { type: 'string' },
        timestamp: { type: 'string', format: 'date-time' },
      },
    },
  })
  syncProgress(@Param('id') id: string): Observable<MessageEvent> {
    // Merge progress events with a keepalive signal every 15 seconds
    // This prevents the connection from timing out
    const progressStream = this.syncProgressService.getProgressStream(id);
    const keepalive = interval(15000).pipe(
      map(() => ({ type: 'keepalive', timestamp: new Date() })),
    );

    return progressStream.pipe(
      map(
        (event: SyncProgressEvent) =>
          ({
            data: event,
          }) as MessageEvent,
      ),
    );
  }

  @Post(':id/check-conflicts')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Check for merge conflicts with main branch',
    description:
      'Detects if the sandbox has conflicts with the main branch that need resolution',
  })
  @ApiResponse({
    status: 200,
    description: 'Conflict check completed',
    schema: {
      type: 'object',
      properties: {
        hasConflicts: { type: 'boolean' },
        conflictStatus: {
          type: 'string',
          enum: ['NONE', 'POTENTIAL', 'NEEDS_RESOLUTION', 'RESOLVED'],
        },
        conflictingFiles: { type: 'array', items: { type: 'string' } },
        message: { type: 'string' },
      },
    },
  })
  @ApiResponse({ status: 404, description: 'Sandbox not found' })
  async checkConflicts(
    @Param('id') id: string,
    @CurrentUser('id') userId: string,
    @CurrentUser('organizationId') organizationId: string,
  ): Promise<{
    hasConflicts: boolean;
    conflictStatus: string;
    conflictingFiles: string[];
    message: string;
  }> {
    return this.sandboxesService.checkConflicts(id, userId, organizationId);
  }

  @Post(':id/resolve-conflict')
  @Roles(UserRole.ADMIN, UserRole.PRO_DEVELOPER)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Resolve merge conflicts (Pro Developer only)',
    description:
      'Pro Developer resolves merge conflicts after manual intervention',
  })
  @ApiResponse({
    status: 200,
    description: 'Conflicts resolved',
    type: SandboxResponseDto,
  })
  @ApiResponse({
    status: 403,
    description: 'Forbidden - Only Pro Developers can resolve conflicts',
  })
  @ApiResponse({ status: 404, description: 'Sandbox not found' })
  async resolveConflict(
    @Param('id') id: string,
    @Body() dto: { resolution: string; mergeCommitSha?: string },
    @CurrentUser('id') userId: string,
    @CurrentUser('organizationId') organizationId: string,
  ): Promise<SandboxResponseDto> {
    return this.sandboxesService.resolveConflict(
      id,
      userId,
      organizationId,
      dto.resolution,
      dto.mergeCommitSha,
    );
  }

  @Post(':id/abandon')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Abandon sandbox',
    description: 'Marks sandbox as abandoned and optionally cleans up branches',
  })
  @ApiResponse({
    status: 200,
    description: 'Sandbox abandoned',
    type: SandboxResponseDto,
  })
  @ApiResponse({ status: 404, description: 'Sandbox not found' })
  async abandonSandbox(
    @Param('id') id: string,
    @CurrentUser('id') userId: string,
    @CurrentUser('organizationId') organizationId: string,
  ): Promise<SandboxResponseDto> {
    return this.sandboxesService.abandonSandbox(id, userId, organizationId);
  }

  @Get('app/:appId')
  @ApiOperation({
    summary: 'Get all active sandboxes for an app',
    description:
      'Returns all sandboxes linked to an app that are not merged or abandoned',
  })
  @ApiResponse({
    status: 200,
    description: 'List of app sandboxes',
    type: [SandboxResponseDto],
  })
  @ApiResponse({ status: 404, description: 'App not found' })
  async getAppSandboxes(
    @Param('appId') appId: string,
    @CurrentUser('organizationId') organizationId: string,
  ): Promise<SandboxResponseDto[]> {
    return this.sandboxesService.getAppSandboxes(appId, organizationId);
  }
}

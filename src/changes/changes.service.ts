import {
  Injectable,
  Logger,
  NotFoundException,
  Inject,
  forwardRef,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../common/audit/audit.service';
import { ChangesGateway } from './changes.gateway';
import { CreateChangeDto } from './dto/create-change.dto';
import { UpdateChangeDto } from './dto/update-change.dto';
import {
  ChangeResponseDto,
  DetectChangesResponseDto,
  PaginatedChangesResponseDto,
} from './dto/change-response.dto';
import { JsonDiffService } from './diff/json-diff.service';
import { ImpactAnalyzerService } from './analyzers/impact-analyzer.service';
import { PolicyRiskEvaluatorService } from '../risk/policy-risk-evaluator.service';
import { FormulaAnalyzerService } from '../risk/formula-analyzer.service';
import {
  RiskScorerService,
  EnhancedRiskAssessment,
} from '../risk/risk-scorer.service';
import type { Change, ChangeType, ChangeStatus } from '@prisma/client';

@Injectable()
export class ChangesService {
  private readonly logger = new Logger(ChangesService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly auditService: AuditService,
    @Inject(forwardRef(() => ChangesGateway))
    private readonly changesGateway: ChangesGateway,
    private readonly jsonDiffService: JsonDiffService,
    private readonly impactAnalyzer: ImpactAnalyzerService,
    private readonly policyRiskEvaluator: PolicyRiskEvaluatorService,
    private readonly formulaAnalyzer: FormulaAnalyzerService,
    private readonly riskScorer: RiskScorerService,
  ) {}

  /**
   * Automatically detect changes in an app (called after sync)
   */
  async detectChanges(
    appId: string,
    userId: string,
    organizationId: string,
  ): Promise<DetectChangesResponseDto> {
    try {
      this.logger.log(`Detecting changes for app ${appId}`);

      // Get current app metadata
      const app = await this.prisma.app.findUnique({
        where: {
          id: appId,
          organizationId,
        },
        select: {
          id: true,
          name: true,
          metadata: true,
          lastSyncedAt: true,
        },
      });

      if (!app) {
        throw new NotFoundException(`App ${appId} not found`);
      }

      // Get previous Change to compare against
      const previousChange = await this.prisma.change.findFirst({
        where: {
          appId,
          organizationId,
        },
        orderBy: {
          createdAt: 'desc',
        },
        select: {
          afterMetadata: true,
        },
      });

      const beforeMetadata = previousChange?.afterMetadata || {};
      const afterMetadata = app.metadata || {};

      // Calculate diff
      const diffSummary = this.jsonDiffService.calculateDiff(
        beforeMetadata,
        afterMetadata,
      );

      // If no changes, return early
      if (diffSummary.totalChanges === 0) {
        this.logger.log(`No changes detected for app ${appId}`);
        return {
          success: true,
          message: 'No changes detected',
          totalChanges: 0,
        };
      }

      // Determine change type
      const changeType = this.determineChangeType(diffSummary);

      // Create change record
      // Use direct field assignments instead of connect relations
      const changeCreateData: any = {
        organizationId,
        appId,
        title: `Auto-detected changes from sync on ${new Date().toLocaleString()}`,
        description: `Detected ${diffSummary.totalChanges} changes: ${diffSummary.added} added, ${diffSummary.modified} modified, ${diffSummary.deleted} deleted`,
        changeType,
        status: 'DRAFT',
        beforeMetadata,
        afterMetadata,
        diffSummary,
      };

      // Only set author if it's a valid user (not 'system')
      if (userId && userId !== 'system') {
        changeCreateData.authorId = userId;
      }

      const change = await this.prisma.change.create({
        data: changeCreateData,
        include: {
          app: {
            select: {
              name: true,
            },
          },
          author: {
            select: {
              name: true,
              email: true,
            },
          },
        },
      });

      // Analyze impact (async, in background)
      this.analyzeChangeImpact(change.id).catch((error) => {
        this.logger.error(
          `Failed to analyze impact for change ${change.id}: ${error.message}`,
        );
      });

      // Audit log
      await this.auditService.createAuditLog({
        organizationId,
        userId,
        action: 'CREATE',
        entityType: 'Change',
        entityId: change.id,
        details: {
          appId,
          appName: app.name,
          totalChanges: diffSummary.totalChanges,
        },
      });

      this.logger.log(
        `Detected ${diffSummary.totalChanges} changes for app ${appId}`,
      );

      return {
        success: true,
        message: `Detected ${diffSummary.totalChanges} changes in app`,
        totalChanges: diffSummary.totalChanges,
        change: this.mapToResponseDto(change),
      };
    } catch (error) {
      this.logger.error(
        `Failed to detect changes: ${error.message}`,
        error.stack,
      );
      throw error;
    }
  }

  /**
   * Manually sync changes from a sandbox environment
   */
  async syncSandbox(
    sandboxId: string,
    userId: string,
    organizationId: string,
  ): Promise<{ success: boolean; message: string; changeCount: number }> {
    try {
      this.logger.log(`Starting manual sync for sandbox ${sandboxId}`);

      // Get sandbox details
      const sandbox = await this.prisma.sandbox.findUnique({
        where: {
          id: sandboxId,
          organizationId,
        },
      });

      if (!sandbox) {
        throw new NotFoundException(`Sandbox ${sandboxId} not found`);
      }

      // Emit sync started event
      this.changesGateway.emitSyncStarted(sandboxId);

      // Get the appId from sandbox (if linked)
      const appId =
        (sandbox as any).appId || (sandbox.environment as any)?.appId;

      if (!appId) {
        throw new NotFoundException(
          `Sandbox ${sandboxId} is not linked to an app`,
        );
      }

      // Detect changes for the app
      const result = await this.detectChanges(appId, userId, organizationId);

      // Emit sync completed event
      this.changesGateway.emitSyncCompleted(sandboxId, result.totalChanges);

      this.logger.log(
        `Manual sync completed for sandbox ${sandboxId}: ${result.totalChanges} changes`,
      );

      return {
        success: true,
        message: `Sync completed. ${result.totalChanges} changes detected.`,
        changeCount: result.totalChanges,
      };
    } catch (error) {
      this.logger.error(
        `Failed to sync sandbox ${sandboxId}: ${error.message}`,
        error.stack,
      );
      throw error;
    }
  }

  /**
   * Analyze change impact (async) - Enhanced with policy and formula analysis
   */
  private async analyzeChangeImpact(changeId: string): Promise<void> {
    try {
      const change = await this.prisma.change.findUnique({
        where: { id: changeId },
      });

      if (!change) {
        return;
      }

      // Step 1: Analyze impact using existing analyzer
      const impactAnalysis = await this.impactAnalyzer.analyzeImpact(change);

      // Step 2: Evaluate policy-based risk rules
      const policyResult = await this.policyRiskEvaluator.evaluatePolicies(
        change,
        change.organizationId,
      );

      // Step 3: Analyze formula complexity if code changed
      let formulaAnalysis: any = null;
      if (change.beforeCode || change.afterCode) {
        // Determine platform from app
        const app = await this.prisma.app.findUnique({
          where: { id: change.appId },
          select: { platform: true },
        });

        const code = change.afterCode || change.beforeCode;
        const platform = (
          app?.platform?.toLowerCase() === 'mendix' ? 'mendix' : 'powerapps'
        ) as 'powerapps' | 'mendix';

        formulaAnalysis = await this.formulaAnalyzer.analyzeFormula(
          code,
          platform,
        );
      }

      // Step 4: Calculate enhanced risk score
      const enhancedAssessment = this.riskScorer.calculateEnhancedRiskScore(
        change,
        policyResult,
        formulaAnalysis,
        impactAnalysis,
      );

      // Step 5: Update change with enhanced assessment
      await this.prisma.change.update({
        where: { id: changeId },
        data: {
          riskScore: enhancedAssessment.score,
          riskAssessment: enhancedAssessment as any, // Prisma Json type
        },
      });

      this.logger.log(
        `Enhanced risk analysis complete for change ${changeId}: score=${enhancedAssessment.score}, level=${enhancedAssessment.level}, autoBlock=${enhancedAssessment.autoBlockRules.length > 0}`,
      );

      // If autoBlock detected, log warning
      if (enhancedAssessment.autoBlockRules.length > 0) {
        this.logger.warn(
          `Change ${changeId} blocked by ${enhancedAssessment.autoBlockRules.length} critical policies: ${enhancedAssessment.autoBlockRules.join(', ')}`,
        );
      }
    } catch (error) {
      this.logger.error(
        `Failed to analyze impact: ${error.message}`,
        error.stack,
      );
    }
  }

  /**
   * Analyze change impact synchronously and return the assessment
   * Used by sync flow to determine staging vs main branch and notifications
   */
  async analyzeChangeImpactSync(
    changeId: string,
  ): Promise<EnhancedRiskAssessment | null> {
    try {
      const change = await this.prisma.change.findUnique({
        where: { id: changeId },
      });

      if (!change) {
        this.logger.warn(`Change ${changeId} not found for sync analysis`);
        return null;
      }

      // Step 1: Analyze impact using existing analyzer
      const impactAnalysis = await this.impactAnalyzer.analyzeImpact(change);

      // Step 2: Evaluate policy-based risk rules
      const policyResult = await this.policyRiskEvaluator.evaluatePolicies(
        change,
        change.organizationId,
      );

      // Step 3: Analyze formula complexity if code changed
      let formulaAnalysis: any = null;
      if (change.beforeCode || change.afterCode) {
        const app = await this.prisma.app.findUnique({
          where: { id: change.appId },
          select: { platform: true },
        });

        const code = change.afterCode || change.beforeCode;
        const platform = (
          app?.platform?.toLowerCase() === 'mendix' ? 'mendix' : 'powerapps'
        ) as 'powerapps' | 'mendix';

        formulaAnalysis = await this.formulaAnalyzer.analyzeFormula(
          code,
          platform,
        );
      }

      // Step 4: Calculate enhanced risk score
      const enhancedAssessment = this.riskScorer.calculateEnhancedRiskScore(
        change,
        policyResult,
        formulaAnalysis,
        impactAnalysis,
      );

      // Step 5: Update change with enhanced assessment
      await this.prisma.change.update({
        where: { id: changeId },
        data: {
          riskScore: enhancedAssessment.score,
          riskAssessment: enhancedAssessment as any,
          status: 'PENDING', // All changes are pending until pro dev review
        },
      });

      this.logger.log(
        `Sync risk analysis for change ${changeId}: score=${enhancedAssessment.score}, level=${enhancedAssessment.level}`,
      );

      return enhancedAssessment;
    } catch (error) {
      this.logger.error(
        `Failed to analyze change for sync: ${error.message}`,
        error.stack,
      );
      return null;
    }
  }

  /**
   * Calculate risk score based on impact analysis
   * @deprecated Use riskScorer instead (integrated in analyzeChangeImpact)
   */
  private calculateRiskScore(impactAnalysis: any): number {
    let score = 0;

    // Base score from complexity
    score += impactAnalysis.complexityScore || 0;

    // Additional score from breaking changes
    score += (impactAnalysis.breakingChanges || 0) * 10;

    // Additional score from affected components
    score += Math.min((impactAnalysis.affectedComponents || 0) * 2, 20);

    // Additional score from risk factors
    const riskFactors = impactAnalysis.riskFactors || [];
    for (const factor of riskFactors) {
      if (factor.severity === 'critical') score += 15;
      else if (factor.severity === 'high') score += 10;
      else if (factor.severity === 'medium') score += 5;
      else score += 2;
    }

    return Math.min(Math.round(score), 100); // Cap at 100
  }

  /**
   * Determine change type based on diff summary
   */
  private determineChangeType(diffSummary: any): ChangeType {
    const { added, modified, deleted } = diffSummary;

    // If only additions, it's CREATE
    if (added > 0 && modified === 0 && deleted === 0) {
      return 'CREATE';
    }

    // If only deletions, it's DELETE
    if (deleted > 0 && added === 0 && modified === 0) {
      return 'DELETE';
    }

    // Otherwise, it's UPDATE
    return 'UPDATE';
  }

  /**
   * Create a manual change record
   */
  async create(
    createChangeDto: CreateChangeDto,
    userId: string,
    organizationId: string,
  ): Promise<ChangeResponseDto> {
    try {
      // Verify app exists and belongs to organization
      const app = await this.prisma.app.findUnique({
        where: {
          id: createChangeDto.appId,
          organizationId,
        },
      });

      if (!app) {
        throw new NotFoundException(`App ${createChangeDto.appId} not found`);
      }

      // Calculate diff if metadata provided
      let diffSummary: any = null;
      if (createChangeDto.beforeMetadata && createChangeDto.afterMetadata) {
        diffSummary = this.jsonDiffService.calculateDiff(
          createChangeDto.beforeMetadata,
          createChangeDto.afterMetadata,
        ) as any;
      }

      // Create change
      const change = await this.prisma.change.create({
        data: {
          organizationId,
          appId: createChangeDto.appId,
          authorId: userId,
          title: createChangeDto.title,
          description: createChangeDto.description,
          changeType: createChangeDto.changeType,
          status: 'DRAFT',
          beforeMetadata: createChangeDto.beforeMetadata,
          afterMetadata: createChangeDto.afterMetadata,
          beforeCode: createChangeDto.beforeCode,
          afterCode: createChangeDto.afterCode,
          diffSummary,
        },
        include: {
          app: {
            select: {
              name: true,
            },
          },
          author: {
            select: {
              name: true,
              email: true,
            },
          },
        },
      });

      // Analyze impact if diff exists
      if (diffSummary) {
        this.analyzeChangeImpact(change.id).catch((error) => {
          this.logger.error(`Failed to analyze impact: ${error.message}`);
        });
      }

      // Audit log
      await this.auditService.createAuditLog({
        organizationId,
        userId,
        action: 'CREATE',
        entityType: 'Change',
        entityId: change.id,
        details: {
          appId: change.appId,
          title: change.title,
          changeType: change.changeType,
        },
      });

      return this.mapToResponseDto(change);
    } catch (error) {
      this.logger.error(
        `Failed to create change: ${error.message}`,
        error.stack,
      );
      throw error;
    }
  }

  /**
   * Get all changes (with filters and pagination)
   */
  async findAll(
    organizationId: string,
    filters: {
      appId?: string;
      status?: ChangeStatus;
      changeType?: ChangeType;
      page?: number;
      limit?: number;
      includeDeleted?: boolean; // New filter to include soft-deleted changes
    },
  ): Promise<PaginatedChangesResponseDto> {
    const page = filters.page || 1;
    const limit = filters.limit || 20;
    const skip = (page - 1) * limit;

    const where: any = {
      organizationId,
    };

    // Exclude soft-deleted changes by default
    if (!filters.includeDeleted) {
      where.deletedAt = null;
    }

    if (filters.appId) {
      where.appId = filters.appId;
    }

    if (filters.status) {
      where.status = filters.status;
    }

    if (filters.changeType) {
      where.changeType = filters.changeType;
    }

    const [items, total] = await Promise.all([
      this.prisma.change.findMany({
        where,
        include: {
          app: {
            select: {
              name: true,
            },
          },
          author: {
            select: {
              name: true,
              email: true,
            },
          },
        },
        orderBy: {
          createdAt: 'desc',
        },
        skip,
        take: limit,
      }),
      this.prisma.change.count({ where }),
    ]);

    const mappedItems = items.map((change) => this.mapToResponseDto(change));

    return {
      items: mappedItems,
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit),
    };
  }

  /**
   * Get a single change
   */
  async findOne(
    id: string,
    organizationId: string,
  ): Promise<ChangeResponseDto> {
    const change = await this.prisma.change.findUnique({
      where: {
        id,
        organizationId,
      },
      include: {
        app: {
          select: {
            name: true,
          },
        },
        author: {
          select: {
            name: true,
            email: true,
          },
        },
      },
    });

    if (!change) {
      throw new NotFoundException(`Change ${id} not found`);
    }

    return this.mapToResponseDto(change);
  }

  /**
   * Update a change
   */
  async update(
    id: string,
    updateChangeDto: UpdateChangeDto,
    userId: string,
    organizationId: string,
  ): Promise<ChangeResponseDto> {
    // Verify change exists
    const existingChange = await this.prisma.change.findUnique({
      where: {
        id,
        organizationId,
      },
    });

    if (!existingChange) {
      throw new NotFoundException(`Change ${id} not found`);
    }

    // Recalculate diff if metadata changed
    let diffSummary: any = existingChange.diffSummary;
    if (updateChangeDto.beforeMetadata || updateChangeDto.afterMetadata) {
      const beforeMetadata =
        updateChangeDto.beforeMetadata || existingChange.beforeMetadata;
      const afterMetadata =
        updateChangeDto.afterMetadata || existingChange.afterMetadata;

      if (beforeMetadata && afterMetadata) {
        diffSummary = this.jsonDiffService.calculateDiff(
          beforeMetadata,
          afterMetadata,
        ) as any;
      }
    }

    // Update change
    const change = await this.prisma.change.update({
      where: {
        id,
        organizationId,
      },
      data: {
        ...updateChangeDto,
        diffSummary: diffSummary as any,
        updatedAt: new Date(),
      },
      include: {
        app: {
          select: {
            name: true,
          },
        },
        author: {
          select: {
            name: true,
            email: true,
          },
        },
      },
    });

    // Re-analyze impact if diff changed
    if (diffSummary !== existingChange.diffSummary) {
      this.analyzeChangeImpact(change.id).catch((error) => {
        this.logger.error(`Failed to analyze impact: ${error.message}`);
      });
    }

    // Audit log
    await this.auditService.createAuditLog({
      organizationId,
      userId,
      action: 'UPDATE',
      entityType: 'Change',
      entityId: change.id,
      details: {
        appId: change.appId,
        title: change.title,
        status: change.status,
      },
    });

    return this.mapToResponseDto(change);
  }

  /**
   * Delete a change
   */
  async remove(
    id: string,
    userId: string,
    organizationId: string,
  ): Promise<void> {
    // Verify change exists
    const change = await this.prisma.change.findUnique({
      where: {
        id,
        organizationId,
      },
    });

    if (!change) {
      throw new NotFoundException(`Change ${id} not found`);
    }

    // Delete change
    await this.prisma.change.delete({
      where: {
        id,
        organizationId,
      },
    });

    // Audit log
    await this.auditService.createAuditLog({
      organizationId,
      userId,
      action: 'DELETE',
      entityType: 'Change',
      entityId: id,
      details: {
        appId: change.appId,
        title: change.title,
      },
    });

    this.logger.log(`Deleted change ${id}`);
  }

  /**
   * Undo (soft delete) a change
   */
  async undo(
    id: string,
    userId: string,
    organizationId: string,
  ): Promise<ChangeResponseDto> {
    // Verify change exists and is not already deleted
    const change = await this.prisma.change.findUnique({
      where: {
        id,
        organizationId,
      },
    });

    if (!change) {
      throw new NotFoundException(`Change ${id} not found`);
    }

    if (change.deletedAt) {
      throw new NotFoundException(`Change ${id} is already undone`);
    }

    // Soft delete the change
    const updatedChange = await this.prisma.change.update({
      where: {
        id,
        organizationId,
      },
      data: {
        deletedAt: new Date(),
        deletedBy: userId,
      },
      include: {
        app: {
          select: {
            id: true,
            name: true,
            platform: true,
          },
        },
        author: {
          select: {
            id: true,
            email: true,
            displayName: true,
          },
        },
        deletedByUser: {
          select: {
            id: true,
            email: true,
            displayName: true,
          },
        },
      },
    });

    // Audit log
    await this.auditService.createAuditLog({
      organizationId,
      userId,
      action: 'UNDO',
      entityType: 'change',
      entityId: id,
      details: {
        appId: change.appId,
        title: change.title,
      },
    });

    this.logger.log(`Change ${id} undone by user ${userId}`);

    return this.mapToResponseDto(updatedChange);
  }

  /**
   * Restore (undelete) a change
   */
  async restore(
    id: string,
    userId: string,
    organizationId: string,
  ): Promise<ChangeResponseDto> {
    // Verify change exists and is deleted
    const change = await this.prisma.change.findUnique({
      where: {
        id,
        organizationId,
      },
    });

    if (!change) {
      throw new NotFoundException(`Change ${id} not found`);
    }

    if (!change.deletedAt) {
      throw new NotFoundException(`Change ${id} is not undone, cannot restore`);
    }

    // Restore the change
    const restoredChange = await this.prisma.change.update({
      where: {
        id,
        organizationId,
      },
      data: {
        deletedAt: null,
        deletedBy: null,
      },
      include: {
        app: {
          select: {
            id: true,
            name: true,
            platform: true,
          },
        },
        author: {
          select: {
            id: true,
            email: true,
            displayName: true,
          },
        },
      },
    });

    // Audit log
    await this.auditService.createAuditLog({
      organizationId,
      userId,
      action: 'RESTORE',
      entityType: 'change',
      entityId: id,
      details: {
        appId: change.appId,
        title: change.title,
      },
    });

    this.logger.log(`Change ${id} restored by user ${userId}`);

    return this.mapToResponseDto(restoredChange);
  }

  /**
   * Get visual diff for a change
   */
  async getVisualDiff(
    id: string,
    organizationId: string,
    format: 'json' | 'html' | 'text' = 'json',
  ): Promise<string> {
    const change = await this.prisma.change.findUnique({
      where: {
        id,
        organizationId,
      },
    });

    if (!change) {
      throw new NotFoundException(`Change ${id} not found`);
    }

    // Use code if available, otherwise use metadata
    const before =
      change.beforeCode || JSON.stringify(change.beforeMetadata, null, 2) || '';
    const after =
      change.afterCode || JSON.stringify(change.afterMetadata, null, 2) || '';

    if (format === 'html') {
      return this.jsonDiffService.generateHtmlDiff(before, after);
    }

    if (format === 'text') {
      return this.jsonDiffService.generateTextDiff(before, after);
    }

    // Return JSON diff summary
    return JSON.stringify(change.diffSummary, null, 2);
  }

  /**
   * Map Change entity to response DTO
   */
  private mapToResponseDto(change: any): ChangeResponseDto {
    return {
      id: change.id,
      organizationId: change.organizationId,
      appId: change.appId,
      appName: change.app?.name || 'Unknown',
      authorId: change.authorId,
      authorName: change.author?.name || 'Unknown',
      title: change.title,
      description: change.description,
      changeType: change.changeType,
      status: change.status,
      diffSummary: change.diffSummary,
      riskScore: change.riskScore,
      riskAssessment: change.riskAssessment,
      submittedAt: change.submittedAt,
      createdAt: change.createdAt,
      updatedAt: change.updatedAt,
    };
  }
}

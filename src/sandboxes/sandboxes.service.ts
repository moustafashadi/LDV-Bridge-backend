import {
  Injectable,
  Logger,
  NotFoundException,
  BadRequestException,
  ForbiddenException,
  Inject,
  forwardRef,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { Cron, CronExpression } from '@nestjs/schedule';
import { addDays, differenceInDays } from 'date-fns';
import { CreateSandboxDto } from './dto/create-sandbox.dto';
import { UpdateSandboxDto } from './dto/update-sandbox.dto';
import { LinkExistingEnvironmentDto } from './dto/link-existing-environment.dto';
import {
  SandboxResponseDto,
  SandboxStatsDto,
} from './dto/sandbox-response.dto';
import {
  SandboxPlatform,
  SandboxStatus,
  SandboxType,
  ProvisioningStatus,
  SANDBOX_QUOTAS,
  IEnvironmentProvisioner,
} from './interfaces/sandbox-environment.interface';
import { PowerAppsProvisioner } from './provisioners/powerapps.provisioner';
import { MendixProvisioner } from './provisioners/mendix.provisioner';
import { NotificationsService } from '../notifications/notifications.service';
import { AuditService } from '../common/audit/audit.service';
import { MendixService } from '../connectors/mendix/mendix.service';
import { MendixModelSdkService } from '../connectors/mendix/mendix-model-sdk.service';
import { GitHubService } from '../github/github.service';
import { ChangesService } from '../changes/changes.service';
import { SyncProgressService, SYNC_STEPS } from './sync-progress.service';

// Type helper for Sandbox with new schema fields
type SandboxWithRelations = {
  id: string;
  organizationId: string;
  createdById: string;
  appId: string | null;
  name: string;
  description: string | null;
  status: string;
  conflictStatus: string | null;
  mendixBranch: string | null;
  baseMendixRevision: string | null;
  githubBranch: string | null;
  baseGithubSha: string | null;
  environment: any;
  expiresAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  createdBy?: {
    id: string;
    email: string;
    name: string | null;
  };
  organization?: {
    id: string;
    name: string;
  };
};

/**
 * Sandboxes Service
 * Complete sandbox management with actual environment provisioning
 */
@Injectable()
export class SandboxesService {
  private readonly logger = new Logger(SandboxesService.name);
  private readonly provisioners: Map<SandboxPlatform, IEnvironmentProvisioner>;

  constructor(
    private readonly prisma: PrismaService,
    private readonly powerAppsProvisioner: PowerAppsProvisioner,
    private readonly mendixProvisioner: MendixProvisioner,
    private readonly notificationsService: NotificationsService,
    private readonly auditService: AuditService,
    @Inject(forwardRef(() => MendixService))
    private readonly mendixService: MendixService,
    @Inject(forwardRef(() => GitHubService))
    private readonly githubService: GitHubService,
    private readonly mendixModelSdkService: MendixModelSdkService,
    @Inject(forwardRef(() => ChangesService))
    private readonly changesService: ChangesService,
    private readonly syncProgressService: SyncProgressService,
  ) {
    // Initialize provisioners map
    this.provisioners = new Map<SandboxPlatform, IEnvironmentProvisioner>([
      [
        SandboxPlatform.POWERAPPS,
        this.powerAppsProvisioner as IEnvironmentProvisioner,
      ],
      [
        SandboxPlatform.MENDIX,
        this.mendixProvisioner as IEnvironmentProvisioner,
      ],
    ]);
  }

  /**
   * Create sandbox with environment provisioning
   *
   * @deprecated For Mendix platform: This method creates both a new Mendix app AND
   * a sandbox when sourceAppId is not provided. For creating new Mendix apps,
   * use POST /api/v1/apps/mendix/create instead, which properly separates app
   * creation from sandbox provisioning.
   *
   * For PowerApps platform: This method is still the recommended approach.
   */
  async create(
    dto: CreateSandboxDto,
    userId: string,
    organizationId: string,
  ): Promise<SandboxResponseDto> {
    // Log deprecation warning for Mendix new app creation
    if (dto.platform === 'MENDIX' && !dto.sourceAppId) {
      this.logger.warn(
        `[DEPRECATED] Creating new Mendix sandbox without sourceAppId. ` +
          `This creates a new Mendix app which is deprecated behavior. ` +
          `Use POST /api/v1/apps/mendix/create to create apps first, ` +
          `then create sandboxes for existing apps.`,
      );
    }

    this.logger.log(
      `Creating ${dto.platform} sandbox "${dto.name}" for org ${organizationId}`,
    );

    // If sourceAppId is provided, validate and check clone limits
    if (dto.sourceAppId) {
      await this.validateCloneRequest(dto.sourceAppId, organizationId, userId);
    }

    // Check quotas
    await this.checkQuotas(organizationId, dto.type);

    // Calculate expiration date
    const quota = SANDBOX_QUOTAS[dto.type];
    const expiresAt = dto.expiresAt
      ? new Date(dto.expiresAt)
      : addDays(new Date(), quota.maxDuration);

    // Create sandbox record first (status: PROVISIONING)
    const sandbox = (await this.prisma.sandbox.create({
      data: {
        organizationId,
        createdById: userId,
        name: dto.name,
        description: dto.description,
        status: SandboxStatus.PROVISIONING,
        expiresAt,
        environment: {
          platform: dto.platform,
          type: dto.type,
          provisioningStatus: ProvisioningStatus.PENDING,
          platformConfig: dto.platformConfig || {},
        },
      },
      include: {
        createdBy: {
          select: {
            id: true,
            email: true,
            name: true,
          },
        },
      },
    })) as SandboxWithRelations;

    // Audit log
    await this.auditService.createAuditLog({
      userId,
      organizationId,
      action: 'CREATE',
      entityType: 'sandbox',
      entityId: sandbox.id,
      details: { name: dto.name, platform: dto.platform, type: dto.type },
    });

    // Provision environment asynchronously
    this.provisionEnvironment(
      sandbox.id,
      dto.platform,
      dto,
      userId,
      organizationId,
    ).catch((error) => {
      this.logger.error(
        `Failed to provision sandbox ${sandbox.id}: ${error.message}`,
      );
    });

    return this.toResponseDto(sandbox);
  }

  /**
   * Link existing PowerApps/Mendix environment to LDV-Bridge
   * This allows users to work with pre-existing environments without creating new ones
   */
  async linkExistingEnvironment(
    dto: LinkExistingEnvironmentDto,
    userId: string,
    organizationId: string,
  ): Promise<SandboxResponseDto> {
    this.logger.log(
      `Linking existing ${dto.platform} environment "${dto.environmentId}" for org ${organizationId}`,
    );

    // Check quotas
    await this.checkQuotas(organizationId, dto.type);

    // Calculate expiration date
    const quota = SANDBOX_QUOTAS[dto.type];
    const expiresAt = dto.expiresAt
      ? new Date(dto.expiresAt)
      : addDays(new Date(), quota.maxDuration);

    // Verify environment exists and get its details
    let environmentDetails: any;
    try {
      if (dto.platform === SandboxPlatform.POWERAPPS) {
        // Get environment details through the provisioner's public interface
        // The provisioner internally uses PowerAppsService
        const powerAppsProvisioner = this.provisioners.get(
          SandboxPlatform.POWERAPPS,
        ) as PowerAppsProvisioner;
        // Use getStatus to verify environment exists (it will throw if not found)
        await powerAppsProvisioner.getStatus(
          userId,
          organizationId,
          dto.environmentId,
        );
        environmentDetails = {
          name: dto.name,
          url: null,
          environmentId: dto.environmentId,
        };
      } else {
        // Mendix environment verification would go here
        environmentDetails = { name: dto.name, url: null };
      }
    } catch (error) {
      this.logger.error(`Failed to verify environment: ${error.message}`);
      throw new BadRequestException(
        `Could not verify environment ${dto.environmentId}. Make sure you're connected to ${dto.platform} and the environment exists.`,
      );
    }

    // Create sandbox record linked to existing environment
    const sandbox = (await this.prisma.sandbox.create({
      data: {
        organizationId,
        createdById: userId,
        name: dto.name,
        description: dto.description || `Linked ${dto.platform} environment`,
        status: SandboxStatus.ACTIVE, // Immediately active since environment already exists
        expiresAt,
        environment: {
          platform: dto.platform,
          type: dto.type,
          provisioningStatus: ProvisioningStatus.COMPLETED, // Already provisioned
          environmentId: dto.environmentId,
          environmentUrl:
            environmentDetails.url ||
            environmentDetails.properties?.linkedEnvironmentMetadata
              ?.instanceUrl,
          region: environmentDetails.location || 'unknown',
          platformConfig: {},
          metadata: {
            linkedExisting: true,
            originalEnvironmentName:
              environmentDetails.name ||
              environmentDetails.properties?.displayName,
          },
        },
      },
      include: {
        createdBy: {
          select: {
            id: true,
            email: true,
            name: true,
          },
        },
      },
    })) as SandboxWithRelations;

    // Audit log
    await this.auditService.createAuditLog({
      userId,
      organizationId,
      action: 'CREATE',
      entityType: 'sandbox',
      entityId: sandbox.id,
      details: {
        name: dto.name,
        platform: dto.platform,
        type: dto.type,
        linkedExisting: true,
        environmentId: dto.environmentId,
      },
    });

    // Send notification
    await this.notificationsService.create({
      userId,
      type: 'SYSTEM',
      title: 'Environment Linked',
      message: `Your existing ${dto.platform} environment "${dto.name}" has been linked to LDV-Bridge successfully. Environment ID: ${dto.environmentId}`,
    });

    return this.toResponseDto(sandbox);
  }

  /**
   * Provision environment in background
   */
  private async provisionEnvironment(
    sandboxId: string,
    platform: SandboxPlatform,
    dto: CreateSandboxDto,
    userId: string,
    organizationId: string,
  ): Promise<void> {
    try {
      // Update status to IN_PROGRESS
      await this.prisma.sandbox.update({
        where: { id: sandboxId },
        data: {
          environment: {
            ...(await this.getSandboxEnvironment(sandboxId)),
            provisioningStatus: ProvisioningStatus.IN_PROGRESS,
          },
        },
      });

      // Get provisioner
      const provisioner = this.provisioners.get(platform);
      if (!provisioner) {
        throw new Error(`No provisioner found for platform: ${platform}`);
      }

      // Prepare platform-specific config
      const config = this.preparePlatformConfig(dto, userId, organizationId);

      // Provision environment
      const envDetails = await provisioner.provision(config);

      // Find or create the App record for this sandbox's external app
      let appRecord: { id: string } | null = null;
      if (envDetails.appId) {
        // Try to find existing app by external ID
        appRecord = await this.prisma.app.findFirst({
          where: {
            externalId: envDetails.appId,
            organizationId,
          },
          select: {
            id: true,
          },
        });

        // If not found, create the App record automatically
        if (!appRecord) {
          this.logger.log(
            `App with externalId ${envDetails.appId} not found. Creating App record for newly provisioned ${platform} app "${dto.name}".`,
          );

          // Determine connector type based on platform
          const platformType =
            platform === SandboxPlatform.MENDIX ? 'MENDIX' : 'POWERAPPS';

          // Find the organization's platform connector for this platform
          const connector = await this.prisma.platformConnector.findFirst({
            where: {
              organizationId,
              platform: platformType,
              isActive: true,
            },
            select: {
              id: true,
            },
          });

          if (!connector) {
            this.logger.error(
              `No active ${platformType} connector found for organization ${organizationId}. Cannot create App record.`,
            );
            // Don't throw error, just skip app creation - sandbox will still work
          } else {
            // Create the App record
            appRecord = await this.prisma.app.create({
              data: {
                name: dto.name,
                externalId: envDetails.appId,
                platform: platformType,
                organizationId,
                ownerId: userId,
                connectorId: connector.id,
                status: 'DRAFT', // Newly created apps start as DRAFT
                metadata: {
                  ...envDetails.metadata,
                  autoCreatedFromSandbox: true,
                  sandboxId: sandboxId,
                  projectId: envDetails.metadata?.projectId,
                  environmentUrl:
                    envDetails.environmentUrl || envDetails.metadata?.portalUrl,
                },
              },
              select: {
                id: true,
              },
            });

            this.logger.log(
              `Created App record ${appRecord.id} for ${platformType} app ${envDetails.appId}`,
            );
          }
        }
      }

      // Update sandbox with environment details
      await this.prisma.sandbox.update({
        where: { id: sandboxId },
        data: {
          status: SandboxStatus.ACTIVE,
          appId: appRecord?.id || null, // Link to internal App record ID
          environment: {
            ...(await this.getSandboxEnvironment(sandboxId)),
            provisioningStatus: ProvisioningStatus.COMPLETED,
            environmentId: envDetails.environmentId,
            environmentUrl: envDetails.environmentUrl,
            region: envDetails.region,
            metadata: {
              ...envDetails.metadata,
              externalAppId: envDetails.appId, // Store external app ID in metadata for reference
              isCloned: envDetails.isCloned || false,
            },
          },
        },
      });

      // If this was a clone, create a SandboxClone record
      if (envDetails.isCloned && dto.sourceAppId && envDetails.appId) {
        await this.prisma.sandboxClone.create({
          data: {
            sourceAppId: dto.sourceAppId,
            sandboxId: sandboxId,
            clonedAppId: envDetails.appId,
            organizationId,
            createdById: userId,
          },
        });
        this.logger.log(
          `Created clone tracking record for sandbox ${sandboxId} from app ${dto.sourceAppId}`,
        );
      }

      // Send notification
      const sandbox = await this.prisma.sandbox.findUnique({
        where: { id: sandboxId },
        include: { createdBy: true },
      });

      if (sandbox) {
        await this.notificationsService.create({
          userId: sandbox.createdById,
          type: 'SYSTEM',
          title: 'Sandbox Ready',
          message: `Your sandbox "${sandbox.name}" is ready to use!`,
          data: {
            sandboxId: sandbox.id,
            link: `/sandboxes/${sandboxId}`,
          },
        });
      }

      this.logger.log(
        `Successfully provisioned sandbox ${sandboxId}: ${envDetails.environmentUrl}`,
      );
    } catch (error) {
      this.logger.error(
        `Provisioning failed for sandbox ${sandboxId}: ${error.message}`,
      );

      // Update status to FAILED
      await this.prisma.sandbox.update({
        where: { id: sandboxId },
        data: {
          status: SandboxStatus.FAILED,
          environment: {
            ...(await this.getSandboxEnvironment(sandboxId)),
            provisioningStatus: ProvisioningStatus.FAILED,
            error: error.message,
          },
        },
      });

      // Send failure notification
      const sandbox = await this.prisma.sandbox.findUnique({
        where: { id: sandboxId },
        include: { createdBy: true },
      });

      if (sandbox) {
        await this.notificationsService.sendNotification({
          userId: sandbox.createdById,
          type: 'SYSTEM',
          title: 'Sandbox Provisioning Failed',
          message: `Failed to provision sandbox "${sandbox.name}": ${error.message}`,
          data: {
            sandboxId,
            link: `/sandboxes/${sandboxId}`,
          },
        });
      }
    }
  }

  /**
   * List sandboxes with filtering
   */
  async findAll(
    organizationId: string,
    filters?: {
      platform?: SandboxPlatform;
      status?: SandboxStatus;
      type?: SandboxType;
      userId?: string;
    },
    page = 1,
    limit = 20,
  ): Promise<{ data: SandboxResponseDto[]; total: number }> {
    const where: any = {
      organizationId,
      // Exclude deleted sandboxes from listing
      status: { not: SandboxStatus.DELETED },
    };

    if (filters) {
      if (filters.platform) {
        where.environment = {
          path: ['platform'],
          equals: filters.platform,
        };
      }
      // Allow explicit status filter to override the DELETED exclusion
      if (filters.status) {
        where.status = filters.status;
      }
      if (filters.userId) where.createdById = filters.userId;
    }

    const [sandboxes, total] = await Promise.all([
      this.prisma.sandbox.findMany({
        where,
        include: {
          createdBy: {
            select: {
              id: true,
              email: true,
              name: true,
            },
          },
        },
        skip: (page - 1) * limit,
        take: limit,
        orderBy: { createdAt: 'desc' },
      }),
      this.prisma.sandbox.count({ where }),
    ]);

    return {
      data: sandboxes.map((s) => this.toResponseDto(s)),
      total,
    };
  }

  /**
   * Get sandbox by ID
   */
  async findOne(
    id: string,
    organizationId: string,
  ): Promise<SandboxResponseDto> {
    const sandbox = await this.prisma.sandbox.findFirst({
      where: { id, organizationId },
      include: {
        createdBy: {
          select: {
            id: true,
            email: true,
            name: true,
          },
        },
      },
    });

    if (!sandbox) {
      throw new NotFoundException(`Sandbox ${id} not found`);
    }

    return this.toResponseDto(sandbox);
  }

  /**
   * Update sandbox
   */
  async update(
    id: string,
    organizationId: string,
    dto: UpdateSandboxDto,
    userId: string,
  ): Promise<SandboxResponseDto> {
    const sandbox = await this.findOne(id, organizationId);

    const updated = await this.prisma.sandbox.update({
      where: { id },
      data: {
        name: dto.name,
        description: dto.description,
        status: dto.status,
        expiresAt: dto.expiresAt ? new Date(dto.expiresAt) : undefined,
      },
      include: {
        createdBy: {
          select: {
            id: true,
            email: true,
            name: true,
          },
        },
      },
    });

    await this.auditService.createAuditLog({
      userId,
      organizationId,
      action: 'UPDATE',
      entityType: 'sandbox',
      entityId: id,
      details: dto,
    });

    return this.toResponseDto(updated);
  }

  /**
   * Delete sandbox (deprovision environment)
   */
  async remove(
    id: string,
    organizationId: string,
    userId: string,
  ): Promise<void> {
    const sandbox = await this.getRawSandbox(id, organizationId);
    const env = sandbox.environment as any;

    // Deprovision environment if it exists
    if (env?.environmentId && env?.platform) {
      const provisioner = this.provisioners.get(env.platform);
      if (provisioner) {
        try {
          await provisioner.deprovision(
            userId,
            organizationId,
            env.environmentId,
          );
        } catch (error) {
          this.logger.error(
            `Failed to deprovision environment: ${error.message}`,
          );
        }
      }
    }

    // Mark as deleted
    await this.prisma.sandbox.update({
      where: { id },
      data: { status: SandboxStatus.DELETED },
    });

    await this.auditService.createAuditLog({
      userId,
      organizationId,
      action: 'DELETE',
      entityType: 'sandbox',
      entityId: id,
    });

    this.logger.log(`Deleted sandbox ${id}`);
  }

  /**
   * Start sandbox environment
   */
  async start(
    id: string,
    organizationId: string,
    userId: string,
  ): Promise<void> {
    const sandbox = await this.getRawSandbox(id, organizationId);
    const env = sandbox.environment;

    if (!env?.environmentId) {
      throw new BadRequestException('Sandbox has no provisioned environment');
    }

    const provisioner = this.provisioners.get(env.platform);
    if (!provisioner) {
      throw new BadRequestException(
        `Provisioner for ${env.platform} not found`,
      );
    }

    await provisioner.start(userId, organizationId, env.environmentId);

    await this.prisma.sandbox.update({
      where: { id },
      data: { status: SandboxStatus.ACTIVE },
    });

    await this.auditService.createAuditLog({
      userId,
      organizationId,
      action: 'UPDATE',
      entityType: 'sandbox',
      entityId: id,
      details: { operation: 'start' },
    });

    this.logger.log(`Started sandbox ${id}`);
  }

  /**
   * Stop sandbox environment
   */
  async stop(
    id: string,
    organizationId: string,
    userId: string,
  ): Promise<void> {
    const sandbox = await this.getRawSandbox(id, organizationId);
    const env = sandbox.environment;

    if (!env?.environmentId) {
      throw new BadRequestException('Sandbox has no provisioned environment');
    }

    const provisioner = this.provisioners.get(env.platform);
    if (!provisioner) {
      throw new BadRequestException(
        `Provisioner for ${env.platform} not found`,
      );
    }

    await provisioner.stop(userId, organizationId, env.environmentId);

    await this.prisma.sandbox.update({
      where: { id },
      data: { status: SandboxStatus.SUSPENDED },
    });

    await this.auditService.createAuditLog({
      userId,
      organizationId,
      action: 'UPDATE',
      entityType: 'sandbox',
      entityId: id,
      details: { operation: 'stop' },
    });

    this.logger.log(`Stopped sandbox ${id}`);
  }

  /**
   * Get sandbox statistics
   */
  async getStats(id: string, organizationId: string): Promise<SandboxStatsDto> {
    const sandbox = await this.getRawSandbox(id, organizationId);
    const env = sandbox.environment;

    if (!env?.environmentId) {
      return {
        appsCount: 0,
        apiCallsUsed: 0,
        storageUsed: 0,
        maxApps: SANDBOX_QUOTAS[env.type]?.maxApps || 0,
        maxApiCalls: SANDBOX_QUOTAS[env.type]?.maxApiCalls || 0,
        maxStorage: SANDBOX_QUOTAS[env.type]?.maxStorage || 0,
      };
    }

    const provisioner = this.provisioners.get(env.platform);
    if (!provisioner) {
      throw new BadRequestException(
        `Provisioner for ${env.platform} not found`,
      );
    }

    const resources = await provisioner.getResourceUsage(
      sandbox.createdById,
      organizationId,
      env.environmentId,
    );

    return {
      appsCount: resources.appsCount,
      apiCallsUsed: resources.apiCallsUsed,
      storageUsed: resources.storageUsed,
      maxApps: SANDBOX_QUOTAS[env.type]?.maxApps || 0,
      maxApiCalls: SANDBOX_QUOTAS[env.type]?.maxApiCalls || 0,
      maxStorage: SANDBOX_QUOTAS[env.type]?.maxStorage || 0,
    };
  }

  /**
   * Extend sandbox expiration
   */
  async extendExpiration(
    id: string,
    organizationId: string,
    expiresAt: Date,
    userId: string,
  ): Promise<SandboxResponseDto> {
    const sandbox = await this.findOne(id, organizationId);

    const updated = await this.prisma.sandbox.update({
      where: { id },
      data: { expiresAt },
      include: {
        createdBy: {
          select: {
            id: true,
            email: true,
            name: true,
          },
        },
      },
    });

    await this.auditService.createAuditLog({
      userId,
      organizationId,
      action: 'UPDATE',
      entityType: 'sandbox',
      entityId: id,
      details: { operation: 'extend_expiration', newExpiration: expiresAt },
    });

    return this.toResponseDto(updated);
  }

  /**
   * Cleanup expired sandboxes (runs daily at midnight)
   */
  @Cron(CronExpression.EVERY_DAY_AT_MIDNIGHT)
  async cleanupExpiredSandboxes(): Promise<void> {
    this.logger.log('Running expired sandboxes cleanup...');

    const expired = await this.prisma.sandbox.findMany({
      where: {
        expiresAt: { lte: new Date() },
        status: { in: [SandboxStatus.ACTIVE, SandboxStatus.SUSPENDED] },
      },
      include: { createdBy: true },
    });

    for (const sandbox of expired) {
      try {
        // Deprovision environment
        const env = sandbox.environment as any;
        if (env?.environmentId && env?.platform) {
          const provisioner = this.provisioners.get(env.platform);
          await provisioner?.deprovision(
            sandbox.createdById,
            sandbox.organizationId,
            env.environmentId,
          );
        }

        // Update status
        await this.prisma.sandbox.update({
          where: { id: sandbox.id },
          data: { status: SandboxStatus.EXPIRED },
        });

        // Send notification
        await this.notificationsService.sendNotification({
          userId: sandbox.createdById,
          type: 'SYSTEM',
          title: 'Sandbox Expired',
          message: `Your sandbox "${sandbox.name}" has expired and been deactivated.`,
        });

        this.logger.log(`Expired sandbox ${sandbox.id}`);
      } catch (error) {
        this.logger.error(
          `Failed to cleanup sandbox ${sandbox.id}: ${error.message}`,
        );
      }
    }

    this.logger.log(`Cleaned up ${expired.length} expired sandboxes`);
  }

  /**
   * Send expiration warnings (runs daily at 9 AM)
   */
  @Cron(CronExpression.EVERY_DAY_AT_9AM)
  async sendExpirationWarnings(): Promise<void> {
    this.logger.log('Checking for sandboxes expiring soon...');

    const sevenDaysFromNow = addDays(new Date(), 7);
    const oneDayFromNow = addDays(new Date(), 1);

    // 7-day warning
    const expiringSoon = await this.prisma.sandbox.findMany({
      where: {
        expiresAt: {
          gte: new Date(),
          lte: sevenDaysFromNow,
        },
        status: SandboxStatus.ACTIVE,
      },
      include: { createdBy: true },
    });

    for (const sandbox of expiringSoon) {
      if (!sandbox.expiresAt) continue;

      const daysLeft = differenceInDays(sandbox.expiresAt, new Date());

      await this.notificationsService.sendNotification({
        userId: sandbox.createdById,
        type: 'SYSTEM',
        title: 'Sandbox Expiring Soon',
        message: `Your sandbox "${sandbox.name}" will expire in ${daysLeft} days.`,
        data: {
          sandboxId: sandbox.id,
          link: `/sandboxes/${sandbox.id}`,
        },
      });
    }

    this.logger.log(`Sent ${expiringSoon.length} expiration warnings`);
  }

  /**
   * Helper: Check if organization has reached sandbox quotas
   */
  private async checkQuotas(
    organizationId: string,
    type: SandboxType,
  ): Promise<void> {
    const activeSandboxes = await this.prisma.sandbox.count({
      where: {
        organizationId,
        status: { in: [SandboxStatus.ACTIVE, SandboxStatus.PROVISIONING] },
      },
    });

    const quota = SANDBOX_QUOTAS[type];

    // Simple check: max 10 sandboxes per org
    if (activeSandboxes >= 10) {
      throw new BadRequestException(
        'Organization has reached maximum sandbox limit (10)',
      );
    }
  }

  /**
   * Helper: Validate clone request and check clone limits
   */
  private async validateCloneRequest(
    sourceAppId: string,
    organizationId: string,
    userId: string,
  ): Promise<void> {
    // Check if source app exists and is synced to LDV-Bridge
    const sourceApp = await this.prisma.app.findFirst({
      where: {
        id: sourceAppId,
        organizationId,
      },
    });

    if (!sourceApp) {
      throw new BadRequestException(
        'Source app not found or not synced to LDV-Bridge. Please sync the app first.',
      );
    }

    // Check clone limit (max 3 clones per source app)
    const cloneCount = await this.prisma.sandboxClone.count({
      where: {
        sourceAppId,
        organizationId,
      },
    });

    if (cloneCount >= 3) {
      throw new BadRequestException(
        `Maximum clone limit reached for this app (3 clones). Please delete an existing sandbox clone before creating a new one.`,
      );
    }

    this.logger.log(
      `Clone validation passed for app ${sourceAppId}: ${cloneCount}/3 clones used`,
    );
  }

  /**
   * Helper: Get sandbox environment JSON
   */
  private async getSandboxEnvironment(sandboxId: string): Promise<any> {
    const sandbox = await this.prisma.sandbox.findUnique({
      where: { id: sandboxId },
      select: { environment: true },
    });
    return sandbox?.environment || {};
  }

  /**
   * Helper: Get raw sandbox with relations (for internal operations)
   */
  private async getRawSandbox(
    id: string,
    organizationId: string,
  ): Promise<SandboxWithRelations> {
    const sandbox = await this.prisma.sandbox.findFirst({
      where: { id, organizationId },
      include: {
        createdBy: {
          select: {
            id: true,
            email: true,
            name: true,
          },
        },
      },
    });

    if (!sandbox) {
      throw new NotFoundException(`Sandbox ${id} not found`);
    }

    return sandbox as SandboxWithRelations;
  }

  /**
   * Helper: Prepare platform-specific config
   */
  private preparePlatformConfig(
    dto: CreateSandboxDto,
    userId: string,
    organizationId: string,
  ): any {
    if (dto.platform === SandboxPlatform.POWERAPPS) {
      return {
        userId,
        organizationId,
        displayName: `Sandbox: ${dto.name}`,
        environmentType: 'Developer',
        region: dto.platformConfig?.region || 'unitedstates',
        sourceAppId: dto.sourceAppId, // Pass sourceAppId for cloning
        ...dto.platformConfig,
      };
    } else {
      return {
        userId,
        organizationId,
        name: dto.name,
        template: dto.platformConfig?.template || 'blank',
        mode: 'sandbox',
        sourceAppId: dto.sourceAppId, // Pass sourceAppId for cloning
        ...dto.platformConfig,
      };
    }
  }

  /**
   * Helper: Convert Prisma model to response DTO
   */
  private toResponseDto(sandbox: any): SandboxResponseDto {
    const env = sandbox.environment;

    return {
      id: sandbox.id,
      organizationId: sandbox.organizationId,
      createdById: sandbox.createdById,
      name: sandbox.name,
      description: sandbox.description,
      platform: env?.platform || SandboxPlatform.POWERAPPS,
      type: env?.type || SandboxType.PERSONAL,
      status: sandbox.status,
      provisioningStatus: env?.provisioningStatus || ProvisioningStatus.PENDING,
      environmentId: env?.environmentId,
      environmentUrl: env?.environmentUrl,
      region: env?.region,
      expiresAt: sandbox.expiresAt,
      createdBy: sandbox.createdBy,
      organization: sandbox.organization,
      metadata: env?.metadata,
      createdAt: sandbox.createdAt,
      updatedAt: sandbox.updatedAt,
    };
  }

  // ========================================
  // MENDIX SANDBOX WORKFLOW METHODS
  // ========================================

  /**
   * Create a feature sandbox for Mendix apps
   * Creates branches in both Mendix Team Server and GitHub
   * @param appId - LDV-Bridge app ID to create sandbox for
   * @param featureName - Name of the feature (used for branch names)
   */
  async createFeatureSandbox(
    appId: string,
    featureName: string,
    userId: string,
    organizationId: string,
    description?: string,
  ): Promise<SandboxResponseDto> {
    this.logger.log(
      `Creating feature sandbox "${featureName}" for app ${appId}`,
    );

    // Get the app
    const app = await this.prisma.app.findFirst({
      where: { id: appId, organizationId },
      include: { owner: true },
    });

    if (!app) {
      throw new NotFoundException(`App ${appId} not found`);
    }

    // Check if user has access (owner or has permission)
    const hasAccess =
      app.ownerId === userId ||
      (await this.prisma.appPermission.findFirst({
        where: { appId, userId, accessLevel: { in: ['EDITOR', 'OWNER'] } },
      }));

    if (!hasAccess) {
      throw new ForbiddenException(
        'You do not have access to create sandboxes for this app',
      );
    }

    // Generate branch names from feature name
    const slug = featureName
      .toLowerCase()
      .replace(/[^a-z0-9\s-]/g, '')
      .replace(/\s+/g, '-')
      .substring(0, 50);
    const mendixBranch = `feature/${slug}`;
    const githubBranch = `sandbox/${slug}`;

    // Check if branch already exists
    const existingSandbox = await this.prisma.sandbox.findFirst({
      where: {
        appId,
        organizationId,
        mendixBranch,
        status: {
          notIn: [
            SandboxStatus.MERGED,
            SandboxStatus.ABANDONED,
            SandboxStatus.REJECTED,
          ],
        },
      },
    });

    if (existingSandbox) {
      throw new BadRequestException(
        `A sandbox with branch "${mendixBranch}" already exists for this app`,
      );
    }

    // Get app external ID for Mendix API calls
    const mendixAppId = app.externalId;
    if (!mendixAppId) {
      throw new BadRequestException(
        'App does not have a Mendix external ID. Cannot create sandbox branches.',
      );
    }

    // Step 1: Create Mendix branch
    let mendixBranchInfo: {
      branchName: string;
      revision: number;
      createdAt: string;
    } | null = null;
    try {
      this.logger.log(
        `Creating Mendix branch "${mendixBranch}" for app ${mendixAppId}`,
      );
      mendixBranchInfo = await this.mendixService.createBranch(
        userId,
        organizationId,
        mendixAppId,
        mendixBranch,
        'main', // Source branch
      );
      this.logger.log(
        `Mendix branch created at revision ${mendixBranchInfo.revision}`,
      );
    } catch (error) {
      this.logger.error(`Failed to create Mendix branch: ${error.message}`);
      throw new BadRequestException(
        `Failed to create Mendix branch: ${error.message}`,
      );
    }

    // Step 2: Create sandbox record (before GitHub to get sandbox ID)
    // Build Mendix Portal URL for opening in Studio Pro
    // Note: Get project ID from app metadata
    const appMetadata = app.metadata as any;
    const projectId =
      appMetadata?.projectId || appMetadata?.metadata?.projectId || mendixAppId;
    const studioUrl = `https://home.mendix.com/link/project/${projectId}/branchline/${encodeURIComponent(mendixBranch)}`;

    const sandbox = await this.prisma.sandbox.create({
      data: {
        organizationId,
        createdById: userId,
        appId,
        name: featureName,
        description: description || `Feature: ${featureName}`,
        status: SandboxStatus.ACTIVE,
        mendixBranch,
        baseMendixRevision: String(mendixBranchInfo.revision),
        latestMendixRevision: String(mendixBranchInfo.revision),
        githubBranch,
        environment: {
          platform: 'MENDIX',
          featureBased: true,
          mendixBranchCreatedAt: mendixBranchInfo.createdAt,
          studioUrl, // URL to open branch in Mendix Portal
        },
      },
      include: {
        createdBy: {
          select: { id: true, email: true, name: true },
        },
        app: true,
      },
    });

    // Step 3: Create GitHub branch
    let githubBranchInfo: { name: string; commit: { sha: string } } | null =
      null;
    try {
      this.logger.log(
        `Creating GitHub branch "${githubBranch}" for sandbox ${sandbox.id}`,
      );
      // GitHubService.createSandboxBranch expects a Sandbox object
      githubBranchInfo = await this.githubService.createSandboxBranch(
        sandbox as any,
      );

      // Update sandbox with GitHub SHA
      await this.prisma.sandbox.update({
        where: { id: sandbox.id },
        data: {
          baseGithubSha: githubBranchInfo.commit.sha,
          latestGithubSha: githubBranchInfo.commit.sha,
        },
      });

      this.logger.log(
        `GitHub branch created with SHA ${githubBranchInfo.commit.sha}`,
      );
    } catch (error) {
      this.logger.error(`Failed to create GitHub branch: ${error.message}`);
      // Clean up: delete the sandbox record since GitHub failed
      await this.prisma.sandbox.delete({ where: { id: sandbox.id } });
      // Clean up: delete Mendix branch
      try {
        await this.mendixService.deleteBranch(
          userId,
          organizationId,
          mendixAppId,
          mendixBranch,
        );
      } catch (cleanupError) {
        this.logger.warn(
          `Failed to cleanup Mendix branch: ${cleanupError.message}`,
        );
      }
      throw new BadRequestException(
        `Failed to create GitHub branch: ${error.message}`,
      );
    }

    this.logger.log(
      `Created feature sandbox ${sandbox.id} with branches: ${mendixBranch} (rev ${mendixBranchInfo.revision}) / ${githubBranch} (${githubBranchInfo.commit.sha})`,
    );

    // Audit log
    await this.auditService.createAuditLog({
      userId,
      organizationId,
      action: 'CREATE',
      entityType: 'sandbox',
      entityId: sandbox.id,
      details: {
        featureName,
        mendixBranch,
        mendixRevision: mendixBranchInfo.revision,
        githubBranch,
        githubSha: githubBranchInfo.commit.sha,
      },
    });

    // Refetch sandbox with updated GitHub info
    const updatedSandbox = await this.prisma.sandbox.findUnique({
      where: { id: sandbox.id },
      include: {
        createdBy: { select: { id: true, email: true, name: true } },
      },
    });

    return this.toResponseDto(updatedSandbox);
  }

  /**
   * Submit sandbox for review
   * Exports model, commits to GitHub, runs change detection + policy + CI
   */
  async submitForReview(
    sandboxId: string,
    userId: string,
    organizationId: string,
  ): Promise<SandboxResponseDto> {
    this.logger.log(`Submitting sandbox ${sandboxId} for review`);

    const sandbox = await this.getRawSandbox(sandboxId, organizationId);

    // Validate status
    if (
      sandbox.status !== SandboxStatus.ACTIVE &&
      sandbox.status !== SandboxStatus.CHANGES_REQUESTED
    ) {
      throw new BadRequestException(
        `Cannot submit sandbox in status ${sandbox.status}. Sandbox must be ACTIVE or CHANGES_REQUESTED.`,
      );
    }

    // Check for conflicts first
    const conflictCheck = await this.checkConflicts(
      sandboxId,
      userId,
      organizationId,
    );
    if (conflictCheck.hasConflicts) {
      // Update status to NEEDS_RESOLUTION
      await this.prisma.sandbox.update({
        where: { id: sandboxId },
        data: { conflictStatus: 'NEEDS_RESOLUTION' },
      });

      throw new BadRequestException(
        'Cannot submit: main branch has changed and conflicts were detected. A Pro Developer will help resolve this.',
      );
    }

    // Get app details for Mendix/GitHub operations
    const app = sandbox.appId
      ? await this.prisma.app.findFirst({
          where: { id: sandbox.appId, organizationId },
        })
      : null;

    if (!app) {
      throw new BadRequestException(
        'Sandbox is not linked to an app. Cannot submit for review.',
      );
    }

    // Get user's Mendix PAT for API calls
    const userConnection = await this.prisma.userConnection.findFirst({
      where: {
        userId,
        platform: 'MENDIX',
        isActive: true,
      },
    });

    if (!userConnection) {
      throw new BadRequestException(
        'No Mendix connection found. Please connect your Mendix account.',
      );
    }

    // Get PAT from metadata (Mendix stores PAT there) or fallback to accessToken
    const metadata = userConnection.metadata as any;
    const mendixPat = metadata?.pat || userConnection.accessToken;
    const mendixAppId = app.externalId;

    // Get projectId from app metadata - required for Platform SDK
    const appMetadata = app.metadata as any;
    const projectId =
      appMetadata?.projectId || appMetadata?.metadata?.projectId;

    if (!mendixAppId || !mendixPat) {
      throw new BadRequestException(
        'Missing Mendix app ID or PAT. Cannot export model.',
      );
    }

    this.logger.log(
      `Sync: mendixAppId=${mendixAppId}, projectId=${projectId}, PAT length=${mendixPat?.length}`,
    );

    // Verify the Mendix branch exists before proceeding
    try {
      const branches = await this.mendixService.listBranches(
        userId,
        organizationId,
        mendixAppId,
      );
      const branchExists = branches.some(
        (b) => b.name === sandbox.mendixBranch,
      );
      if (!branchExists) {
        throw new BadRequestException(
          `Mendix branch "${sandbox.mendixBranch}" does not exist. The branch may have failed to create. Please abandon this sandbox and create a new one.`,
        );
      }
    } catch (branchCheckError) {
      if (branchCheckError instanceof BadRequestException) {
        throw branchCheckError;
      }
      this.logger.warn(
        `Could not verify branch existence: ${branchCheckError.message}`,
      );
      // Continue anyway - the export will fail if branch doesn't exist
    }

    // Step 1: Export Mendix model via SDK
    let exportPath: string;
    try {
      this.logger.log(
        `Exporting Mendix model for app ${mendixAppId} branch ${sandbox.mendixBranch}`,
      );
      exportPath = await this.mendixModelSdkService.exportFullModel(
        mendixAppId,
        mendixPat,
        sandbox.mendixBranch || 'main',
        projectId, // Pass projectId for SDK (UUID required, not subdomain)
      );
      this.logger.log(`Model exported to ${exportPath}`);
    } catch (error) {
      this.logger.error(`Failed to export Mendix model: ${error.message}`);
      throw new BadRequestException(
        `Failed to export Mendix model: ${error.message}`,
      );
    }

    // Step 2: Commit to GitHub sandbox branch
    let commitResult: {
      commit: { sha: string; html_url: string };
      branch: string;
    };
    try {
      this.logger.log(
        `Committing model to GitHub branch ${sandbox.githubBranch}`,
      );
      const commitInfo = await this.githubService.commitAppSnapshot(
        app as any,
        exportPath,
        `[Sandbox] Submit for review: ${sandbox.name}`,
        sandbox.githubBranch || undefined,
      );
      commitResult = {
        commit: commitInfo,
        branch: sandbox.githubBranch || 'main',
      };
      this.logger.log(`Committed to GitHub: ${commitInfo.sha}`);
    } catch (error) {
      this.logger.error(`Failed to commit to GitHub: ${error.message}`);
      throw new BadRequestException(
        `Failed to commit to GitHub: ${error.message}`,
      );
    }

    // Update sandbox with latest GitHub SHA
    await this.prisma.sandbox.update({
      where: { id: sandboxId },
      data: {
        latestGithubSha: commitResult.commit.sha,
      },
    });

    // Step 3: Trigger change detection (creates Change records with before/after diffs)
    let changeDetectionResult: { success: boolean; changeCount: number };
    try {
      this.logger.log(`Triggering change detection for sandbox ${sandboxId}`);
      changeDetectionResult = await this.changesService.syncSandbox(
        sandboxId,
        userId,
        organizationId,
      );
      this.logger.log(
        `Change detection complete: ${changeDetectionResult.changeCount} changes`,
      );
    } catch (error) {
      this.logger.warn(`Change detection failed: ${error.message}`);
      // Don't fail the submission if change detection fails
      changeDetectionResult = { success: false, changeCount: 0 };
    }

    // Update status to PENDING_REVIEW
    const updated = await this.prisma.sandbox.update({
      where: { id: sandboxId },
      data: {
        status: SandboxStatus.PENDING_REVIEW,
        submittedAt: new Date(),
        environment: {
          ...(sandbox.environment as any),
          lastSubmission: {
            commitSha: commitResult.commit.sha,
            commitUrl: commitResult.commit.html_url,
            changesDetected: changeDetectionResult.changeCount,
            submittedAt: new Date().toISOString(),
          },
        },
      },
      include: {
        createdBy: {
          select: { id: true, email: true, name: true },
        },
      },
    });

    // CI/CD pipeline will be triggered automatically by GitHub Actions on push to sandbox/* branch

    // Notify Pro Developers about new submission
    const proDevelopers = await this.prisma.user.findMany({
      where: {
        organizationId,
        role: { in: ['PRO_DEVELOPER', 'ADMIN'] },
      },
    });

    for (const proDev of proDevelopers) {
      await this.notificationsService.create({
        userId: proDev.id,
        type: 'REVIEW_ASSIGNED',
        title: 'New Sandbox Submission',
        message: `${updated.createdBy?.name || updated.createdBy?.email} has submitted sandbox "${sandbox.name}" for review. ${changeDetectionResult.changeCount} changes detected.`,
      });
    }

    this.logger.log(
      `Sandbox ${sandboxId} submitted for review with ${changeDetectionResult.changeCount} changes`,
    );

    // Audit log with details
    await this.auditService.createAuditLog({
      userId,
      organizationId,
      action: 'UPDATE',
      entityType: 'sandbox',
      entityId: sandboxId,
      details: {
        action: 'submit_for_review',
        commitSha: commitResult.commit.sha,
        changesDetected: changeDetectionResult.changeCount,
      },
    });

    return this.toResponseDto(updated);
  }

  /**
   * Sync sandbox - Export from Team Server and commit to GitHub
   * Mirrors the current state of the Mendix branch to GitHub
   */
  async syncSandbox(
    sandboxId: string,
    userId: string,
    organizationId: string,
    changeTitle?: string,
  ): Promise<{
    success: boolean;
    message: string;
    commitSha?: string;
    commitUrl?: string;
    changesDetected: number;
    pipelineTriggered: boolean;
  }> {
    // Step 1: Validating
    this.syncProgressService.emitStep(
      sandboxId,
      SYNC_STEPS.VALIDATING,
      'in-progress',
    );

    const sandbox = await this.getRawSandbox(sandboxId, organizationId);

    if (!['ACTIVE', 'CHANGES_REQUESTED'].includes(sandbox.status)) {
      this.syncProgressService.emitError(
        sandboxId,
        SYNC_STEPS.VALIDATING.step,
        'Validation failed',
        `Cannot sync sandbox in ${sandbox.status} status`,
      );
      throw new BadRequestException(
        `Cannot sync sandbox in ${sandbox.status} status`,
      );
    }

    // Get app details
    const app = sandbox.appId
      ? await this.prisma.app.findFirst({
          where: { id: sandbox.appId, organizationId },
        })
      : null;

    if (!app) {
      this.syncProgressService.emitError(
        sandboxId,
        SYNC_STEPS.VALIDATING.step,
        'Validation failed',
        'Sandbox is not linked to an app',
      );
      throw new BadRequestException('Sandbox is not linked to an app');
    }

    // Get Mendix PAT
    const userConnection = await this.prisma.userConnection.findFirst({
      where: { userId, platform: 'MENDIX', isActive: true },
    });

    if (!userConnection) {
      this.syncProgressService.emitError(
        sandboxId,
        SYNC_STEPS.VALIDATING.step,
        'Validation failed',
        'No Mendix connection found',
      );
      throw new BadRequestException('No Mendix connection found');
    }

    const metadata = userConnection.metadata as any;
    const mendixPat = metadata?.pat || userConnection.accessToken;
    const mendixAppId = app.externalId;

    // Get projectId from app metadata - required for Platform SDK
    const appMetadata = app.metadata as any;
    const projectId =
      appMetadata?.projectId || appMetadata?.metadata?.projectId;

    // Debug logging for PAT and IDs
    this.logger.log(
      `Sync: mendixAppId=${mendixAppId}, projectId=${projectId}, PAT length=${mendixPat?.length || 0}`,
    );

    if (!mendixAppId || !mendixPat) {
      this.syncProgressService.emitError(
        sandboxId,
        SYNC_STEPS.VALIDATING.step,
        'Validation failed',
        'Missing Mendix app ID or PAT',
      );
      throw new BadRequestException('Missing Mendix app ID or PAT');
    }

    this.syncProgressService.emitStep(
      sandboxId,
      SYNC_STEPS.VALIDATING,
      'completed',
    );

    // Step 2: Verify the Mendix branch exists
    this.syncProgressService.emitStep(
      sandboxId,
      SYNC_STEPS.VERIFYING_BRANCH,
      'in-progress',
    );
    try {
      const branches = await this.mendixService.listBranches(
        userId,
        organizationId,
        mendixAppId,
      );
      const branchExists = branches.some(
        (b) => b.name === sandbox.mendixBranch,
      );
      if (!branchExists) {
        this.logger.error(
          `Mendix branch "${sandbox.mendixBranch}" does not exist for app ${mendixAppId}`,
        );
        this.syncProgressService.emitError(
          sandboxId,
          SYNC_STEPS.VERIFYING_BRANCH.step,
          'Branch not found',
          `Branch "${sandbox.mendixBranch}" does not exist`,
        );
        return {
          success: false,
          message: `Mendix branch "${sandbox.mendixBranch}" does not exist. The branch may have failed to create. Please abandon this sandbox and create a new one.`,
          changesDetected: 0,
          pipelineTriggered: false,
        };
      }
      this.syncProgressService.emitStep(
        sandboxId,
        SYNC_STEPS.VERIFYING_BRANCH,
        'completed',
        `Branch "${sandbox.mendixBranch}" verified`,
      );
    } catch (branchCheckError) {
      this.logger.warn(
        `Could not verify branch existence: ${branchCheckError.message}`,
      );
      this.syncProgressService.emitStep(
        sandboxId,
        SYNC_STEPS.VERIFYING_BRANCH,
        'completed',
        'Branch verification skipped',
      );
      // Continue anyway - the export will fail if branch doesn't exist
    }

    // Step 3: Export current state from Team Server using Git clone
    this.syncProgressService.emitStep(
      sandboxId,
      SYNC_STEPS.CLONING_REPO,
      'in-progress',
      'Downloading from Mendix Team Server...',
    );
    let exportPath: string;
    try {
      this.logger.log(
        `Syncing: Exporting from Team Server branch ${sandbox.mendixBranch} via Git clone`,
      );

      // Use Git clone if we have projectId (preferred), otherwise fall back to SDK
      if (projectId) {
        exportPath = await this.mendixModelSdkService.exportViaGitClone(
          projectId,
          mendixPat,
          sandbox.mendixBranch || 'main',
          mendixAppId,
        );
      } else {
        // Fallback to SDK export if no projectId
        this.logger.warn(`No projectId found, falling back to SDK export`);
        exportPath = await this.mendixModelSdkService.exportFullModel(
          mendixAppId,
          mendixPat,
          sandbox.mendixBranch || 'main',
          projectId,
        );
      }
      this.logger.log(`Export complete: ${exportPath}`);
      this.syncProgressService.emitStep(
        sandboxId,
        SYNC_STEPS.CLONING_REPO,
        'completed',
        'Repository cloned successfully',
      );
    } catch (error) {
      this.logger.error(`Export failed: ${error.message}`);
      this.syncProgressService.emitError(
        sandboxId,
        SYNC_STEPS.CLONING_REPO.step,
        'Clone failed',
        error.message,
      );
      return {
        success: false,
        message: `Failed to export from Team Server: ${error.message}`,
        changesDetected: 0,
        pipelineTriggered: false,
      };
    }

    // Step 4: Processing files
    this.syncProgressService.emitStep(
      sandboxId,
      SYNC_STEPS.PROCESSING_FILES,
      'in-progress',
      'Preparing files for upload...',
    );
    // Processing happens as part of the GitHub commit - this step marks the transition
    this.syncProgressService.emitStep(
      sandboxId,
      SYNC_STEPS.PROCESSING_FILES,
      'completed',
    );

    // Step 5 & 6: Upload to GitHub and create commit
    this.syncProgressService.emitStep(
      sandboxId,
      SYNC_STEPS.UPLOADING_GITHUB,
      'in-progress',
      'Uploading files to GitHub...',
    );
    let commitInfo: { sha: string; html_url: string };
    try {
      this.logger.log(`Committing to GitHub branch ${sandbox.githubBranch}`);
      commitInfo = await this.githubService.commitAppSnapshot(
        app as any,
        exportPath,
        changeTitle || `[Sync] ${sandbox.name}`,
        sandbox.githubBranch || undefined,
      );
      this.syncProgressService.emitStep(
        sandboxId,
        SYNC_STEPS.UPLOADING_GITHUB,
        'completed',
      );
      this.syncProgressService.emitStep(
        sandboxId,
        SYNC_STEPS.CREATING_COMMIT,
        'completed',
        `Commit: ${commitInfo.sha.substring(0, 7)}`,
      );
      this.logger.log(`Committed: ${commitInfo.sha}`);
    } catch (error) {
      this.logger.error(`GitHub commit failed: ${error.message}`);
      this.syncProgressService.emitError(
        sandboxId,
        SYNC_STEPS.UPLOADING_GITHUB.step,
        'Upload failed',
        error.message,
      );
      return {
        success: false,
        message: `Failed to commit to GitHub: ${error.message}`,
        changesDetected: 0,
        pipelineTriggered: false,
      };
    }

    // Update sandbox with latest SHA
    await this.prisma.sandbox.update({
      where: { id: sandboxId },
      data: {
        latestGithubSha: commitInfo.sha,
      },
    });

    // Step 7: Trigger change detection
    this.syncProgressService.emitStep(
      sandboxId,
      SYNC_STEPS.DETECTING_CHANGES,
      'in-progress',
    );
    let changeCount = 0;
    try {
      const result = await this.changesService.syncSandbox(
        sandboxId,
        userId,
        organizationId,
      );
      changeCount = result.changeCount;
      this.syncProgressService.emitStep(
        sandboxId,
        SYNC_STEPS.DETECTING_CHANGES,
        'completed',
        `${changeCount} changes detected`,
      );
    } catch (error) {
      this.logger.warn(`Change detection failed: ${error.message}`);
      this.syncProgressService.emitStep(
        sandboxId,
        SYNC_STEPS.DETECTING_CHANGES,
        'completed',
        'Change detection skipped',
      );
    }

    // Step 8: Complete - CI/CD pipeline is triggered automatically by GitHub Actions on push

    // Audit log
    await this.auditService.createAuditLog({
      userId,
      organizationId,
      action: 'UPDATE',
      entityType: 'sandbox',
      entityId: sandboxId,
      details: {
        action: 'sync',
        commitSha: commitInfo.sha,
        changesDetected: changeCount,
      },
    });

    this.logger.log(
      `Sandbox ${sandboxId} synced: ${commitInfo.sha}, ${changeCount} changes`,
    );

    // Emit completion
    this.syncProgressService.emitComplete(
      sandboxId,
      `${changeCount} changes detected`,
    );

    return {
      success: true,
      message: `Sync complete. ${changeCount} changes detected.`,
      commitSha: commitInfo.sha,
      commitUrl: commitInfo.html_url,
      changesDetected: changeCount,
      pipelineTriggered: true, // GitHub Actions triggers on push
    };
  }

  /**
   * Check for conflicts with main branch
   * Returns true if main has diverged and conflicts exist
   */
  async checkConflicts(
    sandboxId: string,
    userId: string,
    organizationId: string,
  ): Promise<{
    hasConflicts: boolean;
    conflictStatus: string;
    conflictingFiles: string[];
    message: string;
  }> {
    const sandbox = await this.getRawSandbox(sandboxId, organizationId);

    // Log who is checking for conflicts (useful for audit trail)
    this.logger.log(
      `User ${userId} checking conflicts for sandbox ${sandboxId}`,
    );

    // TODO: Implement actual conflict detection:
    // 1. Get current main branch revision from Mendix/GitHub
    // 2. Compare with sandbox's baseMendixRevision/baseGithubSha
    // 3. If main has advanced, check if modified files overlap
    // For now, use the stored conflictStatus from database

    const conflictStatus = sandbox.conflictStatus || 'NONE';
    const hasConflicts = conflictStatus === 'NEEDS_RESOLUTION';

    // Get list of potentially conflicting files (from sandbox environment metadata)
    const env = sandbox.environment as any;
    const conflictingFiles: string[] = env?.conflictingFiles || [];

    return {
      hasConflicts,
      conflictStatus,
      conflictingFiles,
      message: hasConflicts
        ? 'Conflicts detected with main branch. A Pro Developer will assist with resolution.'
        : conflictStatus === 'POTENTIAL'
          ? 'Potential conflicts detected. Review recommended before submitting.'
          : 'No conflicts detected. Ready to submit.',
    };
  }

  /**
   * Mark conflict as resolved by Pro Developer
   * @param sandboxId - The sandbox ID
   * @param userId - Pro Developer user ID
   * @param organizationId - Organization context
   * @param resolution - Description of how the conflict was resolved
   * @param mergeCommitSha - Git commit SHA after merge resolution (if applicable)
   */
  async resolveConflict(
    sandboxId: string,
    userId: string,
    organizationId: string,
    resolution?: string,
    mergeCommitSha?: string,
  ): Promise<SandboxResponseDto> {
    this.logger.log(
      `Pro Developer ${userId} resolving conflict for sandbox ${sandboxId}`,
    );

    // Verify user is a Pro Developer or Admin
    const user = await this.prisma.user.findFirst({
      where: { id: userId, organizationId },
    });

    if (!user || (user.role !== 'PRO_DEVELOPER' && user.role !== 'ADMIN')) {
      throw new ForbiddenException(
        'Only Pro Developers or Admins can resolve conflicts',
      );
    }

    const sandbox = await this.getRawSandbox(sandboxId, organizationId);

    if (sandbox.conflictStatus !== 'NEEDS_RESOLUTION') {
      throw new BadRequestException(
        'Sandbox does not have conflicts to resolve',
      );
    }

    // Build update data including resolution metadata
    const env = sandbox.environment;
    const updatedEnvironment = {
      ...env,
      conflictResolution: {
        resolvedBy: userId,
        resolvedAt: new Date().toISOString(),
        resolution: resolution || 'Conflict resolved by Pro Developer',
        mergeCommitSha: mergeCommitSha || null,
      },
      // Clear conflicting files list after resolution
      conflictingFiles: [],
    };

    // Update sandbox with resolution details
    const updated = await this.prisma.sandbox.update({
      where: { id: sandboxId },
      data: {
        conflictStatus: 'RESOLVED',
        status: SandboxStatus.ACTIVE, // Back to ACTIVE so citizen dev can resubmit
        // Update GitHub SHA if merge commit was provided
        ...(mergeCommitSha && { latestGithubSha: mergeCommitSha }),
        environment: updatedEnvironment,
      },
      include: {
        createdBy: {
          select: { id: true, email: true, name: true },
        },
      },
    });

    // Notify citizen developer with resolution details
    await this.notificationsService.create({
      userId: sandbox.createdById,
      type: 'SYSTEM',
      title: 'Conflict Resolved',
      message: `The conflicts in your sandbox "${sandbox.name}" have been resolved by ${user.name || user.email}. ${resolution ? `Resolution: ${resolution}` : 'You can now resubmit for review.'}`,
    });

    // Audit log with full resolution details
    await this.auditService.createAuditLog({
      userId,
      organizationId,
      action: 'UPDATE',
      entityType: 'sandbox',
      entityId: sandboxId,
      details: {
        action: 'resolve_conflict',
        resolution: resolution || 'Conflict resolved',
        mergeCommitSha: mergeCommitSha || null,
        resolvedBy: user.email,
      },
    });

    this.logger.log(
      `Sandbox ${sandboxId} conflict resolved. Resolution: ${resolution || 'N/A'}, Merge SHA: ${mergeCommitSha || 'N/A'}`,
    );

    return this.toResponseDto(updated);
  }

  /**
   * Abandon a sandbox (discard changes)
   */
  async abandonSandbox(
    sandboxId: string,
    userId: string,
    organizationId: string,
  ): Promise<SandboxResponseDto> {
    this.logger.log(`Abandoning sandbox ${sandboxId}`);

    const sandbox = await this.getRawSandbox(sandboxId, organizationId);

    // Only owner or admin can abandon
    if (sandbox.createdById !== userId) {
      const user = await this.prisma.user.findFirst({
        where: { id: userId, organizationId },
      });
      if (!user || user.role !== 'ADMIN') {
        throw new ForbiddenException(
          'Only the sandbox owner or admin can abandon it',
        );
      }
    }

    // Get the app to find the Mendix external ID
    const app = sandbox.appId
      ? await this.prisma.app.findFirst({
          where: { id: sandbox.appId, organizationId },
        })
      : null;

    // Update status first
    const updated = await this.prisma.sandbox.update({
      where: { id: sandboxId },
      data: { status: SandboxStatus.ABANDONED },
      include: {
        createdBy: {
          select: { id: true, email: true, name: true },
        },
      },
    });

    // Delete Mendix branch (if it exists)
    if (sandbox.mendixBranch && app?.externalId) {
      try {
        this.logger.log(`Deleting Mendix branch "${sandbox.mendixBranch}"`);
        await this.mendixService.deleteBranch(
          userId,
          organizationId,
          app.externalId,
          sandbox.mendixBranch,
        );
        this.logger.log(`Mendix branch "${sandbox.mendixBranch}" deleted`);
      } catch (error) {
        this.logger.warn(`Failed to delete Mendix branch: ${error.message}`);
        // Don't fail the abandon operation if branch deletion fails
      }
    }

    // Delete GitHub branch (if it exists)
    if (sandbox.githubBranch) {
      try {
        this.logger.log(`Deleting GitHub branch "${sandbox.githubBranch}"`);
        await this.githubService.deleteSandboxBranch(sandbox as any);
        this.logger.log(`GitHub branch deleted`);
      } catch (error) {
        this.logger.warn(`Failed to delete GitHub branch: ${error.message}`);
        // Don't fail the abandon operation if branch deletion fails
      }
    }

    // Audit log
    await this.auditService.createAuditLog({
      userId,
      organizationId,
      action: 'DELETE',
      entityType: 'sandbox',
      entityId: sandboxId,
      details: {
        action: 'abandon',
        mendixBranchDeleted: sandbox.mendixBranch || null,
        githubBranchDeleted: sandbox.githubBranch || null,
      },
    });

    this.logger.log(`Sandbox ${sandboxId} abandoned`);

    return this.toResponseDto(updated);
  }

  /**
   * Get all active sandboxes for an app
   */
  async getAppSandboxes(
    appId: string,
    organizationId: string,
  ): Promise<SandboxResponseDto[]> {
    const sandboxes = await this.prisma.sandbox.findMany({
      where: {
        appId,
        organizationId,
        status: {
          notIn: [
            SandboxStatus.MERGED,
            SandboxStatus.ABANDONED,
            SandboxStatus.DELETED,
          ],
        },
      },
      include: {
        createdBy: {
          select: { id: true, email: true, name: true },
        },
      },
      orderBy: { createdAt: 'desc' },
    });

    return sandboxes.map((s) => this.toResponseDto(s));
  }
}

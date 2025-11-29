import {
  Injectable,
  Logger,
  NotFoundException,
  BadRequestException,
  ForbiddenException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { Cron, CronExpression } from '@nestjs/schedule';
import { addDays, differenceInDays } from 'date-fns';
import { CreateSandboxDto } from './dto/create-sandbox.dto';
import { UpdateSandboxDto } from './dto/update-sandbox.dto';
import { SandboxResponseDto, SandboxStatsDto } from './dto/sandbox-response.dto';
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

// Type helper for Sandbox with new schema fields
type SandboxWithRelations = {
  id: string;
  organizationId: string;
  createdById: string;
  name: string;
  description: string | null;
  status: string;
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
  ) {
    // Initialize provisioners map
    this.provisioners = new Map<SandboxPlatform, IEnvironmentProvisioner>([
      [SandboxPlatform.POWERAPPS, this.powerAppsProvisioner as IEnvironmentProvisioner],
      [SandboxPlatform.MENDIX, this.mendixProvisioner as IEnvironmentProvisioner],
    ]);
  }

  /**
   * Create sandbox with environment provisioning
   */
  async create(
    dto: CreateSandboxDto,
    userId: string,
    organizationId: string,
  ): Promise<SandboxResponseDto> {
    this.logger.log(
      `Creating ${dto.platform} sandbox "${dto.name}" for org ${organizationId}`,
    );

    // Check quotas
    await this.checkQuotas(organizationId, dto.type);

    // Calculate expiration date
    const quota = SANDBOX_QUOTAS[dto.type];
    const expiresAt = dto.expiresAt
      ? new Date(dto.expiresAt)
      : addDays(new Date(), quota.maxDuration);

    // Create sandbox record first (status: PROVISIONING)
    const sandbox = await this.prisma.sandbox.create({
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
      } as any,
      include: {
        createdBy: {
          select: {
            id: true,
            email: true,
            name: true,
          },
        },
      } as any,
    }) as any as SandboxWithRelations;

    // Audit log
    await (this.auditService as any).log({
      userId,
      action: 'CREATE_SANDBOX',
      entityType: 'sandbox',
      entityId: sandbox.id,
      details: { name: dto.name, platform: dto.platform, type: dto.type },
    });

    // Provision environment asynchronously
    this.provisionEnvironment(sandbox.id, dto.platform, dto, userId, organizationId)
      .catch((error) => {
        this.logger.error(
          `Failed to provision sandbox ${sandbox.id}: ${error.message}`,
        );
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
      const config = this.preparePlatformConfig(dto, organizationId);

      // Provision environment
      const envDetails = await provisioner.provision(config);

      // Update sandbox with environment details
      await this.prisma.sandbox.update({
        where: { id: sandboxId },
        data: {
          status: SandboxStatus.ACTIVE,
          environment: {
            ...(await this.getSandboxEnvironment(sandboxId)),
            provisioningStatus: ProvisioningStatus.COMPLETED,
            environmentId: envDetails.environmentId,
            environmentUrl: envDetails.environmentUrl,
            region: envDetails.region,
            metadata: envDetails.metadata,
          },
        },
      });

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
    const where: any = { organizationId };

    if (filters) {
      if (filters.platform) {
        where.environment = {
          path: ['platform'],
          equals: filters.platform,
        };
      }
      if (filters.status) where.status = filters.status;
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
  async findOne(id: string, organizationId: string): Promise<SandboxResponseDto> {
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
          await provisioner.deprovision(userId, organizationId, env.environmentId);
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
      action: 'DELETE_SANDBOX' as any,
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
    const env = sandbox.environment as any;

    if (!env?.environmentId) {
      throw new BadRequestException('Sandbox has no provisioned environment');
    }

    const provisioner = this.provisioners.get(env.platform);
    if (!provisioner) {
      throw new BadRequestException(`Provisioner for ${env.platform} not found`);
    }

    await provisioner.start(userId, organizationId, env.environmentId);

    await this.prisma.sandbox.update({
      where: { id },
      data: { status: SandboxStatus.ACTIVE },
    });

    await this.auditService.createAuditLog({
      userId,
      organizationId,
      action: 'START_SANDBOX' as any,
      entityType: 'sandbox',
      entityId: id,
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
    const env = sandbox.environment as any;

    if (!env?.environmentId) {
      throw new BadRequestException('Sandbox has no provisioned environment');
    }

    const provisioner = this.provisioners.get(env.platform);
    if (!provisioner) {
      throw new BadRequestException(`Provisioner for ${env.platform} not found`);
    }

    await provisioner.stop(userId, organizationId, env.environmentId);

    await this.prisma.sandbox.update({
      where: { id },
      data: { status: SandboxStatus.SUSPENDED },
    });

    await this.auditService.createAuditLog({
      userId,
      organizationId,
      action: 'STOP_SANDBOX' as any,
      entityType: 'sandbox',
      entityId: id,
    });

    this.logger.log(`Stopped sandbox ${id}`);
  }

  /**
   * Get sandbox statistics
   */
  async getStats(
    id: string,
    organizationId: string,
  ): Promise<SandboxStatsDto> {
    const sandbox = await this.getRawSandbox(id, organizationId);
    const env = sandbox.environment as any;

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
      throw new BadRequestException(`Provisioner for ${env.platform} not found`);
    }

    const resources = await provisioner.getResourceUsage(sandbox.createdById, organizationId, env.environmentId);

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
      action: 'EXTEND_SANDBOX_EXPIRATION' as any,
      entityType: 'sandbox',
      entityId: id,
      details: { newExpiration: expiresAt },
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
          await provisioner?.deprovision(sandbox.createdById, sandbox.organizationId, env.environmentId);
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
  private async getRawSandbox(id: string, organizationId: string): Promise<SandboxWithRelations> {
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

    return sandbox as any as SandboxWithRelations;
  }

  /**
   * Helper: Prepare platform-specific config
   */
  private preparePlatformConfig(
    dto: CreateSandboxDto,
    organizationId: string,
  ): any {
    if (dto.platform === SandboxPlatform.POWERAPPS) {
      return {
        displayName: `Sandbox: ${dto.name}`,
        environmentType: 'Developer',
        region: dto.platformConfig?.region || 'unitedstates',
        ...dto.platformConfig,
      };
    } else {
      return {
        name: dto.name,
        template: dto.platformConfig?.template || 'blank',
        mode: 'sandbox',
        ...dto.platformConfig,
      };
    }
  }

  /**
   * Helper: Convert Prisma model to response DTO
   */
  private toResponseDto(sandbox: any): SandboxResponseDto {
    const env = sandbox.environment as any;

    return {
      id: sandbox.id,
      organizationId: sandbox.organizationId,
      createdById: sandbox.createdById,
      name: sandbox.name,
      description: sandbox.description,
      platform: env?.platform || SandboxPlatform.POWERAPPS,
      type: env?.type || SandboxType.PERSONAL,
      status: sandbox.status,
      provisioningStatus:
        env?.provisioningStatus || ProvisioningStatus.PENDING,
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
}

import {
  Injectable,
  Logger,
  NotFoundException,
  ConflictException,
  BadRequestException,
} from '@nestjs/common';
import { PrismaService } from '../../../prisma/prisma.service';
import { PowerAppsService } from '../powerapps.service';
import { AuditService } from '../../../common/audit/audit.service';
import {
  CreateLinkedEnvironmentDto,
  LinkedEnvironmentPlatform,
} from './dto/create-linked-environment.dto';
import {
  LinkedEnvironmentResponseDto,
  LinkedEnvironmentWithAppsDto,
} from './dto/linked-environment-response.dto';

/**
 * Service for managing linked external environments (PowerApps)
 *
 * Linked environments are external platform environments connected to LDV-Bridge
 * for browsing and syncing apps. This is separate from Sandbox which is an app workspace.
 */
@Injectable()
export class LinkedEnvironmentsService {
  private readonly logger = new Logger(LinkedEnvironmentsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly powerAppsService: PowerAppsService,
    private readonly auditService: AuditService,
  ) {}

  /**
   * Link an existing PowerApps environment to LDV-Bridge
   */
  async create(
    dto: CreateLinkedEnvironmentDto,
    userId: string,
    organizationId: string,
  ): Promise<LinkedEnvironmentResponseDto> {
    this.logger.log(
      `Linking ${dto.platform} environment "${dto.environmentId}" for org ${organizationId}`,
    );

    // Check if already linked
    const existing = await this.prisma.linkedEnvironment.findUnique({
      where: {
        organizationId_environmentId: {
          organizationId,
          environmentId: dto.environmentId,
        },
      },
    });

    if (existing) {
      throw new ConflictException(
        `Environment ${dto.environmentId} is already linked to this organization`,
      );
    }

    // Verify environment exists and get details
    let environmentDetails: any;
    try {
      if (dto.platform === LinkedEnvironmentPlatform.POWERAPPS) {
        environmentDetails = await this.powerAppsService.getEnvironment(
          userId,
          organizationId,
          dto.environmentId,
        );
      }
    } catch (error) {
      this.logger.error(`Failed to verify environment: ${error.message}`);
      throw new BadRequestException(
        `Could not verify environment ${dto.environmentId}. Make sure you're connected to ${dto.platform} and the environment exists.`,
      );
    }

    // Create linked environment record
    const linkedEnv = await this.prisma.linkedEnvironment.create({
      data: {
        organizationId,
        createdById: userId,
        name: dto.name,
        description: dto.description,
        platform: dto.platform,
        environmentId: dto.environmentId,
        environmentUrl:
          dto.environmentUrl ||
          environmentDetails?.properties?.linkedEnvironmentMetadata
            ?.instanceUrl ||
          null,
        region: dto.region || environmentDetails?.location || null,
        metadata: {
          originalName:
            environmentDetails?.properties?.displayName ||
            environmentDetails?.name,
          environmentSku: environmentDetails?.properties?.environmentSku,
          isDefault: environmentDetails?.properties?.isDefault,
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
    });

    // Audit log
    await this.auditService.createAuditLog({
      userId,
      organizationId,
      action: 'CREATE',
      entityType: 'linked_environment',
      entityId: linkedEnv.id,
      details: {
        name: dto.name,
        platform: dto.platform,
        environmentId: dto.environmentId,
      },
    });

    this.logger.log(
      `Successfully linked environment ${dto.environmentId} as ${linkedEnv.id}`,
    );

    return this.toResponseDto(linkedEnv);
  }

  /**
   * List all linked environments for an organization
   */
  async findAll(
    organizationId: string,
    filters?: {
      platform?: LinkedEnvironmentPlatform;
      isActive?: boolean;
    },
  ): Promise<LinkedEnvironmentResponseDto[]> {
    const where: any = { organizationId };

    if (filters?.platform) {
      where.platform = filters.platform;
    }
    if (filters?.isActive !== undefined) {
      where.isActive = filters.isActive;
    }

    const environments = await this.prisma.linkedEnvironment.findMany({
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
      orderBy: { createdAt: 'desc' },
    });

    return environments.map((env) => this.toResponseDto(env));
  }

  /**
   * Get a linked environment by ID
   */
  async findOne(
    id: string,
    organizationId: string,
  ): Promise<LinkedEnvironmentResponseDto> {
    const env = await this.prisma.linkedEnvironment.findFirst({
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

    if (!env) {
      throw new NotFoundException(`Linked environment ${id} not found`);
    }

    return this.toResponseDto(env);
  }

  /**
   * Get a linked environment with apps from the platform
   */
  async findOneWithApps(
    id: string,
    organizationId: string,
    userId: string,
  ): Promise<LinkedEnvironmentWithAppsDto> {
    const env = await this.prisma.linkedEnvironment.findFirst({
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

    if (!env) {
      throw new NotFoundException(`Linked environment ${id} not found`);
    }

    // Fetch apps from the platform
    let apps: any[] = [];
    try {
      if (env.platform === 'POWERAPPS') {
        apps = await this.powerAppsService.listApps(
          userId,
          organizationId,
          env.environmentId,
        );
      }
    } catch (error) {
      this.logger.warn(
        `Failed to fetch apps for environment ${id}: ${error.message}`,
      );
    }

    return {
      ...this.toResponseDto(env),
      apps,
    };
  }

  /**
   * Unlink an environment (soft delete - sets isActive to false)
   */
  async remove(
    id: string,
    organizationId: string,
    userId: string,
  ): Promise<void> {
    const env = await this.findOne(id, organizationId);

    await this.prisma.linkedEnvironment.update({
      where: { id },
      data: { isActive: false },
    });

    await this.auditService.createAuditLog({
      userId,
      organizationId,
      action: 'DELETE',
      entityType: 'linked_environment',
      entityId: id,
      details: { name: env.name },
    });

    this.logger.log(`Unlinked environment ${id}`);
  }

  /**
   * Hard delete a linked environment
   */
  async hardDelete(
    id: string,
    organizationId: string,
    userId: string,
  ): Promise<void> {
    const env = await this.findOne(id, organizationId);

    await this.prisma.linkedEnvironment.delete({
      where: { id },
    });

    await this.auditService.createAuditLog({
      userId,
      organizationId,
      action: 'DELETE',
      entityType: 'linked_environment',
      entityId: id,
      details: { name: env.name, hardDelete: true },
    });

    this.logger.log(`Hard deleted environment ${id}`);
  }

  /**
   * Convert database entity to response DTO
   */
  private toResponseDto(env: any): LinkedEnvironmentResponseDto {
    return {
      id: env.id,
      organizationId: env.organizationId,
      name: env.name,
      description: env.description,
      platform: env.platform,
      environmentId: env.environmentId,
      environmentUrl: env.environmentUrl,
      region: env.region,
      isActive: env.isActive,
      createdAt: env.createdAt,
      updatedAt: env.updatedAt,
      createdBy: env.createdBy,
    };
  }
}

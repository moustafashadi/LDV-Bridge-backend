import {
  Injectable,
  NotFoundException,
  BadRequestException,
  ForbiddenException,
  Logger,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../common/audit/audit.service';
import { CreateComponentDto } from './dto/create-component.dto';
import { UpdateComponentDto } from './dto/update-component.dto';
import {
  ComponentResponseDto,
  ComponentListResponseDto,
  ExtractComponentsResponseDto,
} from './dto/component-response.dto';
import { ComponentType, PlatformType, Prisma } from '@prisma/client';

@Injectable()
export class ComponentsService {
  private readonly logger = new Logger(ComponentsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly auditService: AuditService,
  ) {}

  /**
   * Create a new component
   */
  async create(
    createComponentDto: CreateComponentDto,
    userId: string,
    organizationId: string,
  ): Promise<ComponentResponseDto> {
    // Verify app exists and belongs to organization
    const app = await this.prisma.app.findFirst({
      where: {
        id: createComponentDto.appId,
        organizationId,
      },
    });

    if (!app) {
      throw new NotFoundException(
        `App with ID ${createComponentDto.appId} not found`,
      );
    }

    // Create component
    const component = await this.prisma.component.create({
      data: {
        appId: createComponentDto.appId,
        externalId: createComponentDto.externalId,
        name: createComponentDto.name,
        type: createComponentDto.type,
        path: createComponentDto.path,
        properties: createComponentDto.properties as Prisma.InputJsonValue,
        codeBlock: createComponentDto.codeBlock,
        metadata: createComponentDto.metadata as Prisma.InputJsonValue,
      },
      include: {
        app: {
          select: {
            name: true,
          },
        },
      },
    });

    // Create audit log
    await this.auditService.createAuditLog({
      userId,
      organizationId,
      action: 'CREATE',
      entityType: 'component',
      entityId: component.id,
      details: {
        componentName: component.name,
        componentType: component.type,
        appId: component.appId,
      },
    });

    this.logger.log(
      `Component created: ${component.name} (${component.id}) for app ${app.name}`,
    );

    return this.mapToResponseDto(component);
  }

  /**
   * Find all components with filters and pagination
   */
  async findAll(
    organizationId: string,
    filters: {
      appId?: string;
      type?: ComponentType;
      search?: string;
      tags?: string;
      isReusable?: boolean;
      page?: number;
      limit?: number;
    },
  ): Promise<ComponentListResponseDto> {
    const page = filters.page || 1;
    const limit = filters.limit || 20;
    const skip = (page - 1) * limit;

    // Build where clause
    const where: any = {
      app: {
        organizationId,
      },
    };

    if (filters.appId) {
      where.appId = filters.appId;
    }

    if (filters.type) {
      where.type = filters.type;
    }

    if (filters.search) {
      where.OR = [
        { name: { contains: filters.search, mode: 'insensitive' } },
        { path: { contains: filters.search, mode: 'insensitive' } },
      ];
    }

    // Tag filtering requires JSON path query
    if (filters.tags) {
      const tagList = filters.tags.split(',').map((t) => t.trim());
      where.metadata = {
        path: ['tags'],
        array_contains: tagList,
      };
    }

    // Reusable filtering
    if (filters.isReusable !== undefined) {
      where.metadata = {
        ...where.metadata,
        path: ['isReusable'],
        equals: filters.isReusable,
      };
    }

    // Get total count
    const total = await this.prisma.component.count({ where });

    // Get paginated records
    const components = await this.prisma.component.findMany({
      where,
      skip,
      take: limit,
      orderBy: { createdAt: 'desc' },
      include: {
        app: {
          select: {
            name: true,
          },
        },
      },
    });

    const data = components.map((component) =>
      this.mapToResponseDto(component),
    );

    const totalPages = Math.ceil(total / limit);

    return {
      data,
      pagination: {
        total,
        page,
        limit,
        totalPages,
        hasMore: page < totalPages,
      },
    };
  }

  /**
   * Find one component by ID
   */
  async findOne(
    id: string,
    organizationId: string,
  ): Promise<ComponentResponseDto> {
    const component = await this.prisma.component.findFirst({
      where: {
        id,
        app: {
          organizationId,
        },
      },
      include: {
        app: {
          select: {
            name: true,
          },
        },
      },
    });

    if (!component) {
      throw new NotFoundException(`Component with ID ${id} not found`);
    }

    return this.mapToResponseDto(component);
  }

  /**
   * Update component
   */
  async update(
    id: string,
    updateComponentDto: UpdateComponentDto,
    userId: string,
    organizationId: string,
  ): Promise<ComponentResponseDto> {
    // Verify component exists and belongs to organization
    const existing = await this.prisma.component.findFirst({
      where: {
        id,
        app: {
          organizationId,
        },
      },
      include: {
        app: true,
      },
    });

    if (!existing) {
      throw new NotFoundException(`Component with ID ${id} not found`);
    }

    // Update component
    const component = await this.prisma.component.update({
      where: { id },
      data: {
        name: updateComponentDto.name,
        type: updateComponentDto.type,
        path: updateComponentDto.path,
        properties: updateComponentDto.properties as Prisma.InputJsonValue,
        codeBlock: updateComponentDto.codeBlock,
        metadata: updateComponentDto.metadata as Prisma.InputJsonValue,
      },
      include: {
        app: {
          select: {
            name: true,
          },
        },
      },
    });

    // Create audit log
    await this.auditService.createAuditLog({
      userId,
      organizationId,
      action: 'UPDATE',
      entityType: 'component',
      entityId: component.id,
      details: {
        componentName: component.name,
        changes: updateComponentDto,
      },
    });

    this.logger.log(`Component updated: ${component.name} (${component.id})`);

    return this.mapToResponseDto(component);
  }

  /**
   * Delete component
   */
  async remove(
    id: string,
    userId: string,
    organizationId: string,
  ): Promise<void> {
    // Verify component exists and belongs to organization
    const component = await this.prisma.component.findFirst({
      where: {
        id,
        app: {
          organizationId,
        },
      },
    });

    if (!component) {
      throw new NotFoundException(`Component with ID ${id} not found`);
    }

    // Delete component
    await this.prisma.component.delete({
      where: { id },
    });

    // Create audit log
    await this.auditService.createAuditLog({
      userId,
      organizationId,
      action: 'DELETE',
      entityType: 'component',
      entityId: id,
      details: {
        componentName: component.name,
        componentType: component.type,
      },
    });

    this.logger.log(`Component deleted: ${component.name} (${id})`);
  }

  /**
   * Get reusable components library
   */
  async findReusable(
    organizationId: string,
    filters: {
      type?: ComponentType;
      tags?: string;
      page?: number;
      limit?: number;
    },
  ): Promise<ComponentListResponseDto> {
    return this.findAll(organizationId, {
      ...filters,
      isReusable: true,
    });
  }

  /**
   * Search components by query
   */
  async search(
    query: string,
    organizationId: string,
    page?: number,
    limit?: number,
  ): Promise<ComponentListResponseDto> {
    return this.findAll(organizationId, {
      search: query,
      page,
      limit,
    });
  }

  /**
   * Extract components from synced app metadata
   */
  async extractFromApp(
    appId: string,
    userId: string,
    organizationId: string,
  ): Promise<ExtractComponentsResponseDto> {
    // Verify app exists and belongs to organization
    const app = await this.prisma.app.findFirst({
      where: {
        id: appId,
        organizationId,
      },
      include: {
        components: true,
      },
    });

    if (!app) {
      throw new NotFoundException(`App with ID ${appId} not found`);
    }

    if (!app.metadata) {
      throw new BadRequestException(
        `App ${app.name} has no metadata. Please sync the app first.`,
      );
    }

    let extractedCount = 0;

    try {
      if (app.platform === PlatformType.POWERAPPS) {
        extractedCount = await this.extractPowerAppsComponents(
          app,
          userId,
          organizationId,
        );
      } else if (app.platform === PlatformType.MENDIX) {
        extractedCount = await this.extractMendixComponents(
          app,
          userId,
          organizationId,
        );
      } else {
        throw new BadRequestException(
          `Component extraction not supported for platform: ${app.platform}`,
        );
      }

      // Create audit log
      await this.auditService.createAuditLog({
        userId,
        organizationId,
        action: 'CREATE',
        entityType: 'component',
        entityId: appId,
        details: {
          action: 'extract_components',
          appName: app.name,
          componentsExtracted: extractedCount,
          platform: app.platform,
        },
      });

      this.logger.log(
        `Extracted ${extractedCount} components from app ${app.name} (${appId})`,
      );

      return {
        success: true,
        message: `Extracted ${extractedCount} components from app`,
        componentsExtracted: extractedCount,
        appId: app.id,
        appName: app.name,
      };
    } catch (error) {
      this.logger.error(
        `Failed to extract components from app ${app.name}: ${error.message}`,
        error.stack,
      );
      throw error;
    }
  }

  /**
   * Extract PowerApps components from metadata
   */
  private async extractPowerAppsComponents(
    app: any,
    userId: string,
    organizationId: string,
  ): Promise<number> {
    const metadata = app.metadata as any;
    let count = 0;

    // Extract screens
    if (metadata.properties?.screens) {
      for (const screen of metadata.properties.screens) {
        await this.createComponentIfNotExists({
          appId: app.id,
          externalId: screen.name,
          name: screen.name,
          type: ComponentType.SCREEN,
          path: `/screens/${screen.name}`,
          properties: screen.properties,
          metadata: {
            version: '1.0.0',
            platform: 'POWERAPPS',
            extractedAt: new Date().toISOString(),
          },
        });
        count++;
      }
    }

    // Extract formulas (if available)
    if (metadata.properties?.formulas) {
      for (const formula of metadata.properties.formulas) {
        await this.createComponentIfNotExists({
          appId: app.id,
          externalId: formula.name,
          name: formula.name,
          type: ComponentType.FORMULA,
          codeBlock: formula.expression,
          metadata: {
            version: '1.0.0',
            platform: 'POWERAPPS',
            extractedAt: new Date().toISOString(),
          },
        });
        count++;
      }
    }

    // Extract data sources
    if (metadata.properties?.dataSources) {
      for (const ds of metadata.properties.dataSources) {
        await this.createComponentIfNotExists({
          appId: app.id,
          externalId: ds.name,
          name: ds.name,
          type: ComponentType.DATA_MODEL,
          properties: ds,
          metadata: {
            version: '1.0.0',
            platform: 'POWERAPPS',
            extractedAt: new Date().toISOString(),
          },
        });
        count++;
      }
    }

    return count;
  }

  /**
   * Extract Mendix components from metadata
   */
  private async extractMendixComponents(
    app: any,
    userId: string,
    organizationId: string,
  ): Promise<number> {
    const metadata = app.metadata as any;
    let count = 0;

    // Extract pages
    if (metadata.pages) {
      for (const page of metadata.pages) {
        await this.createComponentIfNotExists({
          appId: app.id,
          externalId: page.id,
          name: page.name,
          type: ComponentType.SCREEN,
          path: page.path,
          properties: page.properties,
          metadata: {
            version: '1.0.0',
            platform: 'MENDIX',
            extractedAt: new Date().toISOString(),
          },
        });
        count++;
      }
    }

    // Extract microflows
    if (metadata.microflows) {
      for (const microflow of metadata.microflows) {
        await this.createComponentIfNotExists({
          appId: app.id,
          externalId: microflow.id,
          name: microflow.name,
          type: ComponentType.MICROFLOW,
          path: microflow.path,
          codeBlock: microflow.definition,
          metadata: {
            version: '1.0.0',
            platform: 'MENDIX',
            extractedAt: new Date().toISOString(),
          },
        });
        count++;
      }
    }

    // Extract entities
    if (metadata.entities) {
      for (const entity of metadata.entities) {
        await this.createComponentIfNotExists({
          appId: app.id,
          externalId: entity.id,
          name: entity.name,
          type: ComponentType.DATA_MODEL,
          properties: entity,
          metadata: {
            version: '1.0.0',
            platform: 'MENDIX',
            extractedAt: new Date().toISOString(),
          },
        });
        count++;
      }
    }

    return count;
  }

  /**
   * Create component if it doesn't already exist (based on appId + externalId)
   */
  private async createComponentIfNotExists(data: {
    appId: string;
    externalId?: string;
    name: string;
    type: ComponentType;
    path?: string;
    properties?: any;
    codeBlock?: string;
    metadata?: any;
  }): Promise<void> {
    // Check if component already exists
    if (data.externalId) {
      const existing = await this.prisma.component.findFirst({
        where: {
          appId: data.appId,
          externalId: data.externalId,
        },
      });

      if (existing) {
        // Update existing component
        await this.prisma.component.update({
          where: { id: existing.id },
          data: {
            name: data.name,
            type: data.type,
            path: data.path,
            properties: data.properties as Prisma.InputJsonValue,
            codeBlock: data.codeBlock,
            metadata: data.metadata as Prisma.InputJsonValue,
          },
        });
        return;
      }
    }

    // Create new component
    await this.prisma.component.create({
      data: {
        appId: data.appId,
        externalId: data.externalId,
        name: data.name,
        type: data.type,
        path: data.path,
        properties: data.properties as Prisma.InputJsonValue,
        codeBlock: data.codeBlock,
        metadata: data.metadata as Prisma.InputJsonValue,
      },
    });
  }

  /**
   * Map component to response DTO
   */
  private mapToResponseDto(component: any): ComponentResponseDto {
    const metadata = component.metadata as any || {};

    return {
      id: component.id,
      appId: component.appId,
      appName: component.app?.name || 'Unknown App',
      externalId: component.externalId ?? undefined,
      name: component.name,
      type: component.type,
      path: component.path ?? undefined,
      properties: component.properties as Record<string, any>,
      codeBlock: component.codeBlock ?? undefined,
      metadata: metadata,
      createdAt: component.createdAt,
      updatedAt: component.updatedAt,
      version: metadata.version,
      isReusable: metadata.isReusable,
      tags: metadata.tags,
    };
  }
}

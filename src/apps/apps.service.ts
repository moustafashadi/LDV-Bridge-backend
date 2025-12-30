import {
  Injectable,
  NotFoundException,
  ForbiddenException,
  BadRequestException,
  Logger,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { AppStatus } from '@prisma/client';
import {
  GrantAppAccessDto,
  UpdateAppAccessDto,
} from './dto/grant-app-access.dto';
import { CreateAppDto } from './dto/create-app.dto';

@Injectable()
export class AppsService {
  private readonly logger = new Logger(AppsService.name);

  constructor(private prisma: PrismaService) {}

  /**
   * Create a new app
   */
  async createApp(userId: string, organizationId: string, dto: CreateAppDto) {
    this.logger.log(
      `Creating new app: ${dto.name} for organization ${organizationId}`,
    );

    // If externalId is provided, check for duplicates
    if (dto.externalId) {
      const existingApp = await this.prisma.app.findUnique({
        where: {
          organizationId_externalId_platform: {
            organizationId,
            externalId: dto.externalId,
            platform: dto.platform,
          },
        },
      });

      if (existingApp) {
        throw new BadRequestException(
          `App with external ID ${dto.externalId} already exists in this organization`,
        );
      }
    }

    // If connectorId is provided, verify it exists
    if (dto.connectorId) {
      const connector = await this.prisma.platformConnector.findFirst({
        where: {
          id: dto.connectorId,
          organizationId,
          platform: dto.platform,
        },
      });

      if (!connector) {
        throw new NotFoundException(
          'Connector not found or does not belong to organization',
        );
      }
    }

    // Create the app
    const app = await this.prisma.app.create({
      data: {
        name: dto.name,
        description: dto.description,
        platform: dto.platform,
        status: (dto.status as AppStatus) || AppStatus.DRAFT,
        version: dto.version,
        metadata: dto.metadata || {},
        externalId: dto.externalId || `local-${Date.now()}`, // Generate local ID if not syncing
        organizationId,
        ownerId: userId,
        connectorId: dto.connectorId || userId, // Use userId as fallback if no connector
      },
      include: {
        owner: {
          select: {
            id: true,
            name: true,
            email: true,
          },
        },
      },
    });

    this.logger.log(`Successfully created app ${app.name} (${app.id})`);

    return app;
  }

  /**
   * Delete an app and all its related records
   * Used for rollback when app creation fails
   */
  async deleteApp(appId: string, organizationId: string): Promise<void> {
    const app = await this.prisma.app.findFirst({
      where: { id: appId, organizationId },
    });

    if (!app) {
      throw new NotFoundException('App not found');
    }

    this.logger.log(
      `[DELETE_APP] Deleting app ${appId} and related records...`,
    );

    // Delete in order of dependencies
    // 1. Delete reviews related to changes
    await this.prisma.review.deleteMany({
      where: {
        change: {
          appId,
        },
      },
    });

    // 2. Delete changes
    await this.prisma.change.deleteMany({ where: { appId } });

    // 3. Delete sandboxes
    await this.prisma.sandbox.deleteMany({ where: { appId } });

    // 4. Delete permissions
    await this.prisma.appPermission.deleteMany({ where: { appId } });

    // 5. Delete the app itself
    await this.prisma.app.delete({ where: { id: appId } });

    this.logger.log(`[DELETE_APP] Successfully deleted app ${appId}`);
  }

  /**
   * Get all apps in the organization
   */
  async getAllApps(organizationId: string) {
    return this.prisma.app.findMany({
      where: {
        organizationId,
      },
      select: {
        id: true,
        name: true,
        description: true,
        platform: true,
        status: true,
        ownerId: true,
        owner: {
          select: {
            id: true,
            name: true,
            email: true,
          },
        },
        createdAt: true,
        updatedAt: true,
      },
      orderBy: {
        name: 'asc',
      },
    });
  }

  /**
   * Get a single app by ID
   */
  async getAppById(appId: string, organizationId: string) {
    const app = await this.prisma.app.findFirst({
      where: {
        id: appId,
        organizationId,
      },
      include: {
        owner: {
          select: {
            id: true,
            name: true,
            email: true,
          },
        },
        sandboxes: {
          select: {
            id: true,
            name: true,
            status: true,
            createdAt: true,
          },
          orderBy: {
            createdAt: 'desc',
          },
          take: 10,
        },
        changes: {
          select: {
            id: true,
            changeType: true,
            description: true,
            createdAt: true,
          },
          orderBy: {
            createdAt: 'desc',
          },
          take: 10,
        },
      },
    });

    if (!app) {
      throw new NotFoundException('App not found');
    }

    return app;
  }

  /**
   * Grant access to an app for one or more users
   */
  async grantAccess(
    appId: string,
    grantedByUserId: string,
    organizationId: string,
    dto: GrantAppAccessDto,
  ) {
    // Verify app exists and belongs to organization
    const app = await this.prisma.app.findFirst({
      where: {
        id: appId,
        organizationId,
      },
      include: {
        owner: true,
      },
    });

    if (!app) {
      throw new NotFoundException('App not found');
    }

    // Check if granting user has permission (must be owner, admin, or have OWNER access level)
    const grantingUser = await this.prisma.user.findUnique({
      where: { id: grantedByUserId },
    });

    if (!grantingUser) {
      throw new NotFoundException('Granting user not found');
    }

    const canGrant =
      grantingUser.role === 'ADMIN' ||
      app.ownerId === grantedByUserId ||
      (await this.hasAccessLevel(appId, grantedByUserId, 'OWNER'));

    if (!canGrant) {
      throw new ForbiddenException(
        'You do not have permission to grant access to this app',
      );
    }

    // Verify all users exist and belong to the same organization
    const users = await this.prisma.user.findMany({
      where: {
        id: { in: dto.userIds },
        organizationId,
      },
    });

    if (users.length !== dto.userIds.length) {
      throw new BadRequestException(
        'One or more users not found or not in the same organization',
      );
    }

    // Create or update permissions for each user
    const permissions = await Promise.all(
      dto.userIds.map((userId) =>
        this.prisma.appPermission.upsert({
          where: {
            appId_userId: {
              appId,
              userId,
            },
          },
          update: {
            accessLevel: dto.accessLevel,
            grantedBy: grantedByUserId,
            grantedAt: new Date(),
            expiresAt: dto.expiresAt ? new Date(dto.expiresAt) : null,
          },
          create: {
            appId,
            userId,
            accessLevel: dto.accessLevel,
            grantedBy: grantedByUserId,
            expiresAt: dto.expiresAt ? new Date(dto.expiresAt) : null,
          },
          include: {
            user: {
              select: {
                id: true,
                email: true,
                name: true,
                displayName: true,
                role: true,
              },
            },
          },
        }),
      ),
    );

    this.logger.log(
      `User ${grantedByUserId} granted ${dto.accessLevel} access to app ${appId} for ${dto.userIds.length} user(s)`,
    );

    return permissions;
  }

  /**
   * Get all users with access to an app
   */
  async getAppAccess(appId: string, organizationId: string) {
    // Verify app exists and belongs to organization
    const app = await this.prisma.app.findFirst({
      where: {
        id: appId,
        organizationId,
      },
    });

    if (!app) {
      throw new NotFoundException('App not found');
    }

    const permissions = await this.prisma.appPermission.findMany({
      where: {
        appId,
      },
      include: {
        user: {
          select: {
            id: true,
            email: true,
            name: true,
            displayName: true,
            avatarUrl: true,
            role: true,
            status: true,
          },
        },
        grantedByUser: {
          select: {
            id: true,
            email: true,
            displayName: true,
          },
        },
      },
      orderBy: {
        grantedAt: 'desc',
      },
    });

    return permissions;
  }

  /**
   * Update access level for a user
   */
  async updateAccess(
    appId: string,
    userId: string,
    updatedByUserId: string,
    organizationId: string,
    dto: UpdateAppAccessDto,
  ) {
    // Verify app exists
    const app = await this.prisma.app.findFirst({
      where: {
        id: appId,
        organizationId,
      },
    });

    if (!app) {
      throw new NotFoundException('App not found');
    }

    // Check permission
    const updatingUser = await this.prisma.user.findUnique({
      where: { id: updatedByUserId },
    });

    const canUpdate =
      updatingUser?.role === 'ADMIN' ||
      app.ownerId === updatedByUserId ||
      (await this.hasAccessLevel(appId, updatedByUserId, 'OWNER'));

    if (!canUpdate) {
      throw new ForbiddenException(
        'You do not have permission to update access to this app',
      );
    }

    // Find existing permission
    const permission = await this.prisma.appPermission.findUnique({
      where: {
        appId_userId: {
          appId,
          userId,
        },
      },
    });

    if (!permission) {
      throw new NotFoundException('User does not have access to this app');
    }

    // Update permission
    const updated = await this.prisma.appPermission.update({
      where: { id: permission.id },
      data: {
        accessLevel: dto.accessLevel,
        expiresAt: dto.expiresAt ? new Date(dto.expiresAt) : null,
        updatedAt: new Date(),
      },
      include: {
        user: {
          select: {
            id: true,
            email: true,
            name: true,
            displayName: true,
            role: true,
          },
        },
      },
    });

    this.logger.log(
      `User ${updatedByUserId} updated access for user ${userId} on app ${appId} to ${dto.accessLevel}`,
    );

    return updated;
  }

  /**
   * Revoke access from a user
   */
  async revokeAccess(
    appId: string,
    userId: string,
    revokedByUserId: string,
    organizationId: string,
  ) {
    // Verify app exists
    const app = await this.prisma.app.findFirst({
      where: {
        id: appId,
        organizationId,
      },
    });

    if (!app) {
      throw new NotFoundException('App not found');
    }

    // Check permission
    const revokingUser = await this.prisma.user.findUnique({
      where: { id: revokedByUserId },
    });

    const canRevoke =
      revokingUser?.role === 'ADMIN' ||
      app.ownerId === revokedByUserId ||
      (await this.hasAccessLevel(appId, revokedByUserId, 'OWNER'));

    if (!canRevoke) {
      throw new ForbiddenException(
        'You do not have permission to revoke access to this app',
      );
    }

    // Find and delete permission
    const permission = await this.prisma.appPermission.findUnique({
      where: {
        appId_userId: {
          appId,
          userId,
        },
      },
    });

    if (!permission) {
      throw new NotFoundException('User does not have access to this app');
    }

    await this.prisma.appPermission.delete({
      where: { id: permission.id },
    });

    this.logger.log(
      `User ${revokedByUserId} revoked access for user ${userId} on app ${appId}`,
    );

    return { message: 'Access revoked successfully' };
  }

  /**
   * Get all apps a user has access to
   */
  async getUserApps(userId: string, organizationId: string) {
    // Get apps where user is owner
    const ownedApps = await this.prisma.app.findMany({
      where: {
        ownerId: userId,
        organizationId,
      },
      select: {
        id: true,
        name: true,
        description: true,
        platform: true,
        status: true,
        version: true,
        lastSyncedAt: true,
        createdAt: true,
        updatedAt: true,
      },
    });

    // Get apps where user has explicit permissions
    const permittedApps = await this.prisma.appPermission.findMany({
      where: {
        userId,
        app: {
          organizationId,
        },
      },
      include: {
        app: {
          select: {
            id: true,
            name: true,
            description: true,
            platform: true,
            status: true,
            version: true,
            lastSyncedAt: true,
            createdAt: true,
            updatedAt: true,
          },
        },
      },
    });

    // Combine and format results
    const apps = [
      ...ownedApps.map((app) => ({
        ...app,
        accessLevel: 'OWNER' as const,
        grantedAt: app.createdAt,
        expiresAt: null,
      })),
      ...permittedApps.map((p) => ({
        ...p.app,
        accessLevel: p.accessLevel,
        grantedAt: p.grantedAt,
        expiresAt: p.expiresAt,
      })),
    ];

    return apps;
  }

  /**
   * Check if user has at least a certain access level to an app
   */
  private async hasAccessLevel(
    appId: string,
    userId: string,
    minLevel: string,
  ): Promise<boolean> {
    const permission = await this.prisma.appPermission.findUnique({
      where: {
        appId_userId: {
          appId,
          userId,
        },
      },
    });

    if (!permission) return false;

    // Check if not expired
    if (permission.expiresAt && permission.expiresAt < new Date()) {
      return false;
    }

    // Access level hierarchy: VIEWER < EDITOR < OWNER
    const levels = { VIEWER: 1, EDITOR: 2, OWNER: 3 };
    return levels[permission.accessLevel] >= levels[minLevel];
  }
}

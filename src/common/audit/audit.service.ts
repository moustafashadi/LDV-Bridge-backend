import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { LoggerService } from '../logger/logger.service';
import { AuditAction, AuditLog } from '@prisma/client';

export interface CreateAuditLogDto {
  userId: string;
  organizationId: string;
  action: AuditAction;
  entityType: string;
  entityId?: string;
  details?: any;
  ipAddress?: string;
  userAgent?: string;
}

/**
 * Audit Log Service
 * Handles creation and querying of audit logs for compliance tracking
 */
@Injectable()
export class AuditService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly logger: LoggerService,
  ) {
    this.logger.setContext('AuditService');
  }

  /**
   * Create a new audit log entry
   */
  async createAuditLog(dto: CreateAuditLogDto): Promise<AuditLog> {
    try {
      // If userId is 'system' or null, don't set it (system actions)
      const data: any = {
        organizationId: dto.organizationId,
        action: dto.action,
        entityType: dto.entityType,
        entityId: dto.entityId,
        details: dto.details || {},
        ipAddress: dto.ipAddress,
        userAgent: dto.userAgent,
      };

      // Only add userId if it's a valid user ID (not 'system')
      if (dto.userId && dto.userId !== 'system') {
        data.userId = dto.userId;
      }

      const auditLog = await this.prisma.auditLog.create({
        data,
      });

      this.logger.log(
        `Audit log created: ${dto.action} on ${dto.entityType}`,
        JSON.stringify({
          auditLogId: auditLog.id,
          userId: dto.userId,
          action: dto.action,
          entityType: dto.entityType,
          entityId: dto.entityId,
        }),
      );

      return auditLog;
    } catch (error) {
      this.logger.error(
        'Failed to create audit log',
        error.stack,
        JSON.stringify(dto),
      );
      throw error;
    }
  }

  /**
   * Get audit logs for an organization with filtering
   */
  async getAuditLogs(
    organizationId: string,
    filters: {
      userId?: string;
      action?: AuditAction;
      entityType?: string;
      entityId?: string;
      startDate?: Date;
      endDate?: Date;
      page?: number;
      limit?: number;
    } = {},
  ) {
    const {
      userId,
      action,
      entityType,
      entityId,
      startDate,
      endDate,
      page = 1,
      limit = 50,
    } = filters;

    const where: any = {
      organizationId,
    };

    if (userId) where.userId = userId;
    if (action) where.action = action;
    if (entityType) where.entityType = entityType;
    if (entityId) where.entityId = entityId;

    if (startDate || endDate) {
      where.timestamp = {};
      if (startDate) where.timestamp.gte = startDate;
      if (endDate) where.timestamp.lte = endDate;
    }

    const [total, logs] = await Promise.all([
      this.prisma.auditLog.count({ where }),
      this.prisma.auditLog.findMany({
        where,
        include: {
          user: {
            select: {
              id: true,
              email: true,
              name: true,
              role: true,
            },
          },
        },
        orderBy: { timestamp: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
      }),
    ]);

    return {
      data: logs,
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit),
    };
  }

  /**
   * Get audit logs for a specific resource
   */
  async getResourceAuditLogs(
    organizationId: string,
    entityType: string,
    entityId: string,
  ) {
    return this.prisma.auditLog.findMany({
      where: {
        organizationId,
        entityType,
        entityId,
      },
      include: {
        user: {
          select: {
            id: true,
            email: true,
            name: true,
            role: true,
          },
        },
      },
      orderBy: { timestamp: 'desc' },
    });
  }

  /**
   * Get audit statistics for an organization
   */
  async getAuditStatistics(
    organizationId: string,
    startDate?: Date,
    endDate?: Date,
  ) {
    const where: any = { organizationId };

    if (startDate || endDate) {
      where.timestamp = {};
      if (startDate) where.timestamp.gte = startDate;
      if (endDate) where.timestamp.lte = endDate;
    }

    const [total, byAction, byEntityType, byUser] = await Promise.all([
      // Total count
      this.prisma.auditLog.count({ where }),

      // Group by action
      this.prisma.auditLog.groupBy({
        by: ['action'],
        where,
        _count: true,
      }),

      // Group by entity type
      this.prisma.auditLog.groupBy({
        by: ['entityType'],
        where,
        _count: true,
      }),

      // Group by user
      this.prisma.auditLog.groupBy({
        by: ['userId'],
        where,
        _count: true,
        orderBy: { _count: { userId: 'desc' } },
        take: 10,
      }),
    ]);

    return {
      total,
      byAction: byAction.map((item) => ({
        action: item.action,
        count: item._count,
      })),
      byEntityType: byEntityType.map((item) => ({
        entityType: item.entityType,
        count: item._count,
      })),
      topUsers: byUser.map((item) => ({
        userId: item.userId,
        count: item._count,
      })),
    };
  }

  /**
   * Delete old audit logs (for retention policy)
   */
  async deleteOldAuditLogs(daysToKeep: number = 90) {
    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - daysToKeep);

    const result = await this.prisma.auditLog.deleteMany({
      where: {
        timestamp: {
          lt: cutoffDate,
        },
      },
    });

    this.logger.log(
      `Deleted ${result.count} audit logs older than ${daysToKeep} days`,
    );

    return result;
  }
}

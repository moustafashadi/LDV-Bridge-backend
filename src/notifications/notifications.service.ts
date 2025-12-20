import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { Notification, NotificationType, Prisma } from '@prisma/client';
import {
  CreateNotificationDto,
  SendNotificationDto,
} from './dto/create-notification.dto';
import {
  NotificationResponseDto,
  PaginatedNotificationsResponseDto,
  UnreadCountResponseDto,
  SendNotificationResponseDto,
} from './dto/notification-response.dto';
import { EmailService } from './email/email.service';
import { NotificationsGateway } from './websocket/notifications.gateway';
import type { Queue } from 'bull';
import { InjectQueue } from '@nestjs/bull';

/**
 * Notifications Service
 * Handles notification CRUD and orchestrates multi-channel delivery
 */
@Injectable()
export class NotificationsService {
  private readonly logger = new Logger(NotificationsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly emailService: EmailService,
    private readonly notificationsGateway: NotificationsGateway,
    @InjectQueue('notifications') private readonly notificationQueue: Queue,
  ) {}

  /**
   * Create in-app notification
   */
  async create(
    createNotificationDto: CreateNotificationDto,
  ): Promise<NotificationResponseDto> {
    this.logger.log(
      `Creating notification for user ${createNotificationDto.userId}`,
    );

    try {
      const notification = await this.prisma.notification.create({
        data: {
          userId: createNotificationDto.userId,
          type: createNotificationDto.type,
          title: createNotificationDto.title,
          message: createNotificationDto.message,
          data: createNotificationDto.data
            ? (createNotificationDto.data as Prisma.InputJsonValue)
            : Prisma.JsonNull,
        },
      });

      this.logger.log(`Notification created: ${notification.id}`);
      return this.mapToResponseDto(notification);
    } catch (error) {
      this.logger.error(`Failed to create notification: ${error.message}`);
      throw error;
    }
  }

  /**
   * Send notification through multiple channels
   * This is the main method other services should call
   */
  async sendNotification(
    sendNotificationDto: SendNotificationDto,
  ): Promise<SendNotificationResponseDto> {
    const {
      userId,
      type,
      title,
      message,
      data,
      channels = ['in-app'],
      emailOptions,
    } = sendNotificationDto;

    this.logger.log(
      `Sending notification to user ${userId} via channels: ${channels.join(', ')}`,
    );

    const result: SendNotificationResponseDto = {
      notificationId: '',
      channels: [],
      inAppCreated: false,
      message: 'Notification sent',
    };

    // 1. Create in-app notification (always create for record-keeping)
    if (channels.includes('in-app')) {
      const notification = await this.create({
        userId,
        type,
        title,
        message,
        data,
      });
      result.notificationId = notification.id;
      result.inAppCreated = true;
      result.channels.push('in-app');
    }

    // 2. Send via WebSocket (real-time push)
    if (channels.includes('websocket')) {
      const websocketSent =
        await this.notificationsGateway.sendNotificationToUser(userId, {
          id: result.notificationId,
          type,
          title,
          message,
          data,
          createdAt: new Date(),
        });
      result.websocketPushed = websocketSent;
      if (websocketSent) {
        result.channels.push('websocket');
      }
    }

    // 3. Send via Email (queued for async processing)
    if (channels.includes('email')) {
      try {
        // Get user's email
        const user = await this.prisma.user.findUnique({
          where: { id: userId },
          select: { email: true },
        });

        if (user?.email) {
          // Queue email job (non-blocking)
          await this.notificationQueue.add('send-email', {
            to: user.email,
            subject: emailOptions?.subject || title,
            message,
            type,
            data,
          });
          result.emailSent = true;
          result.channels.push('email');
          this.logger.log(`Email notification queued for ${user.email}`);
        } else {
          this.logger.warn(`No email found for user ${userId}`);
        }
      } catch (error) {
        this.logger.error(
          `Failed to queue email notification: ${error.message}`,
        );
      }
    }

    return result;
  }

  /**
   * Notify all pro developers in an organization
   * Used for high-risk change alerts and other organization-wide notifications
   */
  async notifyProDevelopers(
    organizationId: string,
    type: NotificationType,
    title: string,
    data?: Record<string, any>,
  ): Promise<{ notifiedCount: number }> {
    this.logger.log(
      `Notifying pro developers in organization ${organizationId}`,
    );

    try {
      // Find all pro developers in the organization
      const proDevelopers = await this.prisma.user.findMany({
        where: {
          organizationId,
          role: 'PRO_DEVELOPER',
        },
        select: { id: true, email: true, name: true },
      });

      if (proDevelopers.length === 0) {
        this.logger.warn(
          `No pro developers found in organization ${organizationId}`,
        );
        return { notifiedCount: 0 };
      }

      this.logger.log(`Found ${proDevelopers.length} pro developers to notify`);

      // Send notification to each pro developer
      for (const proDev of proDevelopers) {
        await this.sendNotification({
          userId: proDev.id,
          type,
          title,
          message: `${title}. Please review the changes.`,
          data: {
            ...data,
            organizationId,
            urgent: true,
          },
          channels: ['in-app', 'websocket', 'email'],
          emailOptions: {
            subject: `[ACTION REQUIRED] ${title}`,
          },
        });
      }

      return { notifiedCount: proDevelopers.length };
    } catch (error) {
      this.logger.error(`Failed to notify pro developers: ${error.message}`);
      throw error;
    }
  }

  /**
   * Get notifications for a user (with pagination)
   */
  async findAll(
    userId: string,
    page: number = 1,
    limit: number = 20,
    unreadOnly: boolean = false,
  ): Promise<PaginatedNotificationsResponseDto> {
    this.logger.log(
      `Fetching notifications for user ${userId} (page ${page}, limit ${limit})`,
    );

    const where: any = { userId };
    if (unreadOnly) {
      where.isRead = false;
    }

    const [notifications, total] = await Promise.all([
      this.prisma.notification.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
      }),
      this.prisma.notification.count({ where }),
    ]);

    const totalPages = Math.ceil(total / limit);

    return {
      notifications: notifications.map((n) => this.mapToResponseDto(n)),
      total,
      page,
      limit,
      totalPages,
      hasMore: page < totalPages,
    };
  }

  /**
   * Get single notification
   */
  async findOne(
    notificationId: string,
    userId: string,
  ): Promise<NotificationResponseDto> {
    const notification = await this.prisma.notification.findFirst({
      where: {
        id: notificationId,
        userId, // Ensure user owns the notification
      },
    });

    if (!notification) {
      throw new NotFoundException(`Notification ${notificationId} not found`);
    }

    return this.mapToResponseDto(notification);
  }

  /**
   * Mark notification as read
   */
  async markAsRead(
    notificationId: string,
    userId: string,
  ): Promise<NotificationResponseDto> {
    this.logger.log(`Marking notification ${notificationId} as read`);

    // Verify ownership
    await this.findOne(notificationId, userId);

    const notification = await this.prisma.notification.update({
      where: { id: notificationId },
      data: {
        isRead: true,
        readAt: new Date(),
      },
    });

    // Send WebSocket event
    await this.notificationsGateway.sendReadEvent(userId, notificationId);

    return this.mapToResponseDto(notification);
  }

  /**
   * Mark notification as unread
   */
  async markAsUnread(
    notificationId: string,
    userId: string,
  ): Promise<NotificationResponseDto> {
    this.logger.log(`Marking notification ${notificationId} as unread`);

    // Verify ownership
    await this.findOne(notificationId, userId);

    const notification = await this.prisma.notification.update({
      where: { id: notificationId },
      data: {
        isRead: false,
        readAt: null,
      },
    });

    return this.mapToResponseDto(notification);
  }

  /**
   * Mark all notifications as read for a user
   */
  async markAllAsRead(userId: string): Promise<{ affected: number }> {
    this.logger.log(`Marking all notifications as read for user ${userId}`);

    const result = await this.prisma.notification.updateMany({
      where: {
        userId,
        isRead: false,
      },
      data: {
        isRead: true,
        readAt: new Date(),
      },
    });

    return { affected: result.count };
  }

  /**
   * Get unread notification count
   */
  async getUnreadCount(userId: string): Promise<UnreadCountResponseDto> {
    const unreadCount = await this.prisma.notification.count({
      where: {
        userId,
        isRead: false,
      },
    });

    return {
      unreadCount,
      userId,
    };
  }

  /**
   * Delete notification
   */
  async remove(notificationId: string, userId: string): Promise<void> {
    this.logger.log(`Deleting notification ${notificationId}`);

    // Verify ownership
    await this.findOne(notificationId, userId);

    await this.prisma.notification.delete({
      where: { id: notificationId },
    });

    // Send WebSocket event
    await this.notificationsGateway.sendDeletedEvent(userId, notificationId);
  }

  /**
   * Clear all read notifications for a user
   */
  async clearAllRead(userId: string): Promise<{ affected: number }> {
    this.logger.log(`Clearing all read notifications for user ${userId}`);

    const result = await this.prisma.notification.deleteMany({
      where: {
        userId,
        isRead: true,
      },
    });

    return { affected: result.count };
  }

  /**
   * Map Prisma entity to response DTO
   */
  private mapToResponseDto(
    notification: Notification,
  ): NotificationResponseDto {
    return {
      id: notification.id,
      userId: notification.userId,
      type: notification.type,
      title: notification.title,
      message: notification.message,
      data: notification.data as Record<string, any> | null,
      isRead: notification.isRead,
      readAt: notification.readAt,
      createdAt: notification.createdAt,
    };
  }
}

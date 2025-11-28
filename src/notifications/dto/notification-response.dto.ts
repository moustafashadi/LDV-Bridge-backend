import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { NotificationType } from '@prisma/client';

/**
 * Response DTO for notification operations
 */
export class NotificationResponseDto {
  @ApiProperty({ description: 'Notification ID' })
  id: string;

  @ApiProperty({ description: 'User ID' })
  userId: string;

  @ApiProperty({ 
    description: 'Notification type',
    enum: NotificationType
  })
  type: NotificationType;

  @ApiProperty({ description: 'Notification title' })
  title: string;

  @ApiProperty({ description: 'Notification message' })
  message: string;

  @ApiPropertyOptional({ description: 'Additional notification data' })
  data?: Record<string, any> | null;

  @ApiProperty({ description: 'Whether notification is read' })
  isRead: boolean;

  @ApiPropertyOptional({ description: 'When notification was read' })
  readAt?: Date | null;

  @ApiProperty({ description: 'When notification was created' })
  createdAt: Date;
}

/**
 * Response DTO for pagination
 */
export class PaginatedNotificationsResponseDto {
  @ApiProperty({ 
    description: 'List of notifications',
    type: [NotificationResponseDto]
  })
  notifications: NotificationResponseDto[];

  @ApiProperty({ description: 'Total count of notifications' })
  total: number;

  @ApiProperty({ description: 'Current page number' })
  page: number;

  @ApiProperty({ description: 'Number of items per page' })
  limit: number;

  @ApiProperty({ description: 'Total number of pages' })
  totalPages: number;

  @ApiProperty({ description: 'Whether there are more pages' })
  hasMore: boolean;
}

/**
 * Response DTO for unread count
 */
export class UnreadCountResponseDto {
  @ApiProperty({ description: 'Number of unread notifications' })
  unreadCount: number;

  @ApiProperty({ description: 'User ID' })
  userId: string;
}

/**
 * Response DTO for bulk operations
 */
export class BulkActionResponseDto {
  @ApiProperty({ description: 'Number of notifications affected' })
  affected: number;

  @ApiProperty({ description: 'Success message' })
  message: string;
}

/**
 * Response DTO for notification send result
 */
export class SendNotificationResponseDto {
  @ApiProperty({ description: 'Notification ID (for in-app)' })
  notificationId: string;

  @ApiProperty({ description: 'Channels notification was sent through' })
  channels: string[];

  @ApiProperty({ description: 'Email send status' })
  emailSent?: boolean;

  @ApiProperty({ description: 'WebSocket push status' })
  websocketPushed?: boolean;

  @ApiProperty({ description: 'In-app notification created' })
  inAppCreated: boolean;

  @ApiProperty({ description: 'Success message' })
  message: string;
}

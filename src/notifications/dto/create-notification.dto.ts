import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsString, IsEnum, IsOptional, IsObject, IsArray, IsBoolean } from 'class-validator';
import { NotificationType } from '@prisma/client';

/**
 * DTO for creating a notification
 */
export class CreateNotificationDto {
  @ApiProperty({ description: 'User ID to send notification to' })
  @IsString()
  userId: string;

  @ApiProperty({ 
    description: 'Type of notification',
    enum: NotificationType,
    example: 'REVIEW_ASSIGNED'
  })
  @IsEnum(NotificationType)
  type: NotificationType;

  @ApiProperty({ description: 'Notification title', example: 'Review Assigned' })
  @IsString()
  title: string;

  @ApiProperty({ 
    description: 'Notification message',
    example: 'You have been assigned to review changes for App XYZ'
  })
  @IsString()
  message: string;

  @ApiPropertyOptional({ 
    description: 'Additional notification data (JSON)',
    example: { reviewId: 'review-123', appName: 'App XYZ' }
  })
  @IsOptional()
  @IsObject()
  data?: Record<string, any>;
}

/**
 * DTO for sending notifications through multiple channels
 */
export class SendNotificationDto extends CreateNotificationDto {
  @ApiPropertyOptional({ 
    description: 'Channels to send notification through',
    type: [String],
    example: ['email', 'websocket', 'in-app'],
    default: ['in-app']
  })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  channels?: ('email' | 'websocket' | 'in-app')[];

  @ApiPropertyOptional({ 
    description: 'Email-specific options',
    example: { subject: 'Custom Subject', template: 'review-assigned' }
  })
  @IsOptional()
  @IsObject()
  emailOptions?: {
    subject?: string;
    template?: string;
    cc?: string[];
    bcc?: string[];
  };
}

/**
 * DTO for bulk operations
 */
export class BulkNotificationActionDto {
  @ApiProperty({ 
    description: 'Notification IDs to perform action on',
    type: [String]
  })
  @IsArray()
  @IsString({ each: true })
  notificationIds: string[];
}

/**
 * DTO for notification preferences (future enhancement)
 */
export class NotificationPreferencesDto {
  @ApiPropertyOptional({ description: 'Enable email notifications', default: true })
  @IsOptional()
  @IsBoolean()
  emailEnabled?: boolean;

  @ApiPropertyOptional({ description: 'Enable in-app notifications', default: true })
  @IsOptional()
  @IsBoolean()
  inAppEnabled?: boolean;

  @ApiPropertyOptional({ description: 'Enable WebSocket push notifications', default: true })
  @IsOptional()
  @IsBoolean()
  websocketEnabled?: boolean;

  @ApiPropertyOptional({ 
    description: 'Notification types to receive',
    type: [String],
    enum: NotificationType
  })
  @IsOptional()
  @IsArray()
  @IsEnum(NotificationType, { each: true })
  enabledTypes?: NotificationType[];
}

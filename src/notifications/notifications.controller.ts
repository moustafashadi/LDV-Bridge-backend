import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Param,
  Query,
  Body,
  HttpCode,
  HttpStatus,
  Logger,
  ParseIntPipe,
  ParseBoolPipe,
  UnauthorizedException,
} from '@nestjs/common';
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiBearerAuth,
  ApiQuery,
  ApiParam,
} from '@nestjs/swagger';
import { NotificationsService } from './notifications.service';
import { SendNotificationDto } from './dto/create-notification.dto';
import {
  NotificationResponseDto,
  PaginatedNotificationsResponseDto,
  UnreadCountResponseDto,
  BulkActionResponseDto,
  SendNotificationResponseDto,
} from './dto/notification-response.dto';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { Roles } from '../auth/decorators/roles.decorator';
import type { AuthenticatedUser } from '../auth/interfaces/authenticated-user.interface';

/**
 * Notifications Controller
 * Manages user notifications
 */
@ApiTags('Notifications')
@ApiBearerAuth()
@Controller('notifications')
export class NotificationsController {
  private readonly logger = new Logger(NotificationsController.name);

  constructor(private readonly notificationsService: NotificationsService) {}

  /**
   * Validate user ID and throw if null
   */
  private validateUserId(user: AuthenticatedUser): string {
    if (!user.id) {
      throw new UnauthorizedException('User ID is required');
    }
    return user.id;
  }

  /**
   * Send notification (Admin/System use)
   */
  @Post('send')
  @Roles('ADMIN', 'PRO_DEVELOPER')
  @ApiOperation({ summary: 'Send notification to a user (multi-channel)' })
  @ApiResponse({
    status: 201,
    description: 'Notification sent successfully',
    type: SendNotificationResponseDto,
  })
  async sendNotification(
    @CurrentUser() user: AuthenticatedUser,
    @Body() sendNotificationDto: SendNotificationDto,
  ): Promise<SendNotificationResponseDto> {
    this.logger.log(`User ${user.id} sending notification to ${sendNotificationDto.userId}`);
    return this.notificationsService.sendNotification(sendNotificationDto);
  }

  /**
   * Get current user's notifications
   */
  @Get()
  @ApiOperation({ summary: 'Get notifications for current user' })
  @ApiQuery({ name: 'page', required: false, type: Number, description: 'Page number (default: 1)' })
  @ApiQuery({ name: 'limit', required: false, type: Number, description: 'Items per page (default: 20)' })
  @ApiQuery({ name: 'unreadOnly', required: false, type: Boolean, description: 'Only unread notifications' })
  @ApiResponse({
    status: 200,
    description: 'Notifications retrieved successfully',
    type: PaginatedNotificationsResponseDto,
  })
  async findAll(
    @CurrentUser() user: AuthenticatedUser,
    @Query('page', new ParseIntPipe({ optional: true })) page: number = 1,
    @Query('limit', new ParseIntPipe({ optional: true })) limit: number = 20,
    @Query('unreadOnly', new ParseBoolPipe({ optional: true })) unreadOnly: boolean = false,
  ): Promise<PaginatedNotificationsResponseDto> {
    const userId = this.validateUserId(user);
    return this.notificationsService.findAll(userId, page, limit, unreadOnly);
  }

  /**
   * Get unread notification count
   */
  @Get('unread-count')
  @ApiOperation({ summary: 'Get unread notification count' })
  @ApiResponse({
    status: 200,
    description: 'Unread count retrieved successfully',
    type: UnreadCountResponseDto,
  })
  async getUnreadCount(@CurrentUser() user: AuthenticatedUser): Promise<UnreadCountResponseDto> {
    const userId = this.validateUserId(user);
    return this.notificationsService.getUnreadCount(userId);
  }

  /**
   * Get single notification
   */
  @Get(':id')
  @ApiOperation({ summary: 'Get a specific notification' })
  @ApiParam({ name: 'id', description: 'Notification ID' })
  @ApiResponse({
    status: 200,
    description: 'Notification retrieved successfully',
    type: NotificationResponseDto,
  })
  @ApiResponse({ status: 404, description: 'Notification not found' })
  async findOne(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
  ): Promise<NotificationResponseDto> {
    const userId = this.validateUserId(user);
    return this.notificationsService.findOne(id, userId);
  }

  /**
   * Mark notification as read
   */
  @Patch(':id/read')
  @ApiOperation({ summary: 'Mark notification as read' })
  @ApiParam({ name: 'id', description: 'Notification ID' })
  @ApiResponse({
    status: 200,
    description: 'Notification marked as read',
    type: NotificationResponseDto,
  })
  async markAsRead(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
  ): Promise<NotificationResponseDto> {
    const userId = this.validateUserId(user);
    return this.notificationsService.markAsRead(id, userId);
  }

  /**
   * Mark notification as unread
   */
  @Patch(':id/unread')
  @ApiOperation({ summary: 'Mark notification as unread' })
  @ApiParam({ name: 'id', description: 'Notification ID' })
  @ApiResponse({
    status: 200,
    description: 'Notification marked as unread',
    type: NotificationResponseDto,
  })
  async markAsUnread(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
  ): Promise<NotificationResponseDto> {
    const userId = this.validateUserId(user);
    return this.notificationsService.markAsUnread(id, userId);
  }

  /**
   * Mark all notifications as read
   */
  @Patch('mark-all-read')
  @ApiOperation({ summary: 'Mark all notifications as read' })
  @ApiResponse({
    status: 200,
    description: 'All notifications marked as read',
    type: BulkActionResponseDto,
  })
  async markAllAsRead(@CurrentUser() user: AuthenticatedUser): Promise<BulkActionResponseDto> {
    const userId = this.validateUserId(user);
    const result = await this.notificationsService.markAllAsRead(userId);
    return {
      affected: result.affected,
      message: `${result.affected} notifications marked as read`,
    };
  }

  /**
   * Delete notification
   */
  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Delete a notification' })
  @ApiParam({ name: 'id', description: 'Notification ID' })
  @ApiResponse({ status: 204, description: 'Notification deleted successfully' })
  @ApiResponse({ status: 404, description: 'Notification not found' })
  async remove(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string): Promise<void> {
    const userId = this.validateUserId(user);
    await this.notificationsService.remove(id, userId);
  }

  /**
   * Clear all read notifications
   */
  @Delete('clear-all-read')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Delete all read notifications' })
  @ApiResponse({
    status: 200,
    description: 'Read notifications cleared',
    type: BulkActionResponseDto,
  })
  async clearAllRead(@CurrentUser() user: AuthenticatedUser): Promise<BulkActionResponseDto> {
    const userId = this.validateUserId(user);
    const result = await this.notificationsService.clearAllRead(userId);
    return {
      affected: result.affected,
      message: `${result.affected} read notifications deleted`,
    };
  }
}

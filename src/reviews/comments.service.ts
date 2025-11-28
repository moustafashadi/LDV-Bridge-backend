import {
  Injectable,
  Logger,
  NotFoundException,
  ForbiddenException,
  BadRequestException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { NotificationsService } from '../notifications/notifications.service';
import { CreateCommentDto } from './dto/create-comment.dto';
import { UpdateCommentDto } from './dto/update-comment.dto';
import { CommentResponseDto } from './dto/comment-response.dto';

@Injectable()
export class CommentsService {
  private readonly logger = new Logger(CommentsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly notificationsService: NotificationsService,
  ) {}

  /**
   * Create a new comment on a change
   */
  async create(
    changeId: string,
    userId: string,
    organizationId: string,
    createCommentDto: CreateCommentDto,
  ): Promise<CommentResponseDto> {
    this.logger.log(
      `Creating comment on change ${changeId} by user ${userId}`,
    );

    // Verify change exists and user has access
    const change = await this.prisma.change.findFirst({
      where: { id: changeId, organizationId },
    });

    if (!change) {
      throw new NotFoundException(
        `Change ${changeId} not found or access denied`,
      );
    }

    // If replying, verify parent comment exists
    if (createCommentDto.parentId) {
      const parentComment = await this.prisma.comment.findFirst({
        where: { id: createCommentDto.parentId, changeId },
      });

      if (!parentComment) {
        throw new BadRequestException('Parent comment not found');
      }
    }

    // Extract mentions from content if not provided
    const mentions =
      createCommentDto.mentions || this.extractMentions(createCommentDto.content);

    // Create comment
    const comment = await this.prisma.comment.create({
      data: {
        changeId,
        userId,
        content: createCommentDto.content,
        parentId: createCommentDto.parentId,
        mentions,
      },
      include: {
        user: {
          select: {
            id: true,
            name: true,
            email: true,
            role: true,
          },
        },
      },
    });

    // Send notifications
    await this.sendCommentNotifications(comment, change, organizationId);

    return this.mapToResponseDto(comment);
  }

  /**
   * Get all comments for a change (with threading)
   */
  async findByChange(
    changeId: string,
    organizationId: string,
  ): Promise<CommentResponseDto[]> {
    // Verify change exists
    const change = await this.prisma.change.findFirst({
      where: { id: changeId, organizationId },
    });

    if (!change) {
      throw new NotFoundException(
        `Change ${changeId} not found or access denied`,
      );
    }

    // Get all comments for this change
    const comments = await this.prisma.comment.findMany({
      where: { changeId },
      include: {
        user: {
          select: {
            id: true,
            name: true,
            email: true,
            role: true,
          },
        },
      },
      orderBy: { createdAt: 'asc' },
    });

    // Build threaded structure
    return this.buildCommentTree(comments);
  }

  /**
   * Get replies for a specific comment
   */
  async findReplies(
    parentId: string,
    organizationId: string,
  ): Promise<CommentResponseDto[]> {
    const replies = await this.prisma.comment.findMany({
      where: { parentId },
      include: {
        user: {
          select: {
            id: true,
            name: true,
            email: true,
            role: true,
          },
        },
        change: {
          select: {
            organizationId: true,
          },
        },
      },
      orderBy: { createdAt: 'asc' },
    });

    // Verify access
    if (replies.length > 0 && replies[0].change.organizationId !== organizationId) {
      throw new ForbiddenException('Access denied');
    }

    return replies.map((reply) => this.mapToResponseDto(reply));
  }

  /**
   * Update a comment
   */
  async update(
    commentId: string,
    userId: string,
    organizationId: string,
    updateCommentDto: UpdateCommentDto,
  ): Promise<CommentResponseDto> {
    // Verify comment exists and user owns it
    const comment = await this.prisma.comment.findFirst({
      where: {
        id: commentId,
        userId,
        change: { organizationId },
      },
      include: {
        change: true,
      },
    });

    if (!comment) {
      throw new NotFoundException(
        'Comment not found or you do not have permission to edit it',
      );
    }

    // Extract new mentions
    const mentions =
      updateCommentDto.mentions || this.extractMentions(updateCommentDto.content);

    // Update comment
    const updatedComment = await this.prisma.comment.update({
      where: { id: commentId },
      data: {
        content: updateCommentDto.content,
        mentions,
      },
      include: {
        user: {
          select: {
            id: true,
            name: true,
            email: true,
            role: true,
          },
        },
      },
    });

    this.logger.log(`Comment ${commentId} updated by user ${userId}`);

    return this.mapToResponseDto(updatedComment);
  }

  /**
   * Delete a comment (soft delete by marking as deleted)
   */
  async delete(
    commentId: string,
    userId: string,
    organizationId: string,
    isAdmin: boolean = false,
  ): Promise<void> {
    // Admin can delete any comment, users can only delete their own
    const whereClause: any = {
      id: commentId,
      change: { organizationId },
    };

    if (!isAdmin) {
      whereClause.userId = userId;
    }

    const comment = await this.prisma.comment.findFirst({
      where: whereClause,
    });

    if (!comment) {
      throw new NotFoundException(
        'Comment not found or you do not have permission to delete it',
      );
    }

    // Delete comment (hard delete for now, can be changed to soft delete)
    await this.prisma.comment.delete({
      where: { id: commentId },
    });

    this.logger.log(`Comment ${commentId} deleted by user ${userId}`);
  }

  /**
   * Mark a comment as resolved
   */
  async resolve(
    commentId: string,
    userId: string,
    organizationId: string,
  ): Promise<CommentResponseDto> {
    const comment = await this.prisma.comment.findFirst({
      where: {
        id: commentId,
        change: { organizationId },
      },
    });

    if (!comment) {
      throw new NotFoundException('Comment not found or access denied');
    }

    const resolvedComment = await this.prisma.comment.update({
      where: { id: commentId },
      data: { isResolved: true },
      include: {
        user: {
          select: {
            id: true,
            name: true,
            email: true,
            role: true,
          },
        },
      },
    });

    this.logger.log(`Comment ${commentId} resolved by user ${userId}`);

    return this.mapToResponseDto(resolvedComment);
  }

  /**
   * Mark a comment as unresolved
   */
  async unresolve(
    commentId: string,
    userId: string,
    organizationId: string,
  ): Promise<CommentResponseDto> {
    const comment = await this.prisma.comment.findFirst({
      where: {
        id: commentId,
        change: { organizationId },
      },
    });

    if (!comment) {
      throw new NotFoundException('Comment not found or access denied');
    }

    const unresolvedComment = await this.prisma.comment.update({
      where: { id: commentId },
      data: { isResolved: false },
      include: {
        user: {
          select: {
            id: true,
            name: true,
            email: true,
            role: true,
          },
        },
      },
    });

    this.logger.log(`Comment ${commentId} unresolved by user ${userId}`);

    return this.mapToResponseDto(unresolvedComment);
  }

  /**
   * Get comments mentioning a specific user
   */
  async getMentions(
    changeId: string,
    userId: string,
    organizationId: string,
  ): Promise<CommentResponseDto[]> {
    const comments = await this.prisma.comment.findMany({
      where: {
        changeId,
        change: { organizationId },
        mentions: { has: userId },
      },
      include: {
        user: {
          select: {
            id: true,
            name: true,
            email: true,
            role: true,
          },
        },
      },
      orderBy: { createdAt: 'desc' },
    });

    return comments.map((comment) => this.mapToResponseDto(comment));
  }

  /**
   * Extract user mentions from comment content (@username)
   * Note: This is a simple implementation. In production, you'd want to:
   * 1. Validate mentioned users exist
   * 2. Use actual user IDs instead of usernames
   * 3. Support @mentions in the frontend with autocomplete
   */
  private extractMentions(content: string): string[] {
    const mentionRegex = /@(\w+)/g;
    const matches = content.matchAll(mentionRegex);
    const mentions: string[] = [];

    for (const match of matches) {
      mentions.push(match[1]);
    }

    return [...new Set(mentions)]; // Remove duplicates
  }

  /**
   * Send notifications for comment events
   */
  private async sendCommentNotifications(
    comment: any,
    change: any,
    organizationId: string,
  ): Promise<void> {
    try {
      // Notify change author (if not the commenter)
      if (change.authorId !== comment.userId) {
        await this.notificationsService.sendNotification({
          userId: change.authorId,
          type: 'COMMENT_ADDED',
          title: 'New Comment on Your Change',
          message: `${comment.user.name} commented on "${change.title}"`,
          data: {
            changeId: change.id,
            commentId: comment.id,
            authorName: comment.user.name,
          },
        });
      }

      // Notify mentioned users
      if (comment.mentions && comment.mentions.length > 0) {
        for (const mentionedUserId of comment.mentions) {
          // Skip if mentioned user is the commenter
          if (mentionedUserId === comment.userId) continue;

          await this.notificationsService.sendNotification({
            userId: mentionedUserId,
            type: 'COMMENT_MENTION',
            title: 'You Were Mentioned in a Comment',
            message: `${comment.user.name} mentioned you in a comment on "${change.title}"`,
            data: {
              changeId: change.id,
              commentId: comment.id,
              authorName: comment.user.name,
            },
          });
        }
      }
    } catch (error) {
      this.logger.error(
        `Failed to send comment notifications: ${error.message}`,
      );
      // Don't fail the comment creation if notifications fail
    }
  }

  /**
   * Build threaded comment structure
   */
  private buildCommentTree(comments: any[]): CommentResponseDto[] {
    const commentMap = new Map<string, CommentResponseDto>();
    const topLevelComments: CommentResponseDto[] = [];

    // First pass: create all comment DTOs
    for (const comment of comments) {
      const dto = this.mapToResponseDto(comment);
      dto.replies = [];
      commentMap.set(comment.id, dto);
    }

    // Second pass: build tree structure
    for (const comment of comments) {
      const dto = commentMap.get(comment.id)!;

      if (comment.parentId) {
        // This is a reply
        const parent = commentMap.get(comment.parentId);
        if (parent) {
          parent.replies!.push(dto);
          parent.replyCount = (parent.replyCount || 0) + 1;
        }
      } else {
        // This is a top-level comment
        topLevelComments.push(dto);
      }
    }

    return topLevelComments;
  }

  /**
   * Map database comment to response DTO
   */
  private mapToResponseDto(comment: any): CommentResponseDto {
    return {
      id: comment.id,
      changeId: comment.changeId,
      userId: comment.userId,
      user: {
        id: comment.user.id,
        name: comment.user.name,
        email: comment.user.email,
        role: comment.user.role,
      },
      content: comment.content,
      parentId: comment.parentId,
      mentions: comment.mentions || [],
      isResolved: comment.isResolved,
      createdAt: comment.createdAt,
      updatedAt: comment.updatedAt,
      replies: [],
      replyCount: 0,
    };
  }
}

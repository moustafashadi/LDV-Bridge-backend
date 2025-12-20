import {
  Injectable,
  Logger,
  NotFoundException,
  BadRequestException,
  ForbiddenException,
  Inject,
  forwardRef,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { NotificationsService } from '../notifications/notifications.service';
import { GitHubService } from '../github/github.service';
import { ReviewStatus, UserRole } from '@prisma/client';
import { CreateReviewDto } from './dto/create-review.dto';
import { SubmitForReviewDto } from './dto/submit-for-review.dto';
import { ReviewDecisionDto } from './dto/review-decision.dto';
import { ReviewResponseDto, ReviewSLADto } from './dto/review-response.dto';
import {
  ReviewMetricsDto,
  RiskLevelMetricsDto,
} from './dto/review-metrics.dto';

// SLA thresholds in hours by risk level
const SLA_THRESHOLDS = {
  low: { response: 24, review: 48 },
  medium: { response: 12, review: 24 },
  high: { response: 4, review: 12 },
  critical: { response: 2, review: 6 },
};

@Injectable()
export class ReviewsService {
  private readonly logger = new Logger(ReviewsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly notificationsService: NotificationsService,
    @Inject(forwardRef(() => GitHubService))
    private readonly githubService: GitHubService,
  ) {}

  /**
   * Submit a change for review
   * Auto-assigns reviewers based on risk level if no reviewers provided
   */
  async submitForReview(
    changeId: string,
    userId: string,
    organizationId: string,
    submitForReviewDto: SubmitForReviewDto,
  ): Promise<any> {
    this.logger.log(`Submitting change ${changeId} for review`);

    // Get change and verify ownership
    const change = await this.prisma.change.findFirst({
      where: {
        id: changeId,
        authorId: userId,
        organizationId,
      },
    });

    if (!change) {
      throw new NotFoundException(
        'Change not found or you do not have permission to submit it',
      );
    }

    // Check if already submitted
    if (change.status !== 'DRAFT') {
      throw new BadRequestException(
        `Change is already ${change.status.toLowerCase()}`,
      );
    }

    // Determine reviewers
    let reviewerIds: string[] = [];
    if (
      submitForReviewDto.reviewerIds &&
      submitForReviewDto.reviewerIds.length > 0
    ) {
      reviewerIds = submitForReviewDto.reviewerIds;
    } else {
      reviewerIds = await this.autoAssignReviewers(change);
    }

    // If no reviewers needed (low risk), auto-approve
    if (reviewerIds.length === 0) {
      await this.prisma.change.update({
        where: { id: changeId },
        data: { status: 'APPROVED' },
      });

      this.logger.log(`Change ${changeId} auto-approved (low risk)`);

      return {
        message: 'Change auto-approved due to low risk',
        change: await this.prisma.change.findUnique({
          where: { id: changeId },
        }),
        reviews: [],
      };
    }

    // Create review records
    const reviews = await Promise.all(
      reviewerIds.map((reviewerId) =>
        this.create(
          {
            changeId,
            reviewerId,
          },
          organizationId,
        ),
      ),
    );

    // Update change status to PENDING
    await this.prisma.change.update({
      where: { id: changeId },
      data: { status: 'PENDING' },
    });

    // Send notifications to reviewers
    await this.notifyReviewers(reviews, change);

    return {
      message: 'Change submitted for review',
      change: await this.prisma.change.findUnique({ where: { id: changeId } }),
      reviews,
    };
  }

  /**
   * Create a review record
   */
  async create(
    createReviewDto: CreateReviewDto,
    organizationId: string,
  ): Promise<ReviewResponseDto> {
    const { changeId, reviewerId } = createReviewDto;

    // Verify change exists
    const change = await this.prisma.change.findFirst({
      where: { id: changeId, organizationId },
    });

    if (!change) {
      throw new NotFoundException('Change not found or access denied');
    }

    // Verify reviewer exists and has appropriate role
    const reviewer = await this.prisma.user.findFirst({
      where: {
        id: reviewerId,
        organizationId,
        role: {
          in: [UserRole.PRO_DEVELOPER, UserRole.ADMIN],
        },
      },
    });

    if (!reviewer) {
      throw new BadRequestException(
        'Reviewer not found or does not have review permissions',
      );
    }

    // Create review
    const review = await this.prisma.review.create({
      data: {
        changeId,
        reviewerId,
        status: ReviewStatus.PENDING,
      },
      include: {
        change: {
          include: {
            author: {
              select: {
                id: true,
                name: true,
                email: true,
                role: true,
              },
            },
          },
        },
        reviewer: {
          select: {
            id: true,
            name: true,
            email: true,
            role: true,
          },
        },
      },
    });

    this.logger.log(`Review created: ${review.id} for change ${changeId}`);

    return this.mapToResponseDto(review);
  }

  /**
   * Get all reviews with optional filters
   */
  async findAll(
    organizationId: string,
    filters: {
      changeId?: string;
      reviewerId?: string;
      status?: ReviewStatus;
      page?: number;
      limit?: number;
    },
  ): Promise<{
    data: ReviewResponseDto[];
    total: number;
    page: number;
    limit: number;
  }> {
    const page = filters.page || 1;
    const limit = filters.limit || 20;
    const skip = (page - 1) * limit;

    const where: any = {
      change: { organizationId },
    };

    if (filters.changeId) where.changeId = filters.changeId;
    if (filters.reviewerId) where.reviewerId = filters.reviewerId;
    if (filters.status) where.status = filters.status;

    const [reviews, total] = await Promise.all([
      this.prisma.review.findMany({
        where,
        include: {
          change: {
            select: {
              id: true,
              title: true,
              changeType: true,
              riskScore: true,
              riskAssessment: true,
            },
          },
          reviewer: {
            select: {
              id: true,
              name: true,
              email: true,
              role: true,
            },
          },
        },
        orderBy: { createdAt: 'desc' },
        skip,
        take: limit,
      }),
      this.prisma.review.count({ where }),
    ]);

    return {
      data: reviews.map((review) => this.mapToResponseDto(review)),
      total,
      page,
      limit,
    };
  }

  /**
   * Get a single review by ID
   */
  async findOne(
    reviewId: string,
    organizationId: string,
  ): Promise<ReviewResponseDto> {
    const review = await this.prisma.review.findFirst({
      where: {
        id: reviewId,
        change: { organizationId },
      },
      include: {
        change: {
          select: {
            id: true,
            title: true,
            changeType: true,
            riskScore: true,
            riskAssessment: true,
          },
        },
        reviewer: {
          select: {
            id: true,
            name: true,
            email: true,
            role: true,
          },
        },
      },
    });

    if (!review) {
      throw new NotFoundException('Review not found or access denied');
    }

    return this.mapToResponseDto(review);
  }

  /**
   * Start a review (mark as IN_PROGRESS)
   */
  async startReview(
    reviewId: string,
    userId: string,
    organizationId: string,
  ): Promise<ReviewResponseDto> {
    const review = await this.prisma.review.findFirst({
      where: {
        id: reviewId,
        reviewerId: userId,
        change: { organizationId },
      },
      include: { change: true },
    });

    if (!review) {
      throw new NotFoundException(
        'Review not found or you are not the assigned reviewer',
      );
    }

    if (review.status !== ReviewStatus.PENDING) {
      throw new BadRequestException(
        `Review is already ${review.status.toLowerCase()}`,
      );
    }

    const updatedReview = await this.prisma.review.update({
      where: { id: reviewId },
      data: {
        status: ReviewStatus.IN_PROGRESS,
        startedAt: new Date(),
      },
      include: {
        change: {
          select: {
            id: true,
            title: true,
            changeType: true,
            riskScore: true,
            riskAssessment: true,
          },
        },
        reviewer: {
          select: {
            id: true,
            name: true,
            email: true,
            role: true,
          },
        },
      },
    });

    // Notify change author (if known)
    if (review.change.authorId) {
      await this.notificationsService.sendNotification({
        userId: review.change.authorId,
        type: 'REVIEW_ASSIGNED',
        title: 'Review Started',
        message: `${updatedReview.reviewer.name} has started reviewing "${review.change.title}"`,
        data: {
          reviewId,
          changeId: review.changeId,
          reviewerName: updatedReview.reviewer.name,
        },
      });
    }

    this.logger.log(`Review ${reviewId} started by user ${userId}`);

    return this.mapToResponseDto(updatedReview);
  }

  /**
   * Approve a change
   */
  async approve(
    reviewId: string,
    userId: string,
    organizationId: string,
    reviewDecisionDto: ReviewDecisionDto,
  ): Promise<{
    review: ReviewResponseDto;
    changeStatus: string;
    allApproved: boolean;
  }> {
    const review = await this.prisma.review.findFirst({
      where: {
        id: reviewId,
        reviewerId: userId,
        change: { organizationId },
      },
      include: { change: true },
    });

    if (!review) {
      throw new NotFoundException(
        'Review not found or you are not the assigned reviewer',
      );
    }

    if (review.status === ReviewStatus.APPROVED) {
      throw new BadRequestException('Review is already approved');
    }

    // Update review
    const updatedReview = await this.prisma.review.update({
      where: { id: reviewId },
      data: {
        status: ReviewStatus.APPROVED,
        decision: 'approve',
        feedback: reviewDecisionDto.feedback,
        completedAt: new Date(),
      },
      include: {
        change: {
          select: {
            id: true,
            title: true,
            changeType: true,
            riskScore: true,
            riskAssessment: true,
            authorId: true,
          },
        },
        reviewer: {
          select: {
            id: true,
            name: true,
            email: true,
            role: true,
          },
        },
      },
    });

    // Check if all reviews are approved
    const allApproved = await this.checkAllApproved(review.changeId);

    let changeStatus = review.change.status;
    if (allApproved) {
      // Update change status to APPROVED
      await this.prisma.change.update({
        where: { id: review.changeId },
        data: { status: 'APPROVED' },
      });
      changeStatus = 'APPROVED';

      // Merge staging branch to main
      try {
        const change = await this.prisma.change.findUnique({
          where: { id: review.changeId },
          include: { app: true },
        });

        if (change?.app) {
          this.logger.log(
            `Merging staging branch to main for change ${review.changeId}`,
          );
          await this.githubService.mergeStagingToMain(
            change.app,
            review.changeId,
            `Approved: ${review.change.title} - Reviewed by ${updatedReview.reviewer.name}`,
          );
          this.logger.log(
            `Successfully merged staging branch for change ${review.changeId}`,
          );
        }
      } catch (mergeError) {
        this.logger.error(
          `Failed to merge staging branch: ${mergeError.message}`,
        );
        // Don't fail the approval if merge fails - it can be retried
      }

      // Notify change author of approval (if known)
      if (review.change.authorId) {
        await this.notificationsService.sendNotification({
          userId: review.change.authorId,
          type: 'REVIEW_APPROVED',
          title: 'Change Approved',
          message: `Your change "${review.change.title}" has been approved and is ready for deployment`,
          data: {
            reviewId,
            changeId: review.changeId,
            reviewerName: updatedReview.reviewer.name,
          },
        });
      }
    } else {
      // Notify author that one review is approved but others pending (if known)
      if (review.change.authorId) {
        await this.notificationsService.sendNotification({
          userId: review.change.authorId,
          type: 'REVIEW_APPROVED',
          title: 'Review Approved',
          message: `${updatedReview.reviewer.name} approved "${review.change.title}". Waiting for other reviewers.`,
          data: {
            reviewId,
            changeId: review.changeId,
            reviewerName: updatedReview.reviewer.name,
          },
        });
      }
    }

    this.logger.log(`Review ${reviewId} approved by user ${userId}`);

    return {
      review: this.mapToResponseDto(updatedReview),
      changeStatus,
      allApproved,
    };
  }

  /**
   * Reject a change
   */
  async reject(
    reviewId: string,
    userId: string,
    organizationId: string,
    reviewDecisionDto: ReviewDecisionDto,
  ): Promise<ReviewResponseDto> {
    const review = await this.prisma.review.findFirst({
      where: {
        id: reviewId,
        reviewerId: userId,
        change: { organizationId },
      },
      include: { change: true },
    });

    if (!review) {
      throw new NotFoundException(
        'Review not found or you are not the assigned reviewer',
      );
    }

    if (review.status === ReviewStatus.REJECTED) {
      throw new BadRequestException('Review is already rejected');
    }

    // Update review
    const updatedReview = await this.prisma.review.update({
      where: { id: reviewId },
      data: {
        status: ReviewStatus.REJECTED,
        decision: 'reject',
        feedback: reviewDecisionDto.feedback || 'No feedback provided',
        completedAt: new Date(),
      },
      include: {
        change: {
          select: {
            id: true,
            title: true,
            changeType: true,
            riskScore: true,
            riskAssessment: true,
            authorId: true,
          },
        },
        reviewer: {
          select: {
            id: true,
            name: true,
            email: true,
            role: true,
          },
        },
      },
    });

    // Update change status to REJECTED
    await this.prisma.change.update({
      where: { id: review.changeId },
      data: { status: 'REJECTED' },
    });

    // Notify change author (if known)
    if (review.change.authorId) {
      await this.notificationsService.sendNotification({
        userId: review.change.authorId,
        type: 'REVIEW_REJECTED',
        title: 'Change Rejected',
        message: `${updatedReview.reviewer.name} rejected "${review.change.title}": ${reviewDecisionDto.feedback}`,
        data: {
          reviewId,
          changeId: review.changeId,
          reviewerName: updatedReview.reviewer.name,
          feedback: reviewDecisionDto.feedback,
        },
      });
    }

    this.logger.log(`Review ${reviewId} rejected by user ${userId}`);

    return this.mapToResponseDto(updatedReview);
  }

  /**
   * Request changes on a change
   */
  async requestChanges(
    reviewId: string,
    userId: string,
    organizationId: string,
    reviewDecisionDto: ReviewDecisionDto,
  ): Promise<ReviewResponseDto> {
    const review = await this.prisma.review.findFirst({
      where: {
        id: reviewId,
        reviewerId: userId,
        change: { organizationId },
      },
      include: { change: true },
    });

    if (!review) {
      throw new NotFoundException(
        'Review not found or you are not the assigned reviewer',
      );
    }

    // Update review
    const updatedReview = await this.prisma.review.update({
      where: { id: reviewId },
      data: {
        status: ReviewStatus.CHANGES_REQUESTED,
        decision: 'request_changes',
        feedback: reviewDecisionDto.feedback || 'Changes requested',
        completedAt: new Date(),
      },
      include: {
        change: {
          select: {
            id: true,
            title: true,
            changeType: true,
            riskScore: true,
            riskAssessment: true,
            authorId: true,
          },
        },
        reviewer: {
          select: {
            id: true,
            name: true,
            email: true,
            role: true,
          },
        },
      },
    });

    // Update change status to DRAFT
    await this.prisma.change.update({
      where: { id: review.changeId },
      data: { status: 'DRAFT' },
    });

    // Notify change author (if known)
    if (review.change.authorId) {
      await this.notificationsService.sendNotification({
        userId: review.change.authorId,
        type: 'CHANGE_REQUESTED',
        title: 'Changes Requested',
        message: `${updatedReview.reviewer.name} requested changes on "${review.change.title}": ${reviewDecisionDto.feedback}`,
        data: {
          reviewId,
          changeId: review.changeId,
          reviewerName: updatedReview.reviewer.name,
          feedback: reviewDecisionDto.feedback,
        },
      });
    }

    this.logger.log(
      `Changes requested on review ${reviewId} by user ${userId}`,
    );

    return this.mapToResponseDto(updatedReview);
  }

  /**
   * Check if all reviews for a change are approved
   */
  async checkAllApproved(changeId: string): Promise<boolean> {
    const reviews = await this.prisma.review.findMany({
      where: { changeId },
    });

    if (reviews.length === 0) return false;

    return reviews.every((review) => review.status === ReviewStatus.APPROVED);
  }

  /**
   * Get review metrics for an organization
   */
  async getReviewMetrics(
    organizationId: string,
    filters?: {
      from?: Date;
      to?: Date;
    },
  ): Promise<ReviewMetricsDto> {
    const whereClause: any = {
      change: { organizationId },
    };

    if (filters?.from || filters?.to) {
      whereClause.createdAt = {};
      if (filters.from) whereClause.createdAt.gte = filters.from;
      if (filters.to) whereClause.createdAt.lte = filters.to;
    }

    const [
      totalReviews,
      pendingReviews,
      inProgressReviews,
      completedReviews,
      allReviews,
    ] = await Promise.all([
      this.prisma.review.count({ where: whereClause }),
      this.prisma.review.count({
        where: { ...whereClause, status: ReviewStatus.PENDING },
      }),
      this.prisma.review.count({
        where: { ...whereClause, status: ReviewStatus.IN_PROGRESS },
      }),
      this.prisma.review.count({
        where: {
          ...whereClause,
          status: {
            in: [
              ReviewStatus.APPROVED,
              ReviewStatus.REJECTED,
              ReviewStatus.CHANGES_REQUESTED,
            ],
          },
        },
      }),
      this.prisma.review.findMany({
        where: {
          ...whereClause,
          completedAt: { not: null },
        },
        include: {
          change: {
            select: {
              riskScore: true,
              riskAssessment: true,
            },
          },
        },
      }),
    ]);

    // Calculate average times
    let totalResponseTime = 0;
    let totalReviewTime = 0;
    let approvalCount = 0;
    let rejectionCount = 0;
    let changesRequestedCount = 0;
    let overdueCount = 0;

    for (const review of allReviews) {
      if (review.startedAt) {
        const responseTime =
          (review.startedAt.getTime() - review.createdAt.getTime()) /
          (1000 * 60 * 60); // hours
        totalResponseTime += responseTime;
      }

      if (review.completedAt && review.startedAt) {
        const reviewTime =
          (review.completedAt.getTime() - review.startedAt.getTime()) /
          (1000 * 60 * 60); // hours
        totalReviewTime += reviewTime;
      }

      if (review.status === ReviewStatus.APPROVED) approvalCount++;
      if (review.status === ReviewStatus.REJECTED) rejectionCount++;
      if (review.status === ReviewStatus.CHANGES_REQUESTED)
        changesRequestedCount++;

      // Check if overdue
      const riskLevel = this.getRiskLevel(review.change.riskScore || 0);
      const sla = SLA_THRESHOLDS[riskLevel];
      const hoursSinceCreated =
        (Date.now() - review.createdAt.getTime()) / (1000 * 60 * 60);

      if (!review.completedAt && hoursSinceCreated > sla.review) {
        overdueCount++;
      }
    }

    const avgResponseTime =
      allReviews.length > 0 ? totalResponseTime / allReviews.length : 0;
    const avgReviewTime =
      allReviews.length > 0 ? totalReviewTime / allReviews.length : 0;
    const approvalRate =
      completedReviews > 0 ? approvalCount / completedReviews : 0;
    const rejectionRate =
      completedReviews > 0 ? rejectionCount / completedReviews : 0;
    const changesRequestedRate =
      completedReviews > 0 ? changesRequestedCount / completedReviews : 0;

    return {
      totalReviews,
      pendingReviews,
      inProgressReviews,
      completedReviews,
      averageResponseTime: Number(avgResponseTime.toFixed(2)),
      averageReviewTime: Number(avgReviewTime.toFixed(2)),
      approvalRate: Number(approvalRate.toFixed(2)),
      rejectionRate: Number(rejectionRate.toFixed(2)),
      changesRequestedRate: Number(changesRequestedRate.toFixed(2)),
      overdueReviews: overdueCount,
      dateRange:
        filters?.from || filters?.to
          ? {
              from: filters.from || new Date(0),
              to: filters.to || new Date(),
            }
          : undefined,
    };
  }

  /**
   * Auto-assign reviewers based on risk level
   */
  private async autoAssignReviewers(change: any): Promise<string[]> {
    const riskLevel = this.getRiskLevel(change.riskScore || 0);

    let reviewerCount = 0;
    let requiredRoles: UserRole[] = [];

    switch (riskLevel) {
      case 'low':
        // Auto-approve, no review needed
        return [];

      case 'medium':
        reviewerCount = 1;
        requiredRoles = [UserRole.PRO_DEVELOPER, UserRole.ADMIN];
        break;

      case 'high':
        reviewerCount = 2;
        requiredRoles = [UserRole.PRO_DEVELOPER, UserRole.ADMIN];
        break;

      case 'critical':
        reviewerCount = 3;
        requiredRoles = [UserRole.ADMIN]; // Senior developers/admins only
        break;
    }

    // Find available reviewers
    const reviewers = await this.prisma.user.findMany({
      where: {
        organizationId: change.organizationId,
        role: { in: requiredRoles },
        id: { not: change.authorId }, // Don't assign the author
      },
      take: reviewerCount,
    });

    return reviewers.map((r) => r.id);
  }

  /**
   * Notify reviewers of new assignment
   */
  private async notifyReviewers(
    reviews: ReviewResponseDto[],
    change: any,
  ): Promise<void> {
    for (const review of reviews) {
      try {
        await this.notificationsService.sendNotification({
          userId: review.reviewerId,
          type: 'REVIEW_ASSIGNED',
          title: 'New Review Assigned',
          message: `You have been assigned to review "${change.title}"`,
          data: {
            reviewId: review.id,
            changeId: change.id,
            changeName: change.title,
            riskLevel: this.getRiskLevel(change.riskScore || 0),
          },
        });
      } catch (error) {
        this.logger.error(
          `Failed to notify reviewer ${review.reviewerId}: ${error.message}`,
        );
      }
    }
  }

  /**
   * Get risk level from risk score
   */
  private getRiskLevel(
    riskScore: number,
  ): 'low' | 'medium' | 'high' | 'critical' {
    if (riskScore < 30) return 'low';
    if (riskScore < 60) return 'medium';
    if (riskScore < 80) return 'high';
    return 'critical';
  }

  /**
   * Calculate SLA metrics for a review
   */
  private calculateSLA(review: any): ReviewSLADto {
    const riskLevel = this.getRiskLevel(review.change.riskScore || 0);
    const sla = SLA_THRESHOLDS[riskLevel];

    let responseTime: number | undefined;
    let reviewTime: number | undefined;
    let isOverdue = false;

    if (review.startedAt) {
      responseTime =
        (review.startedAt.getTime() - review.createdAt.getTime()) /
        (1000 * 60 * 60);
    }

    if (review.completedAt && review.startedAt) {
      reviewTime =
        (review.completedAt.getTime() - review.startedAt.getTime()) /
        (1000 * 60 * 60);
    }

    // Check if overdue
    if (!review.completedAt) {
      const hoursSinceCreated =
        (Date.now() - review.createdAt.getTime()) / (1000 * 60 * 60);
      isOverdue = hoursSinceCreated > sla.review;
    }

    const expectedCompletionAt = new Date(
      review.createdAt.getTime() + sla.review * 60 * 60 * 1000,
    );

    return {
      responseTime: responseTime ? Number(responseTime.toFixed(2)) : undefined,
      reviewTime: reviewTime ? Number(reviewTime.toFixed(2)) : undefined,
      isOverdue,
      expectedCompletionAt,
    };
  }

  /**
   * Map database review to response DTO
   */
  private mapToResponseDto(review: any): ReviewResponseDto {
    const riskAssessment = review.change.riskAssessment as any;
    const riskLevel =
      riskAssessment?.level || this.getRiskLevel(review.change.riskScore || 0);

    return {
      id: review.id,
      changeId: review.changeId,
      change: {
        id: review.change.id,
        title: review.change.title,
        changeType: review.change.changeType,
        riskLevel,
        riskScore: review.change.riskScore,
      },
      reviewerId: review.reviewerId,
      reviewer: {
        id: review.reviewer.id,
        name: review.reviewer.name,
        email: review.reviewer.email,
        role: review.reviewer.role,
      },
      status: review.status,
      decision: review.decision,
      feedback: review.feedback,
      startedAt: review.startedAt,
      completedAt: review.completedAt,
      createdAt: review.createdAt,
      updatedAt: review.updatedAt,
      sla: this.calculateSLA(review),
    };
  }
}

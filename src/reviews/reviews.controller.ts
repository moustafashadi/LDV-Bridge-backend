import {
  Controller,
  Get,
  Post,
  Put,
  Delete,
  Body,
  Param,
  Query,
  HttpCode,
  HttpStatus,
  UseGuards,
  Request,
} from '@nestjs/common';
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiBearerAuth,
  ApiParam,
  ApiQuery,
} from '@nestjs/swagger';
import { ReviewsService } from './reviews.service';
import { CommentsService } from './comments.service';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { UserRole, ReviewStatus } from '@prisma/client';
import { SubmitForReviewDto } from './dto/submit-for-review.dto';
import { ReviewDecisionDto } from './dto/review-decision.dto';
import { ReviewResponseDto } from './dto/review-response.dto';
import { ReviewMetricsDto } from './dto/review-metrics.dto';
import { CreateCommentDto } from './dto/create-comment.dto';
import { UpdateCommentDto } from './dto/update-comment.dto';
import { CommentResponseDto } from './dto/comment-response.dto';

@ApiTags('Reviews')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Controller('reviews')
export class ReviewsController {
  constructor(
    private readonly reviewsService: ReviewsService,
    private readonly commentsService: CommentsService,
  ) {}

  @Post('submit/:changeId')
  @HttpCode(HttpStatus.OK)
  @Roles(UserRole.CITIZEN_DEVELOPER, UserRole.PRO_DEVELOPER, UserRole.ADMIN)
  @ApiOperation({ summary: 'Submit a change for review' })
  @ApiParam({ name: 'changeId', description: 'ID of the change to submit' })
  @ApiResponse({
    status: 200,
    description: 'Change submitted for review successfully',
  })
  @ApiResponse({ status: 404, description: 'Change not found' })
  async submitForReview(
    @Param('changeId') changeId: string,
    @Body() submitForReviewDto: SubmitForReviewDto,
    @Request() req: any,
  ) {
    return this.reviewsService.submitForReview(
      changeId,
      req.user.userId,
      req.user.organizationId,
      submitForReviewDto,
    );
  }

  @Get()
  @Roles(UserRole.PRO_DEVELOPER, UserRole.ADMIN)
  @ApiOperation({ summary: 'Get all reviews with filters' })
  @ApiQuery({ name: 'changeId', required: false, description: 'Filter by change ID' })
  @ApiQuery({ name: 'reviewerId', required: false, description: 'Filter by reviewer ID' })
  @ApiQuery({ name: 'status', required: false, enum: ReviewStatus, description: 'Filter by status' })
  @ApiQuery({ name: 'page', required: false, type: Number, description: 'Page number (default: 1)' })
  @ApiQuery({ name: 'limit', required: false, type: Number, description: 'Items per page (default: 20)' })
  @ApiResponse({
    status: 200,
    description: 'List of reviews',
    type: [ReviewResponseDto],
  })
  async findAll(
    @Query('changeId') changeId?: string,
    @Query('reviewerId') reviewerId?: string,
    @Query('status') status?: ReviewStatus,
    @Query('page') page?: number,
    @Query('limit') limit?: number,
    @Request() req?: any,
  ) {
    return this.reviewsService.findAll(req.user.organizationId, {
      changeId,
      reviewerId,
      status,
      page: page ? Number(page) : undefined,
      limit: limit ? Number(limit) : undefined,
    });
  }

  @Get('metrics')
  @Roles(UserRole.PRO_DEVELOPER, UserRole.ADMIN)
  @ApiOperation({ summary: 'Get review metrics for the organization' })
  @ApiQuery({ name: 'from', required: false, type: Date, description: 'Start date for metrics' })
  @ApiQuery({ name: 'to', required: false, type: Date, description: 'End date for metrics' })
  @ApiResponse({
    status: 200,
    description: 'Review metrics',
    type: ReviewMetricsDto,
  })
  async getMetrics(
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Request() req?: any,
  ): Promise<ReviewMetricsDto> {
    const filters: any = {};
    if (from) filters.from = new Date(from);
    if (to) filters.to = new Date(to);

    return this.reviewsService.getReviewMetrics(req.user.organizationId, filters);
  }

  @Get(':id')
  @Roles(UserRole.PRO_DEVELOPER, UserRole.ADMIN, UserRole.CITIZEN_DEVELOPER)
  @ApiOperation({ summary: 'Get a single review by ID' })
  @ApiParam({ name: 'id', description: 'Review ID' })
  @ApiResponse({
    status: 200,
    description: 'Review details',
    type: ReviewResponseDto,
  })
  @ApiResponse({ status: 404, description: 'Review not found' })
  async findOne(@Param('id') id: string, @Request() req: any): Promise<ReviewResponseDto> {
    return this.reviewsService.findOne(id, req.user.organizationId);
  }

  @Post(':id/start')
  @HttpCode(HttpStatus.OK)
  @Roles(UserRole.PRO_DEVELOPER, UserRole.ADMIN)
  @ApiOperation({ summary: 'Start a review (mark as IN_PROGRESS)' })
  @ApiParam({ name: 'id', description: 'Review ID' })
  @ApiResponse({
    status: 200,
    description: 'Review started successfully',
    type: ReviewResponseDto,
  })
  @ApiResponse({ status: 404, description: 'Review not found' })
  async startReview(@Param('id') id: string, @Request() req: any): Promise<ReviewResponseDto> {
    return this.reviewsService.startReview(id, req.user.userId, req.user.organizationId);
  }

  @Post(':id/approve')
  @HttpCode(HttpStatus.OK)
  @Roles(UserRole.PRO_DEVELOPER, UserRole.ADMIN)
  @ApiOperation({ summary: 'Approve a change' })
  @ApiParam({ name: 'id', description: 'Review ID' })
  @ApiResponse({
    status: 200,
    description: 'Change approved successfully',
  })
  @ApiResponse({ status: 404, description: 'Review not found' })
  async approve(
    @Param('id') id: string,
    @Body() reviewDecisionDto: ReviewDecisionDto,
    @Request() req: any,
  ) {
    return this.reviewsService.approve(
      id,
      req.user.userId,
      req.user.organizationId,
      reviewDecisionDto,
    );
  }

  @Post(':id/reject')
  @HttpCode(HttpStatus.OK)
  @Roles(UserRole.PRO_DEVELOPER, UserRole.ADMIN)
  @ApiOperation({ summary: 'Reject a change' })
  @ApiParam({ name: 'id', description: 'Review ID' })
  @ApiResponse({
    status: 200,
    description: 'Change rejected successfully',
    type: ReviewResponseDto,
  })
  @ApiResponse({ status: 404, description: 'Review not found' })
  async reject(
    @Param('id') id: string,
    @Body() reviewDecisionDto: ReviewDecisionDto,
    @Request() req: any,
  ): Promise<ReviewResponseDto> {
    return this.reviewsService.reject(
      id,
      req.user.userId,
      req.user.organizationId,
      reviewDecisionDto,
    );
  }

  @Post(':id/request-changes')
  @HttpCode(HttpStatus.OK)
  @Roles(UserRole.PRO_DEVELOPER, UserRole.ADMIN)
  @ApiOperation({ summary: 'Request changes on a change' })
  @ApiParam({ name: 'id', description: 'Review ID' })
  @ApiResponse({
    status: 200,
    description: 'Changes requested successfully',
    type: ReviewResponseDto,
  })
  @ApiResponse({ status: 404, description: 'Review not found' })
  async requestChanges(
    @Param('id') id: string,
    @Body() reviewDecisionDto: ReviewDecisionDto,
    @Request() req: any,
  ): Promise<ReviewResponseDto> {
    return this.reviewsService.requestChanges(
      id,
      req.user.userId,
      req.user.organizationId,
      reviewDecisionDto,
    );
  }

  // ============== Comments Endpoints ==============

  @Post(':changeId/comments')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Add a comment to a change' })
  @ApiParam({ name: 'changeId', description: 'ID of the change' })
  @ApiResponse({
    status: 201,
    description: 'Comment created successfully',
    type: CommentResponseDto,
  })
  @ApiResponse({ status: 404, description: 'Change not found' })
  async createComment(
    @Param('changeId') changeId: string,
    @Body() createCommentDto: CreateCommentDto,
    @Request() req: any,
  ): Promise<CommentResponseDto> {
    return this.commentsService.create(
      changeId,
      req.user.userId,
      req.user.organizationId,
      createCommentDto,
    );
  }

  @Get(':changeId/comments')
  @ApiOperation({ summary: 'Get all comments for a change (with threading)' })
  @ApiParam({ name: 'changeId', description: 'ID of the change' })
  @ApiResponse({
    status: 200,
    description: 'List of comments',
    type: [CommentResponseDto],
  })
  async getComments(
    @Param('changeId') changeId: string,
    @Request() req: any,
  ): Promise<CommentResponseDto[]> {
    return this.commentsService.findByChange(changeId, req.user.organizationId);
  }

  @Put('comments/:commentId')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Update a comment' })
  @ApiParam({ name: 'commentId', description: 'ID of the comment' })
  @ApiResponse({
    status: 200,
    description: 'Comment updated successfully',
    type: CommentResponseDto,
  })
  @ApiResponse({ status: 404, description: 'Comment not found' })
  async updateComment(
    @Param('commentId') commentId: string,
    @Body() updateCommentDto: UpdateCommentDto,
    @Request() req: any,
  ): Promise<CommentResponseDto> {
    return this.commentsService.update(
      commentId,
      req.user.userId,
      req.user.organizationId,
      updateCommentDto,
    );
  }

  @Delete('comments/:commentId')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Delete a comment' })
  @ApiParam({ name: 'commentId', description: 'ID of the comment' })
  @ApiResponse({ status: 204, description: 'Comment deleted successfully' })
  @ApiResponse({ status: 404, description: 'Comment not found' })
  async deleteComment(@Param('commentId') commentId: string, @Request() req: any): Promise<void> {
    const isAdmin = req.user.role === UserRole.ADMIN;
    return this.commentsService.delete(
      commentId,
      req.user.userId,
      req.user.organizationId,
      isAdmin,
    );
  }

  @Post('comments/:commentId/resolve')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Mark a comment as resolved' })
  @ApiParam({ name: 'commentId', description: 'ID of the comment' })
  @ApiResponse({
    status: 200,
    description: 'Comment resolved successfully',
    type: CommentResponseDto,
  })
  async resolveComment(
    @Param('commentId') commentId: string,
    @Request() req: any,
  ): Promise<CommentResponseDto> {
    return this.commentsService.resolve(
      commentId,
      req.user.userId,
      req.user.organizationId,
    );
  }

  @Post('comments/:commentId/unresolve')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Mark a comment as unresolved' })
  @ApiParam({ name: 'commentId', description: 'ID of the comment' })
  @ApiResponse({
    status: 200,
    description: 'Comment unresolved successfully',
    type: CommentResponseDto,
  })
  async unresolveComment(
    @Param('commentId') commentId: string,
    @Request() req: any,
  ): Promise<CommentResponseDto> {
    return this.commentsService.unresolve(
      commentId,
      req.user.userId,
      req.user.organizationId,
    );
  }
}

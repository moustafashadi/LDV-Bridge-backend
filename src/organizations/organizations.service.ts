import {
  Injectable,
  NotFoundException,
  ForbiddenException,
  BadRequestException,
  ConflictException,
  Logger,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { UserRole, UserStatus } from '@prisma/client';
import {
  UpdateOrganizationDto,
  ApproveJoinRequestDto,
  RejectJoinRequestDto,
  CreateInvitationCodeDto,
  UpdateInvitationCodeDto,
} from './dto';
import { customAlphabet } from 'nanoid';

// Custom alphabet for invitation codes (uppercase + numbers, no confusing chars)
const nanoid = customAlphabet('ABCDEFGHJKLMNPQRSTUVWXYZ23456789', 10);

/**
 * Organizations Service
 * Handles organization management, join requests, and invitation codes
 */
@Injectable()
export class OrganizationsService {
  private readonly logger = new Logger(OrganizationsService.name);

  constructor(private prisma: PrismaService) {}

  /**
   * Get organization by ID
   */
  async findOne(organizationId: string, requestingUserId: string) {
    const organization = await this.prisma.organization.findUnique({
      where: { id: organizationId },
      include: {
        _count: {
          select: {
            users: true,
            apps: true,
            policies: true,
          },
        },
      },
    });

    if (!organization) {
      throw new NotFoundException('Organization not found');
    }

    // Verify requesting user belongs to this organization
    const user = await this.prisma.user.findUnique({
      where: { id: requestingUserId },
    });

    if (!user || user.organizationId !== organizationId) {
      throw new ForbiddenException('Access denied');
    }

    return organization;
  }

  /**
   * Update organization (admin only)
   */
  async update(
    organizationId: string,
    requestingUserId: string,
    dto: UpdateOrganizationDto,
  ) {
    // Verify user is admin of this organization
    await this.verifyAdmin(requestingUserId, organizationId);

    const organization = await this.prisma.organization.update({
      where: { id: organizationId },
      data: dto,
    });

    this.logger.log(`Organization updated: ${organization.id}`);
    return organization;
  }

  /**
   * Get organization statistics
   */
  async getStats(organizationId: string, requestingUserId: string) {
    await this.verifyAccess(requestingUserId, organizationId);

    const [
      totalUsers,
      activeUsers,
      pendingRequests,
      totalApps,
      totalPolicies,
      usersByRole,
    ] = await Promise.all([
      this.prisma.user.count({
        where: { organizationId },
      }),
      this.prisma.user.count({
        where: { organizationId, status: UserStatus.ACTIVE },
      }),
      this.prisma.organizationRequest.count({
        where: { organizationId, status: 'pending' },
      }),
      this.prisma.app.count({
        where: { organizationId },
      }),
      this.prisma.policy.count({
        where: { organizationId },
      }),
      this.prisma.user.groupBy({
        by: ['role'],
        where: { organizationId, status: UserStatus.ACTIVE },
        _count: true,
      }),
    ]);

    return {
      users: {
        total: totalUsers,
        active: activeUsers,
        byRole: usersByRole.reduce((acc, item) => {
          acc[item.role] = item._count;
          return acc;
        }, {}),
      },
      pendingRequests,
      apps: totalApps,
      policies: totalPolicies,
    };
  }

  // ========================================
  // JOIN REQUESTS (Admin Approval Flow)
  // ========================================

  /**
   * Get pending join requests for organization (admin only)
   */
  async getPendingJoinRequests(organizationId: string, requestingUserId: string) {
    await this.verifyAdmin(requestingUserId, organizationId);

    const requests = await this.prisma.organizationRequest.findMany({
      where: {
        organizationId,
        status: 'pending',
      },
      orderBy: {
        createdAt: 'asc',
      },
    });

    // Transform the data to match frontend expectations
    // Frontend expects: { id, user: { email, name }, requestedRole, message, createdAt }
    return requests.map(request => ({
      id: request.id,
      userId: request.auth0Id,
      organizationId: request.organizationId,
      requestedRole: request.requestedRole,
      status: request.status,
      message: request.message,
      user: {
        email: request.email,
        name: request.name,
      },
      createdAt: request.createdAt,
      updatedAt: request.updatedAt,
    }));
  }

  /**
   * Approve join request and create user (admin only)
   */
  async approveJoinRequest(
    organizationId: string,
    requestId: string,
    requestingUserId: string,
    dto: ApproveJoinRequestDto,
  ) {
    await this.verifyAdmin(requestingUserId, organizationId);

    const request = await this.prisma.organizationRequest.findUnique({
      where: { id: requestId },
    });

    if (!request) {
      throw new NotFoundException('Join request not found');
    }

    if (request.organizationId !== organizationId) {
      throw new ForbiddenException('Request does not belong to your organization');
    }

    if (request.status !== 'pending') {
      throw new BadRequestException('Request has already been processed');
    }

    // Check if user already exists (in case they used a different flow)
    const existingUser = await this.prisma.user.findUnique({
      where: { auth0Id: request.auth0Id },
    });

    if (existingUser) {
      throw new ConflictException('User already exists in the system');
    }

    // Create user and update request in transaction
    const result = await this.prisma.$transaction(async (tx) => {
      // Create user with approved role
      const user = await tx.user.create({
        data: {
          auth0Id: request.auth0Id,
          email: request.email,
          name: request.name,
          organizationId,
          role: dto.role, // Admin can override requested role
          status: UserStatus.ACTIVE,
          approvedBy: requestingUserId,
          approvedAt: new Date(),
        },
      });

      // Update request status
      await tx.organizationRequest.update({
        where: { id: requestId },
        data: {
          status: 'approved',
          reviewedBy: requestingUserId,
          reviewedAt: new Date(),
        },
      });

      return user;
    });

    this.logger.log(
      `Join request approved: ${request.email} → ${organizationId} as ${dto.role}`,
    );

    // TODO: Send notification email to user

    return result;
  }

  /**
   * Reject join request (admin only)
   */
  async rejectJoinRequest(
    organizationId: string,
    requestId: string,
    requestingUserId: string,
    dto: RejectJoinRequestDto,
  ) {
    await this.verifyAdmin(requestingUserId, organizationId);

    const request = await this.prisma.organizationRequest.findUnique({
      where: { id: requestId },
    });

    if (!request) {
      throw new NotFoundException('Join request not found');
    }

    if (request.organizationId !== organizationId) {
      throw new ForbiddenException('Request does not belong to your organization');
    }

    if (request.status !== 'pending') {
      throw new BadRequestException('Request has already been processed');
    }

    await this.prisma.organizationRequest.update({
      where: { id: requestId },
      data: {
        status: 'rejected',
        reviewedBy: requestingUserId,
        reviewedAt: new Date(),
        rejectionReason: dto.reason,
      },
    });

    this.logger.log(`Join request rejected: ${request.email} → ${organizationId}`);

    // TODO: Send notification email to user

    return { message: 'Join request rejected' };
  }

  // ========================================
  // INVITATION CODES (Team Invitations)
  // ========================================

  /**
   * Create invitation code (admin only)
   */
  async createInvitationCode(
    organizationId: string,
    requestingUserId: string,
    dto: CreateInvitationCodeDto,
  ) {
    await this.verifyAdmin(requestingUserId, organizationId);

    // Generate unique code
    const code = `ORG-${nanoid()}`;

    const invitationCode = await this.prisma.invitationCode.create({
      data: {
        organizationId,
        code,
        role: dto.role,
        maxUses: dto.maxUses,
        expiresAt: dto.expiresAt ? new Date(dto.expiresAt) : null,
        createdBy: requestingUserId,
      },
    });

    this.logger.log(`Invitation code created: ${code} for org ${organizationId}`);

    return invitationCode;
  }

  /**
   * List invitation codes (admin only)
   */
  async listInvitationCodes(organizationId: string, requestingUserId: string) {
    await this.verifyAdmin(requestingUserId, organizationId);

    const codes = await this.prisma.invitationCode.findMany({
      where: { organizationId },
      orderBy: { createdAt: 'desc' },
    });

    return codes;
  }

  /**
   * Update invitation code (admin only)
   */
  async updateInvitationCode(
    organizationId: string,
    codeId: string,
    requestingUserId: string,
    dto: UpdateInvitationCodeDto,
  ) {
    await this.verifyAdmin(requestingUserId, organizationId);

    const invitationCode = await this.prisma.invitationCode.findUnique({
      where: { id: codeId },
    });

    if (!invitationCode) {
      throw new NotFoundException('Invitation code not found');
    }

    if (invitationCode.organizationId !== organizationId) {
      throw new ForbiddenException('Code does not belong to your organization');
    }

    const updated = await this.prisma.invitationCode.update({
      where: { id: codeId },
      data: {
        ...(dto.isActive !== undefined && { isActive: dto.isActive }),
        ...(dto.expiresAt && { expiresAt: new Date(dto.expiresAt) }),
      },
    });

    return updated;
  }

  /**
   * Delete invitation code (admin only)
   */
  async deleteInvitationCode(
    organizationId: string,
    codeId: string,
    requestingUserId: string,
  ) {
    await this.verifyAdmin(requestingUserId, organizationId);

    const invitationCode = await this.prisma.invitationCode.findUnique({
      where: { id: codeId },
    });

    if (!invitationCode) {
      throw new NotFoundException('Invitation code not found');
    }

    if (invitationCode.organizationId !== organizationId) {
      throw new ForbiddenException('Code does not belong to your organization');
    }

    await this.prisma.invitationCode.delete({
      where: { id: codeId },
    });

    return { message: 'Invitation code deleted' };
  }

  // ========================================
  // HELPER METHODS
  // ========================================

  /**
   * Verify user is admin of organization
   */
  private async verifyAdmin(userId: string, organizationId: string) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
    });

    if (!user) {
      throw new NotFoundException('User not found');
    }

    if (user.organizationId !== organizationId) {
      throw new ForbiddenException('Access denied');
    }

    if (user.role !== UserRole.ADMIN) {
      throw new ForbiddenException('Admin access required');
    }
  }

  /**
   * Verify user has access to organization
   */
  private async verifyAccess(userId: string, organizationId: string) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
    });

    if (!user || user.organizationId !== organizationId) {
      throw new ForbiddenException('Access denied');
    }
  }
}

import {
  Injectable,
  NotFoundException,
  BadRequestException,
  ForbiddenException,
  ConflictException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { User, UserRole, UserStatus, Prisma } from '@prisma/client';
import { InviteUserDto } from './dto/invite-user.dto';
import { UpdateUserDto } from './dto/update-user.dto';
import { UpdateUserRoleDto } from './dto/update-user-role.dto';
import { ListUsersQueryDto } from './dto/list-users-query.dto';
import { PaginatedUsersResponseDto } from './dto/user-response.dto';
import * as crypto from 'crypto';

@Injectable()
export class UsersService {
  constructor(private prisma: PrismaService) {}

  /**
   * List users with pagination and filtering
   */
  async findAll(
    organizationId: string,
    query: ListUsersQueryDto,
  ): Promise<PaginatedUsersResponseDto> {
    const { page = 1, limit = 50, role, status, search } = query;
    const skip = (page - 1) * limit;

    // Build filter conditions
    const where: Prisma.UserWhereInput = {
      organizationId,
    };

    if (role) {
      where.role = role;
    }

    if (status) {
      where.status = status;
    }

    if (search) {
      where.OR = [
        { email: { contains: search, mode: 'insensitive' } },
        { displayName: { contains: search, mode: 'insensitive' } },
        { name: { contains: search, mode: 'insensitive' } },
      ];
    }

    // Execute query with pagination
    const [users, total] = await Promise.all([
      this.prisma.user.findMany({
        where,
        skip,
        take: limit,
        orderBy: { createdAt: 'desc' },
        select: {
          id: true,
          email: true,
          name: true,
          displayName: true,
          avatarUrl: true,
          role: true,
          status: true,
          organizationId: true,
          lastLoginAt: true,
          createdAt: true,
          updatedAt: true,
        },
      }),
      this.prisma.user.count({ where }),
    ]);

    return {
      data: users,
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit),
    };
  }

  /**
   * Get user by ID
   */
  async findOne(id: string, organizationId: string): Promise<User> {
    const user = await this.prisma.user.findUnique({
      where: { id },
      include: { organization: true },
    });

    if (!user) {
      throw new NotFoundException(`User with ID ${id} not found`);
    }

    // Ensure user belongs to the organization
    if (user.organizationId !== organizationId) {
      throw new ForbiddenException('Access denied to this user');
    }

    return user;
  }

  /**
   * Get current user (alias for auth/profile)
   */
  async getMe(userId: string): Promise<User> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      include: { organization: true },
    });

    if (!user) {
      throw new NotFoundException('User not found');
    }

    return user;
  }

  /**
   * Update user profile (self or admin)
   */
  async update(
    id: string,
    updateUserDto: UpdateUserDto,
    organizationId: string,
  ): Promise<User> {
    // Check if user exists and belongs to organization
    await this.findOne(id, organizationId);

    const user = await this.prisma.user.update({
      where: { id },
      data: updateUserDto,
      include: { organization: true },
    });

    return user;
  }

  /**
   * Update user role (admin only)
   */
  async updateRole(
    id: string,
    updateUserRoleDto: UpdateUserRoleDto,
    organizationId: string,
  ): Promise<User> {
    // Check if user exists and belongs to organization
    await this.findOne(id, organizationId);

    const user = await this.prisma.user.update({
      where: { id },
      data: { role: updateUserRoleDto.role },
      include: { organization: true },
    });

    return user;
  }

  /**
   * Deactivate user (soft delete)
   */
  async deactivate(id: string, organizationId: string): Promise<User> {
    // Check if user exists and belongs to organization
    const user = await this.findOne(id, organizationId);

    // Prevent deactivating the last admin
    if (user.role === UserRole.ADMIN) {
      const adminCount = await this.prisma.user.count({
        where: {
          organizationId,
          role: UserRole.ADMIN,
          status: UserStatus.ACTIVE,
        },
      });

      if (adminCount <= 1) {
        throw new BadRequestException(
          'Cannot deactivate the last admin of the organization',
        );
      }
    }

    return this.prisma.user.update({
      where: { id },
      data: { status: UserStatus.INACTIVE },
      include: { organization: true },
    });
  }

  /**
   * Reactivate user
   */
  async reactivate(id: string, organizationId: string): Promise<User> {
    await this.findOne(id, organizationId);

    return this.prisma.user.update({
      where: { id },
      data: { status: UserStatus.ACTIVE },
      include: { organization: true },
    });
  }

  /**
   * Suspend user
   */
  async suspend(id: string, organizationId: string): Promise<User> {
    await this.findOne(id, organizationId);

    return this.prisma.user.update({
      where: { id },
      data: { status: UserStatus.SUSPENDED },
      include: { organization: true },
    });
  }

  /**
   * Invite a new user to the organization
   */
  async inviteUser(
    inviteUserDto: InviteUserDto,
    organizationId: string,
  ): Promise<{ success: boolean; invitationId: string; token: string }> {
    const { email, role } = inviteUserDto;

    // Check if user already exists
    const existingUser = await this.prisma.user.findFirst({
      where: { email, organizationId },
    });

    if (existingUser) {
      throw new ConflictException('User with this email already exists in your organization');
    }

    // Check if there's already a pending invitation
    const existingInvitation = await this.prisma.invitation.findFirst({
      where: {
        email,
        organizationId,
        acceptedAt: null,
        expiresAt: { gte: new Date() },
      },
    });

    if (existingInvitation) {
      throw new ConflictException('An invitation has already been sent to this email');
    }

    // Generate secure token
    const token = crypto.randomBytes(32).toString('hex');

    // Create invitation (expires in 7 days)
    const expiresAt = new Date();
    expiresAt.setDate(expiresAt.getDate() + 7);

    const invitation = await this.prisma.invitation.create({
      data: {
        email,
        role,
        token,
        expiresAt,
        organizationId,
      },
    });

    // TODO: Queue email sending job
    // await this.emailQueue.add('send-invitation', {
    //   email,
    //   token,
    //   organizationId,
    //   message: inviteUserDto.message
    // });

    return {
      success: true,
      invitationId: invitation.id,
      token, // Return token for testing (remove in production)
    };
  }

  /**
   * Accept invitation and create user account
   * This is called after Auth0 signup
   */
  async acceptInvitation(token: string, auth0Id: string): Promise<User> {
    const invitation = await this.prisma.invitation.findUnique({
      where: { token },
    });

    if (!invitation) {
      throw new NotFoundException('Invalid invitation token');
    }

    if (invitation.acceptedAt) {
      throw new BadRequestException('Invitation has already been accepted');
    }

    if (invitation.expiresAt < new Date()) {
      throw new BadRequestException('Invitation has expired');
    }

    // Create user from invitation
    const user = await this.prisma.user.create({
      data: {
        auth0Id,
        email: invitation.email,
        role: invitation.role,
        organizationId: invitation.organizationId,
        status: UserStatus.ACTIVE,
      },
      include: { organization: true },
    });

    // Mark invitation as accepted
    await this.prisma.invitation.update({
      where: { id: invitation.id },
      data: { acceptedAt: new Date() },
    });

    return user;
  }

  /**
   * Get pending invitations for an organization
   */
  async getPendingInvitations(organizationId: string) {
    return this.prisma.invitation.findMany({
      where: {
        organizationId,
        acceptedAt: null,
        expiresAt: { gte: new Date() },
      },
      orderBy: { createdAt: 'desc' },
    });
  }

  /**
   * Revoke/cancel an invitation
   */
  async revokeInvitation(invitationId: string, organizationId: string) {
    const invitation = await this.prisma.invitation.findUnique({
      where: { id: invitationId },
    });

    if (!invitation) {
      throw new NotFoundException('Invitation not found');
    }

    if (invitation.organizationId !== organizationId) {
      throw new ForbiddenException('Access denied to this invitation');
    }

    if (invitation.acceptedAt) {
      throw new BadRequestException('Cannot revoke an accepted invitation');
    }

    await this.prisma.invitation.delete({
      where: { id: invitationId },
    });

    return { success: true, message: 'Invitation revoked successfully' };
  }
}


import {
  Injectable,
  BadRequestException,
  NotFoundException,
  ConflictException,
  Logger,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { UserRole, UserStatus } from '@prisma/client';
import {
  CompleteOnboardingDto,
  OnboardingFlow,
  CreateOrganizationDto,
  JoinOrganizationDto,
  SearchOrganizationDto,
} from './dto';

/**
 * Onboarding Service
 * Handles the hybrid onboarding flow with organization creation and join requests
 */
@Injectable()
export class OnboardingService {
  private readonly logger = new Logger(OnboardingService.name);

  constructor(private prisma: PrismaService) {}

  /**
   * Search for organizations (used during signup to find existing org)
   */
  async searchOrganizations(dto: SearchOrganizationDto) {
    const { query, domain, limit = 10 } = dto;

    const where: any = {
      isActive: true,
    };

    if (query) {
      where.name = {
        contains: query,
        mode: 'insensitive',
      };
    }

    if (domain) {
      where.domain = domain;
    }

    const organizations = await this.prisma.organization.findMany({
      where,
      take: limit,
      select: {
        id: true,
        name: true,
        slug: true,
        domain: true,
        _count: {
          select: {
            users: true,
          },
        },
      },
      orderBy: {
        name: 'asc',
      },
    });

    return organizations.map((org) => ({
      id: org.id,
      name: org.name,
      slug: org.slug,
      domain: org.domain,
      userCount: org._count.users,
    }));
  }

  /**
   * Complete onboarding process
   * Handles three flows: CREATE_ORG, JOIN_ORG, USE_CODE
   */
  async completeOnboarding(
    auth0Id: string,
    email: string,
    name: string | null,
    dto: CompleteOnboardingDto,
  ) {
    // Check if user already exists
    const existingUser = await this.prisma.user.findUnique({
      where: { auth0Id },
    });

    if (existingUser) {
      throw new ConflictException('User already onboarded');
    }

    switch (dto.flow) {
      case OnboardingFlow.CREATE_ORG:
        return this.createOrganizationFlow(auth0Id, email, name, dto.createOrg!);

      case OnboardingFlow.JOIN_ORG:
        return this.joinOrganizationFlow(auth0Id, email, name, dto.joinOrg!);

      case OnboardingFlow.USE_CODE:
        return this.useInvitationCodeFlow(auth0Id, email, name, dto.invitationCode!);

      default:
        throw new BadRequestException('Invalid onboarding flow');
    }
  }

  /**
   * Flow 1: Create new organization (user becomes ADMIN)
   */
  private async createOrganizationFlow(
    auth0Id: string,
    email: string,
    name: string | null,
    orgDto: CreateOrganizationDto,
  ) {
    this.logger.log(`Creating new organization: ${orgDto.name}`);

    // Generate slug if not provided
    const slug =
      orgDto.slug ||
      orgDto.name
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-|-$/g, '');

    // Check if slug is taken
    const existingOrg = await this.prisma.organization.findUnique({
      where: { slug },
    });

    if (existingOrg) {
      throw new ConflictException(
        'Organization slug already taken. Please choose a different name.',
      );
    }

    // Extract domain from email if not provided
    const domain = orgDto.domain || email.split('@')[1];

    // Create organization and user in transaction
    const result = await this.prisma.$transaction(async (tx) => {
      // Create organization
      const organization = await tx.organization.create({
        data: {
          name: orgDto.name,
          slug,
          domain,
          settings: orgDto.settings || {},
          subscriptionPlan: 'free',
          isActive: true,
        },
      });

      // Create user as ADMIN
      const user = await tx.user.create({
        data: {
          auth0Id,
          email,
          name,
          organizationId: organization.id,
          role: UserRole.ADMIN,
          status: UserStatus.ACTIVE,
          approvedAt: new Date(),
        },
        include: {
          organization: true,
        },
      });

      return { user, organization };
    });

    this.logger.log(`Organization created: ${result.organization.name}, Admin: ${email}`);

    return {
      status: 'active',
      user: result.user,
      organization: result.organization,
      message: 'Organization created successfully. You are now an admin.',
    };
  }

  /**
   * Flow 2: Join existing organization (needs admin approval)
   */
  private async joinOrganizationFlow(
    auth0Id: string,
    email: string,
    name: string | null,
    joinDto: JoinOrganizationDto,
  ) {
    this.logger.log(`User ${email} requesting to join org: ${joinDto.organizationId}`);

    // Verify organization exists and is active
    const organization = await this.prisma.organization.findUnique({
      where: { id: joinDto.organizationId },
    });

    if (!organization || !organization.isActive) {
      throw new NotFoundException('Organization not found or inactive');
    }

    // Check if there's already a pending request
    const existingRequest = await this.prisma.organizationRequest.findFirst({
      where: {
        auth0Id,
        organizationId: joinDto.organizationId,
        status: 'pending',
      },
    });

    if (existingRequest) {
      throw new ConflictException('You already have a pending request for this organization');
    }

    // Create join request
    const request = await this.prisma.organizationRequest.create({
      data: {
        organizationId: joinDto.organizationId,
        auth0Id,
        email,
        name,
        requestedRole: joinDto.requestedRole,
        message: joinDto.message,
        status: 'pending',
      },
      include: {
        organization: true,
      },
    });

    this.logger.log(`Join request created: ${request.id}`);

    // TODO: Send notification to organization admins

    return {
      status: 'pending_approval',
      request,
      message: 'Your request has been sent to organization admins. You will be notified once approved.',
    };
  }

  /**
   * Flow 3: Use invitation code (auto-approved with pre-assigned role)
   */
  private async useInvitationCodeFlow(
    auth0Id: string,
    email: string,
    name: string | null,
    code: string,
  ) {
    this.logger.log(`User ${email} using invitation code: ${code}`);

    // Find invitation code
    const invitationCode = await this.prisma.invitationCode.findUnique({
      where: { code },
      include: {
        organization: true,
      },
    });

    if (!invitationCode) {
      throw new NotFoundException('Invalid invitation code');
    }

    // Validate invitation code
    if (!invitationCode.isActive) {
      throw new BadRequestException('This invitation code is no longer active');
    }

    if (invitationCode.expiresAt && invitationCode.expiresAt < new Date()) {
      throw new BadRequestException('This invitation code has expired');
    }

    if (
      invitationCode.maxUses &&
      invitationCode.usedCount >= invitationCode.maxUses
    ) {
      throw new BadRequestException('This invitation code has reached its maximum uses');
    }

    // Create user and increment usage counter in transaction
    const result = await this.prisma.$transaction(async (tx) => {
      // Create user with pre-assigned role
      const user = await tx.user.create({
        data: {
          auth0Id,
          email,
          name,
          organizationId: invitationCode.organizationId,
          role: invitationCode.role,
          status: UserStatus.ACTIVE,
          approvedBy: invitationCode.createdBy,
          approvedAt: new Date(),
        },
        include: {
          organization: true,
        },
      });

      // Increment usage counter
      await tx.invitationCode.update({
        where: { id: invitationCode.id },
        data: {
          usedCount: { increment: 1 },
        },
      });

      return user;
    });

    this.logger.log(`User created via invitation code: ${email}, Role: ${result.role}`);

    return {
      status: 'active',
      user: result,
      organization: result.organization,
      message: `Welcome to ${result.organization.name}! You have been assigned the ${result.role} role.`,
    };
  }

  /**
   * Get user's onboarding status
   */
  async getOnboardingStatus(auth0Id: string) {
    console.log(`[OnboardingService] Checking status for auth0Id: ${auth0Id}`);
    
    // Check if user exists
    const user = await this.prisma.user.findUnique({
      where: { auth0Id },
      include: {
        organization: true,
      },
    });

    if (user) {
      console.log(`[OnboardingService] User found: ${user.email}, org: ${user.organizationId}, role: ${user.role}`);
      return {
        onboarded: true,
        status: user.status,
        role: user.role,
        organization: user.organization,
      };
    }

    console.log(`[OnboardingService] No user found for auth0Id: ${auth0Id}`);
    
    // Check if there are any pending join requests
    const pendingRequests = await this.prisma.organizationRequest.findMany({
      where: {
        auth0Id,
        status: 'pending',
      },
      include: {
        organization: true,
      },
    });

    if (pendingRequests.length > 0) {
      console.log(`[OnboardingService] Found ${pendingRequests.length} pending requests`);
      return {
        onboarded: false,
        status: 'pending_approval',
        pendingRequests: pendingRequests.map((req) => ({
          id: req.id,
          organizationName: req.organization.name,
          requestedRole: req.requestedRole,
          createdAt: req.createdAt,
        })),
      };
    }

    console.log(`[OnboardingService] User needs onboarding`);
    return {
      onboarded: false,
      status: 'needs_onboarding',
    };
  }
}

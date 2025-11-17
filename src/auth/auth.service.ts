import { Injectable, UnauthorizedException, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { User, UserRole } from '@prisma/client';

/**
 * Authentication Service
 * Handles user validation and authentication logic
 */
@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

  constructor(private prisma: PrismaService) {}

  /**
   * Validate user by ID and organization
   * Used by JWT strategy after token verification
   */
  async validateUser(userId: string, organizationId: string): Promise<User | null> {
    try {
      const user = await this.prisma.user.findUnique({
        where: {
          id: userId,
          organizationId,
        },
        include: {
          organization: true,
        },
      });

      return user;
    } catch (error) {
      this.logger.error(`Error validating user ${userId}:`, error);
      return null;
    }
  }

  /**
   * Validate or create user from Auth0 token
   * Called on first login or when custom claims are missing
   */
  async validateUserFromAuth0(
    auth0Id: string,
    email: string,
  ): Promise<User | null> {
    try {
      // Try to find existing user by Auth0 ID
      let user = await this.prisma.user.findUnique({
        where: { auth0Id },
        include: { organization: true },
      });

      if (user) {
        this.logger.log(`User found: ${user.email}`);
        return user;
      }

      // If user doesn't exist, they need to be invited first
      // Check if there's a pending invitation
      const invitation = await this.prisma.invitation.findFirst({
        where: {
          email,
          acceptedAt: null, // Not yet accepted
          expiresAt: {
            gte: new Date(), // Not expired
          },
        },
      });

      if (invitation) {
        // Create user from invitation
        user = await this.prisma.user.create({
          data: {
            auth0Id,
            email,
            organizationId: invitation.organizationId,
            role: invitation.role,
          },
          include: { organization: true },
        });

        // Mark invitation as accepted
        await this.prisma.invitation.update({
          where: { id: invitation.id },
          data: { acceptedAt: new Date() },
        });

        this.logger.log(`User created from invitation: ${user.email}`);
        return user;
      }

      // No invitation found - user is not authorized
      this.logger.warn(`Unauthorized login attempt: ${email}`);
      return null;
    } catch (error) {
      this.logger.error(`Error validating user from Auth0:`, error);
      return null;
    }
  }

  /**
   * Get user profile
   */
  async getProfile(userId: string): Promise<User> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      include: { organization: true },
    });

    if (!user) {
      throw new UnauthorizedException('User not found');
    }

    return user;
  }

  /**
   * Update user's last login timestamp
   */
  async updateLastLogin(userId: string): Promise<void> {
    await this.prisma.user.update({
      where: { id: userId },
      data: { updatedAt: new Date() },
    });
  }
}


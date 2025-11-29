import { Injectable, UnauthorizedException, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../prisma/prisma.service';
import { User, UserRole } from '@prisma/client';
import axios from 'axios';

/**
 * Authentication Service
 * Handles user validation and authentication logic
 */
@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);
  private readonly emailCache = new Map<string, { email: string; timestamp: number }>();
  private readonly CACHE_TTL = 5 * 60 * 1000; // 5 minutes

  constructor(
    private prisma: PrismaService,
    private configService: ConfigService,
  ) {}

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
            status: 'ACTIVE', // Set status to ACTIVE
          },
          include: { organization: true },
        });

        // Mark invitation as accepted
        await this.prisma.invitation.update({
          where: { id: invitation.id },
          data: { acceptedAt: new Date() },
        });

        this.logger.log(`User created from invitation: ${user.email} with role ${user.role} in org ${user.organizationId}`);
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
   * Fetch user email from Auth0 using the access token
   * This is used when the JWT doesn't include email claim
   * Implements caching to avoid rate limiting
   */
  async getUserEmailFromAuth0(accessToken: string): Promise<string | null> {
    try {
      // Check cache first
      const cached = this.emailCache.get(accessToken);
      if (cached && Date.now() - cached.timestamp < this.CACHE_TTL) {
        this.logger.log(`Using cached email for token`);
        return cached.email;
      }

      const auth0Domain = this.configService.get<string>('AUTH0_DOMAIN');
      const response = await axios.get(`https://${auth0Domain}/userinfo`, {
        headers: {
          Authorization: `Bearer ${accessToken}`,
        },
        timeout: 5000, // 5 second timeout
      });

      const email = response.data.email || null;
      
      // Cache the result
      if (email) {
        this.emailCache.set(accessToken, { email, timestamp: Date.now() });
        this.logger.log(`Fetched and cached user info from Auth0: ${email}`);
      }
      
      return email;
    } catch (error) {
      this.logger.error('Error fetching user info from Auth0:', error.message);
      
      // If rate limited, try to use expired cache as fallback
      const cached = this.emailCache.get(accessToken);
      if (cached && error.response?.status === 429) {
        this.logger.warn('Rate limited by Auth0, using expired cache');
        return cached.email;
      }
      
      return null;
    }
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


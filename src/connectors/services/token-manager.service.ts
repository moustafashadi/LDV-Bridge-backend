import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import {
  OAuth2Token,
  ConnectionStatus,
} from '../interfaces/base-connector.interface';
import * as crypto from 'crypto-js';
import { ConfigService } from '@nestjs/config';

/**
 * Service for managing OAuth tokens with encryption
 */
@Injectable()
export class TokenManagerService {
  private readonly logger = new Logger(TokenManagerService.name);
  private readonly encryptionKey: string;

  constructor(
    private prisma: PrismaService,
    private config: ConfigService,
  ) {
    // Get encryption key from environment or generate one
    this.encryptionKey =
      this.config.get<string>('TOKEN_ENCRYPTION_KEY') ||
      'default-encryption-key-change-in-production';

    if (this.encryptionKey === 'default-encryption-key-change-in-production') {
      this.logger.warn(
        'Using default encryption key. Set TOKEN_ENCRYPTION_KEY in production!',
      );
    }
  }

  /**
   * Encrypt sensitive token data
   */
  private encrypt(text: string): string {
    return crypto.AES.encrypt(text, this.encryptionKey).toString();
  }

  /**
   * Decrypt token data
   */
  private decrypt(encryptedText: string): string {
    const bytes = crypto.AES.decrypt(encryptedText, this.encryptionKey);
    return bytes.toString(crypto.enc.Utf8);
  }

  /**
   * Save OAuth2 token for a user connection
   */
  async saveToken(
    userId: string,
    organizationId: string,
    platform: string,
    token: OAuth2Token,
  ): Promise<void> {
    try {
      const encryptedAccessToken = this.encrypt(token.accessToken);
      const encryptedRefreshToken = token.refreshToken
        ? this.encrypt(token.refreshToken)
        : null;

      // Merge token metadata with organizationId
      const metadata = {
        organizationId,
        ...(token.metadata || {}), // Include any platform-specific metadata (e.g., Mendix PAT)
      };

      await this.prisma.userConnection.upsert({
        where: {
          userId_platform: {
            userId,
            platform: platform as any,
          },
        },
        create: {
          userId,
          platform: platform as any,
          accessToken: encryptedAccessToken,
          refreshToken: encryptedRefreshToken,
          expiresAt: token.expiresAt,
          isActive: true,
          metadata,
        },
        update: {
          accessToken: encryptedAccessToken,
          refreshToken: encryptedRefreshToken,
          expiresAt: token.expiresAt,
          isActive: true,
          metadata,
          updatedAt: new Date(),
        },
      });

      this.logger.log(`Token saved for user ${userId}, platform ${platform}`);
    } catch (error) {
      this.logger.error(`Failed to save token: ${error.message}`, error.stack);
      throw error;
    }
  }

  /**
   * Get OAuth2 token for a user connection
   */
  async getToken(
    userId: string,
    platform: string,
  ): Promise<OAuth2Token | null> {
    try {
      const connection = await this.prisma.userConnection.findUnique({
        where: {
          userId_platform: {
            userId,
            platform: platform as any,
          },
        },
      });

      // Return null if connection doesn't exist, has no access token, or is not active
      if (!connection || !connection.accessToken || !connection.isActive) {
        return null;
      }

      return {
        accessToken: this.decrypt(connection.accessToken),
        refreshToken: connection.refreshToken
          ? this.decrypt(connection.refreshToken)
          : undefined,
        expiresAt: connection.expiresAt || new Date(),
        tokenType: 'Bearer',
        metadata: connection.metadata as Record<string, any> | undefined, // Include platform-specific metadata
      };
    } catch (error) {
      this.logger.error(`Failed to get token: ${error.message}`, error.stack);
      return null;
    }
  }

  /**
   * Check if token is expired
   */
  async isTokenExpired(userId: string, platform: string): Promise<boolean> {
    const token = await this.getToken(userId, platform);

    if (!token) {
      return true;
    }

    const now = new Date();
    const expiresAt = new Date(token.expiresAt);

    // Consider token expired if it expires in less than 5 minutes
    const bufferTime = 5 * 60 * 1000; // 5 minutes in milliseconds
    return expiresAt.getTime() - now.getTime() < bufferTime;
  }

  /**
   * Update token expiration status
   */
  async updateConnectionStatus(
    userId: string,
    platform: string,
    status: ConnectionStatus,
    errorMessage?: string,
  ): Promise<void> {
    try {
      // Map ConnectionStatus enum to boolean isActive
      const isActive = status === ConnectionStatus.CONNECTED;

      await this.prisma.userConnection.update({
        where: {
          userId_platform: {
            userId,
            platform: platform as any,
          },
        },
        data: {
          isActive,
          metadata: errorMessage ? { error: errorMessage } : undefined,
          updatedAt: new Date(),
        },
      });

      this.logger.log(
        `Connection status updated: ${userId}/${platform} -> ${status}`,
      );
    } catch (error) {
      this.logger.error(
        `Failed to update connection status: ${error.message}`,
        error.stack,
      );
      throw error;
    }
  }

  /**
   * Delete token (disconnect)
   */
  async deleteToken(userId: string, platform: string): Promise<void> {
    try {
      await this.prisma.userConnection.delete({
        where: {
          userId_platform: {
            userId,
            platform: platform as any,
          },
        },
      });

      this.logger.log(`Token deleted for user ${userId}, platform ${platform}`);
    } catch (error) {
      this.logger.error(
        `Failed to delete token: ${error.message}`,
        error.stack,
      );
      throw error;
    }
  }

  /**
   * Get all connections for a user
   */
  async getUserConnections(userId: string) {
    return this.prisma.userConnection.findMany({
      where: {
        userId,
      },
      orderBy: {
        updatedAt: 'desc',
      },
    });
  }

  /**
   * Update last sync time
   */
  async updateLastSync(userId: string, platform: string): Promise<void> {
    try {
      await this.prisma.userConnection.update({
        where: {
          userId_platform: {
            userId,
            platform: platform as any,
          },
        },
        data: {
          updatedAt: new Date(),
        },
      });
    } catch (error) {
      this.logger.error(
        `Failed to update last sync: ${error.message}`,
        error.stack,
      );
    }
  }
}

import { Injectable, Logger, BadRequestException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios from 'axios';
import { OAuth2Token } from '../interfaces/base-connector.interface';

/**
 * OAuth2 configuration for a platform
 */
export interface OAuth2Config {
  authorizationUrl: string;
  tokenUrl: string;
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  scope: string;
}

/**
 * Service for handling OAuth2 flows
 */
@Injectable()
export class OAuthService {
  private readonly logger = new Logger(OAuthService.name);

  constructor(private config: ConfigService) {}

  /**
   * Generate OAuth2 authorization URL
   */
  generateAuthUrl(
    config: OAuth2Config,
    state: string,
    additionalParams?: Record<string, string>,
  ): string {
    const params = new URLSearchParams({
      client_id: config.clientId,
      redirect_uri: config.redirectUri,
      response_type: 'code',
      scope: config.scope,
      state,
      ...additionalParams,
    });

    const authUrl = `${config.authorizationUrl}?${params.toString()}`;
    this.logger.debug(`Generated auth URL for state: ${state}`);
    
    return authUrl;
  }

  /**
   * Exchange authorization code for access token
   */
  async exchangeCodeForToken(
    config: OAuth2Config,
    code: string,
    additionalParams?: Record<string, string>,
  ): Promise<OAuth2Token> {
    try {
      const tokenData = new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        redirect_uri: config.redirectUri,
        client_id: config.clientId,
        client_secret: config.clientSecret,
        ...additionalParams,
      });

      this.logger.debug(`Exchanging code for token at: ${config.tokenUrl}`);

      const response = await axios.post(config.tokenUrl, tokenData.toString(), {
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
        },
      });

      const { access_token, refresh_token, expires_in, token_type, scope } = response.data;

      if (!access_token) {
        throw new BadRequestException('No access token received from OAuth provider');
      }

      // Calculate expiration time
      const expiresAt = new Date();
      expiresAt.setSeconds(expiresAt.getSeconds() + (expires_in || 3600));

      this.logger.log(`Successfully exchanged code for token, expires at: ${expiresAt.toISOString()}`);

      return {
        accessToken: access_token,
        refreshToken: refresh_token,
        expiresAt,
        tokenType: token_type || 'Bearer',
        scope,
      };
    } catch (error) {
      this.logger.error(`Failed to exchange code for token: ${error.message}`, error.stack);
      
      if (axios.isAxiosError(error)) {
        const errorData = error.response?.data;
        throw new BadRequestException(
          `OAuth token exchange failed: ${errorData?.error_description || error.message}`,
        );
      }
      
      throw error;
    }
  }

  /**
   * Refresh an expired access token
   */
  async refreshAccessToken(
    config: OAuth2Config,
    refreshToken: string,
  ): Promise<OAuth2Token> {
    try {
      const tokenData = new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: refreshToken,
        client_id: config.clientId,
        client_secret: config.clientSecret,
      });

      this.logger.debug(`Refreshing access token at: ${config.tokenUrl}`);

      const response = await axios.post(config.tokenUrl, tokenData.toString(), {
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
        },
      });

      const { access_token, refresh_token, expires_in, token_type, scope } = response.data;

      if (!access_token) {
        throw new BadRequestException('No access token received during refresh');
      }

      const expiresAt = new Date();
      expiresAt.setSeconds(expiresAt.getSeconds() + (expires_in || 3600));

      this.logger.log(`Successfully refreshed token, expires at: ${expiresAt.toISOString()}`);

      return {
        accessToken: access_token,
        refreshToken: refresh_token || refreshToken, // Use new refresh token or keep old one
        expiresAt,
        tokenType: token_type || 'Bearer',
        scope,
      };
    } catch (error) {
      this.logger.error(`Failed to refresh token: ${error.message}`, error.stack);
      
      if (axios.isAxiosError(error)) {
        const errorData = error.response?.data;
        throw new BadRequestException(
          `Token refresh failed: ${errorData?.error_description || error.message}`,
        );
      }
      
      throw error;
    }
  }

  /**
   * Revoke an access token
   */
  async revokeToken(
    revokeUrl: string,
    token: string,
    config: OAuth2Config,
  ): Promise<void> {
    try {
      await axios.post(
        revokeUrl,
        new URLSearchParams({
          token,
          client_id: config.clientId,
          client_secret: config.clientSecret,
        }).toString(),
        {
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
          },
        },
      );

      this.logger.log('Successfully revoked token');
    } catch (error) {
      this.logger.error(`Failed to revoke token: ${error.message}`, error.stack);
      // Don't throw error - token revocation failure shouldn't block disconnection
    }
  }

  /**
   * Generate state parameter for OAuth flow
   * Format: base64(userId:organizationId:timestamp:random)
   */
  generateState(userId: string, organizationId: string): string {
    const timestamp = Date.now();
    const random = Math.random().toString(36).substring(2, 15);
    const stateData = `${userId}:${organizationId}:${timestamp}:${random}`;
    
    return Buffer.from(stateData).toString('base64');
  }

  /**
   * Parse and validate state parameter
   */
  parseState(state: string): { userId: string; organizationId: string; timestamp: number } {
    try {
      const decoded = Buffer.from(state, 'base64').toString('utf-8');
      const [userId, organizationId, timestamp] = decoded.split(':');

      // Validate state is not too old (15 minutes max)
      const now = Date.now();
      const stateAge = now - parseInt(timestamp);
      const maxAge = 15 * 60 * 1000; // 15 minutes

      if (stateAge > maxAge) {
        throw new BadRequestException('OAuth state has expired');
      }

      return {
        userId,
        organizationId,
        timestamp: parseInt(timestamp),
      };
    } catch (error) {
      this.logger.error(`Failed to parse state: ${error.message}`);
      throw new BadRequestException('Invalid OAuth state parameter');
    }
  }
}

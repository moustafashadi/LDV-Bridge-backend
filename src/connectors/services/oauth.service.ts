import { Injectable, Logger, BadRequestException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios from 'axios';
import * as crypto from 'crypto';
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
 * PKCE parameters for OAuth flow
 */
export interface PKCEParams {
  codeVerifier: string;
  codeChallenge: string;
  codeChallengeMethod: string;
}

/**
 * Service for handling OAuth2 flows
 */
@Injectable()
export class OAuthService {
  private readonly logger = new Logger(OAuthService.name);
  // Store PKCE code verifiers temporarily (keyed by state)
  private readonly pkceStore = new Map<string, string>();

  constructor(private config: ConfigService) {}

  /**
   * Generate PKCE parameters for OAuth2 flow
   */
  generatePKCE(): PKCEParams {
    // Generate code_verifier: random string of 43-128 characters
    const codeVerifier = crypto.randomBytes(32).toString('base64url');
    
    // Generate code_challenge: SHA256 hash of code_verifier, base64url encoded
    const codeChallenge = crypto
      .createHash('sha256')
      .update(codeVerifier)
      .digest('base64url');

    this.logger.debug('Generated PKCE parameters');

    return {
      codeVerifier,
      codeChallenge,
      codeChallengeMethod: 'S256',
    };
  }

  /**
   * Store PKCE code verifier for later use
   */
  storePKCEVerifier(state: string, codeVerifier: string): void {
    this.pkceStore.set(state, codeVerifier);
    
    // Clean up after 15 minutes (same as state expiry)
    setTimeout(() => {
      this.pkceStore.delete(state);
    }, 15 * 60 * 1000);
  }

  /**
   * Retrieve and remove PKCE code verifier
   */
  retrievePKCEVerifier(state: string): string | undefined {
    const verifier = this.pkceStore.get(state);
    if (verifier) {
      this.pkceStore.delete(state);
    }
    return verifier;
  }

  /**
   * Generate OAuth2 authorization URL
   */
  generateAuthUrl(
    config: OAuth2Config,
    state: string,
    additionalParams?: Record<string, string>,
    pkceParams?: { codeChallenge: string; codeChallengeMethod: string },
  ): string {
    const params: Record<string, string> = {
      client_id: config.clientId,
      redirect_uri: config.redirectUri,
      response_type: 'code',
      scope: config.scope,
      state,
      ...additionalParams,
    };

    // Add PKCE parameters if provided
    if (pkceParams) {
      params.code_challenge = pkceParams.codeChallenge;
      params.code_challenge_method = pkceParams.codeChallengeMethod;
      this.logger.debug('Including PKCE parameters in auth URL');
    }

    const urlParams = new URLSearchParams(params);
    const authUrl = `${config.authorizationUrl}?${urlParams.toString()}`;
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
    codeVerifier?: string,
  ): Promise<OAuth2Token> {
    try {
      const tokenParams: Record<string, string> = {
        grant_type: 'authorization_code',
        code,
        redirect_uri: config.redirectUri,
        client_id: config.clientId,
        client_secret: config.clientSecret,
        ...additionalParams,
      };

      // Add PKCE code_verifier if provided
      if (codeVerifier) {
        tokenParams.code_verifier = codeVerifier;
        this.logger.debug('Including PKCE code_verifier in token exchange');
      }

      const tokenData = new URLSearchParams(tokenParams);

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
   * Format: base64(userId:organizationId:role:timestamp:random)
   */
  generateState(userId: string, organizationId: string, userRole?: string): string {
    const timestamp = Date.now();
    const random = Math.random().toString(36).substring(2, 15);
    const role = userRole || 'ADMIN'; // Default to ADMIN for backward compatibility
    const stateData = `${userId}:${organizationId}:${role}:${timestamp}:${random}`;
    
    return Buffer.from(stateData).toString('base64');
  }

  /**
   * Parse and validate state parameter
   */
  parseState(state: string): { userId: string; organizationId: string; userRole: string; timestamp: number } {
    try {
      const decoded = Buffer.from(state, 'base64').toString('utf-8');
      const parts = decoded.split(':');
      
      // Handle both old format (4 parts) and new format (5 parts)
      const userId = parts[0];
      const organizationId = parts[1];
      let userRole = 'ADMIN';
      let timestamp: string;
      
      if (parts.length >= 5) {
        // New format: userId:organizationId:role:timestamp:random
        userRole = parts[2];
        timestamp = parts[3];
      } else {
        // Old format: userId:organizationId:timestamp:random
        timestamp = parts[2];
      }

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
        userRole,
        timestamp: parseInt(timestamp),
      };
    } catch (error) {
      this.logger.error(`Failed to parse state: ${error.message}`);
      throw new BadRequestException('Invalid OAuth state parameter');
    }
  }
}

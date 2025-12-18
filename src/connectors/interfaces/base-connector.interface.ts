/**
 * Platform types supported by LDV-Bridge
 */
export enum PlatformType {
  POWERAPPS = 'POWERAPPS',
  MENDIX = 'MENDIX',
}

/**
 * Connection status for platform connectors
 */
export enum ConnectionStatus {
  CONNECTED = 'CONNECTED',
  DISCONNECTED = 'DISCONNECTED',
  ERROR = 'ERROR',
  EXPIRED = 'EXPIRED',
}

/**
 * OAuth2 token data structure
 */
export interface OAuth2Token {
  accessToken: string;
  refreshToken?: string;
  expiresAt: Date;
  tokenType: string;
  scope?: string;
  metadata?: Record<string, any>; // Additional platform-specific data (e.g., Mendix PAT)
}

/**
 * Connection metadata
 */
export interface ConnectionMetadata {
  userId: string;
  organizationId: string;
  platformType: PlatformType;
  status: ConnectionStatus;
  lastSyncAt?: Date;
  errorMessage?: string;
}

/**
 * Base interface that all platform connectors must implement
 */
export interface IBaseConnector {
  /**
   * Initialize OAuth2 flow and return authorization URL
   */
  initiateOAuth(userId: string, organizationId: string): Promise<string>;

  /**
   * Complete OAuth2 flow with authorization code
   */
  completeOAuth(code: string, state: string): Promise<OAuth2Token>;

  /**
   * Refresh expired access token
   */
  refreshToken(refreshToken: string): Promise<OAuth2Token>;

  /**
   * Test connection to platform
   */
  testConnection(userId: string, organizationId: string): Promise<boolean>;

  /**
   * Disconnect and revoke tokens
   */
  disconnect(userId: string, organizationId: string): Promise<void>;

  /**
   * Get connection status
   */
  getConnectionStatus(
    userId: string,
    organizationId: string,
  ): Promise<ConnectionStatus>;
}

/**
 * Platform-specific app metadata
 */
export interface IPlatformApp {
  id: string;
  name: string;
  description?: string;
  createdAt: Date;
  modifiedAt: Date;
  version?: string;
  environment?: string;
  metadata?: Record<string, any>;
}

/**
 * Sync result from platform
 */
export interface ISyncResult {
  success: boolean;
  appId: string;
  componentsCount: number;
  changesDetected: number;
  syncedAt: Date;
  errors?: string[];
  githubRepoUrl?: string;
}

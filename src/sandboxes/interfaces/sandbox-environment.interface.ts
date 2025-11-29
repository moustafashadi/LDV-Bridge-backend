/**
 * Sandbox Environment Interfaces
 * Defines types for sandbox provisioning and management across PowerApps and Mendix platforms
 */

/**
 * Supported platforms for sandboxes
 */
export enum SandboxPlatform {
  POWERAPPS = 'POWERAPPS',
  MENDIX = 'MENDIX',
}

/**
 * Sandbox lifecycle status
 */
export enum SandboxStatus {
  PROVISIONING = 'PROVISIONING', // Initial state, waiting for environment creation
  ACTIVE = 'ACTIVE',             // Environment ready and accessible
  SUSPENDED = 'SUSPENDED',       // Temporarily disabled (quota exceeded, etc.)
  EXPIRED = 'EXPIRED',           // Past expiration date, awaiting cleanup
  FAILED = 'FAILED',             // Provisioning or operation failed
  DELETED = 'DELETED',           // Soft deleted, environment deprovisioned
}

/**
 * Sandbox types with different resource quotas and permissions
 */
export enum SandboxType {
  PERSONAL = 'PERSONAL',   // Individual developer sandbox (limited resources)
  TEAM = 'TEAM',           // Shared team sandbox (more resources)
  TRAINING = 'TRAINING',   // Training/learning environment (medium term)
  DEMO = 'DEMO',           // Demonstration environment (short term)
}

/**
 * Environment provisioning status (tracks async provisioning progress)
 */
export enum ProvisioningStatus {
  PENDING = 'PENDING',         // Queued, not started
  IN_PROGRESS = 'IN_PROGRESS', // Actively provisioning
  COMPLETED = 'COMPLETED',     // Successfully provisioned
  FAILED = 'FAILED',           // Provisioning failed
}

/**
 * Resource quotas by sandbox type
 * Enforced at creation and monitored during runtime
 */
export interface SandboxQuota {
  maxApps: number;       // Maximum number of apps allowed
  maxApiCalls: number;   // API calls per day limit
  maxStorage: number;    // Storage in MB
  maxUsers: number;      // Maximum concurrent/assigned users
  maxDuration: number;   // Days before automatic expiration
}

/**
 * Current resource usage metrics
 * Returned by provisioners to track consumption
 */
export interface SandboxResources {
  appsCount: number;         // Current number of apps deployed
  apiCallsUsed: number;      // API calls consumed today
  storageUsed: number;       // Storage used in MB
}

/**
 * Platform-agnostic environment details
 * Returned after successful provisioning
 */
export interface EnvironmentDetails {
  environmentId: string;              // Platform-specific environment identifier
  environmentUrl: string;             // Direct access URL for the environment
  region?: string;                    // Geographic region/datacenter
  metadata?: Record<string, any>;     // Platform-specific extra data
}

/**
 * PowerApps environment configuration
 * Used when provisioning PowerApps developer environments
 */
export interface PowerAppsEnvironmentConfig {
  userId: string;                     // User requesting the environment
  organizationId: string;             // Organization owning the environment
  displayName: string;                // Human-readable name
  environmentType: 'Developer' | 'Trial' | 'Production' | 'Sandbox';
  region: string;                     // Azure region (e.g., 'unitedstates')
  securityGroupId?: string;           // Optional Azure AD security group
  languageCode?: number;              // LCID language code (default: 1033 = English)
  currencyCode?: string;              // Currency code (default: 'USD')
}

/**
 * Mendix sandbox configuration
 * Used when provisioning Mendix free sandbox environments
 */
export interface MendixSandboxConfig {
  userId: string;                     // User requesting the sandbox
  organizationId: string;             // Organization owning the sandbox
  name: string;                       // Sandbox/app name
  template?: string;                  // Optional template app to clone from
  mode: 'sandbox' | 'free';           // Sandbox mode (free tier)
  mendixVersion?: string;             // Mendix runtime version (e.g., '10.0')
}

/**
 * Base interface for environment provisioners
 * Implemented by PowerAppsProvisioner and MendixProvisioner
 */
export interface IEnvironmentProvisioner {
  /**
   * Provision a new environment
   * @param config Platform-specific configuration object
   * @returns Environment details including ID and URL
   */
  provision(config: PowerAppsEnvironmentConfig | MendixSandboxConfig): Promise<EnvironmentDetails>;

  /**
   * Deprovision/delete an environment
   * @param userId User requesting the action
   * @param organizationId Organization context
   * @param environmentId Platform-specific environment ID to delete
   */
  deprovision(userId: string, organizationId: string, environmentId: string): Promise<void>;

  /**
   * Start a stopped environment (Mendix only, PowerApps throws error)
   * @param userId User requesting the action
   * @param organizationId Organization context
   * @param environmentId Environment to start
   */
  start(userId: string, organizationId: string, environmentId: string): Promise<void>;

  /**
   * Stop a running environment (Mendix only, PowerApps throws error)
   * @param userId User requesting the action
   * @param organizationId Organization context
   * @param environmentId Environment to stop
   */
  stop(userId: string, organizationId: string, environmentId: string): Promise<void>;

  /**
   * Get current provisioning/runtime status
   * @param userId User requesting the status
   * @param organizationId Organization context
   * @param environmentId Environment to check
   * @returns Current provisioning status
   */
  getStatus(userId: string, organizationId: string, environmentId: string): Promise<ProvisioningStatus>;

  /**
   * Get resource usage metrics
   * @param userId User requesting the metrics
   * @param organizationId Organization context
   * @param environmentId Environment to check
   * @returns Resource usage statistics
   */
  getResourceUsage(userId: string, organizationId: string, environmentId: string): Promise<SandboxResources>;

  /**
   * Reset environment data (delete all apps/data, keep environment)
   * @param userId User requesting the reset
   * @param organizationId Organization context
   * @param environmentId Environment to reset
   */
  reset(userId: string, organizationId: string, environmentId: string): Promise<void>;
}

/**
 * Default quotas by sandbox type
 * Used to enforce resource limits and calculate expiration dates
 */
export const SANDBOX_QUOTAS: Record<SandboxType, SandboxQuota> = {
  [SandboxType.PERSONAL]: {
    maxApps: 3,
    maxApiCalls: 1000,
    maxStorage: 100,      // 100 MB
    maxUsers: 1,
    maxDuration: 30,      // 30 days
  },
  [SandboxType.TEAM]: {
    maxApps: 10,
    maxApiCalls: 5000,
    maxStorage: 500,      // 500 MB
    maxUsers: 10,
    maxDuration: 90,      // 90 days
  },
  [SandboxType.TRAINING]: {
    maxApps: 5,
    maxApiCalls: 2000,
    maxStorage: 200,      // 200 MB
    maxUsers: 50,
    maxDuration: 60,      // 60 days
  },
  [SandboxType.DEMO]: {
    maxApps: 5,
    maxApiCalls: 500,
    maxStorage: 100,      // 100 MB
    maxUsers: 3,
    maxDuration: 7,       // 7 days
  },
};

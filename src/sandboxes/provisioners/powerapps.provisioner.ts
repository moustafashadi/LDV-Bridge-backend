import { Injectable, Logger, BadRequestException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import {
  IEnvironmentProvisioner,
  EnvironmentDetails,
  SandboxResources,
  PowerAppsEnvironmentConfig,
  MendixSandboxConfig,
  SandboxPlatform,
  ProvisioningStatus,
} from '../interfaces/sandbox-environment.interface';
import { PowerAppsService } from '../../connectors/powerapps/powerapps.service';

/**
 * PowerApps Environment Provisioner
 * 
 * Handles provisioning, deprovisioning, and management of PowerApps environments
 * for sandboxes. Implements retry logic and status polling.
 */
@Injectable()
export class PowerAppsProvisioner implements IEnvironmentProvisioner {
  private readonly logger = new Logger(PowerAppsProvisioner.name);
  private readonly MAX_PROVISION_WAIT_TIME = 10 * 60 * 1000; // 10 minutes
  private readonly POLL_INTERVAL = 30 * 1000; // 30 seconds

  constructor(
    private readonly powerAppsService: PowerAppsService,
    private readonly prisma: PrismaService,
  ) { }

  /**
   * Provision a new PowerApps environment
   * 
   * Creates a new environment and waits for it to become active.
   * PowerApps environments typically take 2-5 minutes to provision.
   */
  async provision(
    config: PowerAppsEnvironmentConfig | MendixSandboxConfig,
  ): Promise<EnvironmentDetails> {
    const powerAppsConfig = config as PowerAppsEnvironmentConfig;

    this.logger.log(
      `Provisioning PowerApps environment "${powerAppsConfig.displayName}" in ${powerAppsConfig.region}`,
    );

    try {
      // If cloning, look up the external PowerApps app ID
      let externalAppId: string | undefined;
      if (powerAppsConfig.sourceAppId) {
        this.logger.log(`Looking up external app ID for internal ID: ${powerAppsConfig.sourceAppId}`);
        
        const sourceApp = await this.prisma.app.findUnique({
          where: { id: powerAppsConfig.sourceAppId },
          select: { externalId: true, name: true },
        });

        if (!sourceApp) {
          throw new BadRequestException(
            `Source app with ID ${powerAppsConfig.sourceAppId} not found`,
          );
        }

        if (!sourceApp.externalId) {
          throw new BadRequestException(
            `Source app "${sourceApp.name}" does not have an external ID. Cannot clone.`,
          );
        }

        externalAppId = sourceApp.externalId;
        this.logger.log(`Found external app ID: ${externalAppId} for app "${sourceApp.name}"`);
      }

      // Step 1: Create environment
      const environment = await this.powerAppsService.createEnvironment(
        powerAppsConfig.userId,
        powerAppsConfig.organizationId,
        {
          name: powerAppsConfig.displayName,
          region: powerAppsConfig.region,
          type: powerAppsConfig.environmentType || 'Sandbox',
          sourceAppId: externalAppId, // Pass external PowerApps app ID for cloning
        },
      );

      const environmentId = environment.environmentId;

      this.logger.log(`PowerApps environment created: ${environmentId}`);

      // Step 2: Wait for environment to become active
      await this.waitForProvisioning(
        environmentId,
        powerAppsConfig.userId,
        powerAppsConfig.organizationId,
      );

      // Step 3: Get environment URL (use the one returned from creation)
      const environmentUrl = environment.environmentUrl;

      this.logger.log(
        `PowerApps environment ${environmentId} is ready: ${environmentUrl}`,
      );

      return {
        environmentId,
        environmentUrl,
        region: powerAppsConfig.region,
        appId: environment.appId, // Return cloned app ID if cloning occurred
        isCloned: environment.isCloned, // Return whether this was a clone
        metadata: {
          sku: powerAppsConfig.environmentType || 'Sandbox',
          currency: powerAppsConfig.currencyCode || 'USD',
          language: powerAppsConfig.languageCode || 1033,
          provisionedAt: new Date().toISOString(),
          status: environment.status,
        },
      };
    } catch (error) {
      this.logger.error(
        `Failed to provision PowerApps environment: ${error.message}`,
        error.stack,
      );
      throw new BadRequestException(
        `PowerApps provisioning failed: ${error.message}`,
      );
    }
  }

  /**
   * Deprovision (delete) a PowerApps environment
   * 
   * Permanently deletes the environment and all its resources.
   * This operation cannot be undone.
   */
  async deprovision(
    environmentId: string,
    userId: string,
    organizationId: string,
  ): Promise<void> {
    this.logger.log(`Deprovisioning PowerApps environment ${environmentId}`);

    try {
      // PowerApps environments are soft-deleted initially
      await this.powerAppsService.deleteEnvironment(
        environmentId,
        userId,
        organizationId,
      );

      this.logger.log(
        `PowerApps environment ${environmentId} deleted successfully`,
      );
    } catch (error) {
      this.logger.error(
        `Failed to deprovision PowerApps environment ${environmentId}: ${error.message}`,
      );
      // Don't throw - environment might already be deleted
      if (!error.message.includes('not found') && !error.message.includes('404')) {
        throw error;
      }
    }
  }

  /**
   * Start environment (Not supported for PowerApps)
   * 
   * PowerApps environments are always running and cannot be stopped/started.
   */
  async start(
    environmentId: string,
    userId: string,
    organizationId: string,
  ): Promise<void> {
    throw new BadRequestException(
      'PowerApps environments are always active and cannot be manually started',
    );
  }

  /**
   * Stop environment (Not supported for PowerApps)
   * 
   * PowerApps environments are always running and cannot be stopped/started.
   */
  async stop(
    environmentId: string,
    userId: string,
    organizationId: string,
  ): Promise<void> {
    throw new BadRequestException(
      'PowerApps environments cannot be stopped. Consider deleting the sandbox instead.',
    );
  }

  /**
   * Get environment provisioning status
   * 
   * Returns the current state of the environment.
   * Possible states: NotStarted, Running, Succeeded, Failed
   */
  async getStatus(
    userId: string,
    organizationId: string,
    environmentId: string,
  ): Promise<ProvisioningStatus> {
    try {
      const status = await this.powerAppsService.getEnvironmentStatus(
        userId,
        organizationId,
        environmentId,
      );

      // Map PowerApps states to our provisioning statuses
      const stateMapping: Record<string, ProvisioningStatus> = {
        Provisioning: ProvisioningStatus.IN_PROGRESS,
        Succeeded: ProvisioningStatus.COMPLETED,
        Failed: ProvisioningStatus.FAILED,
        Deleting: ProvisioningStatus.FAILED, // Treat deleting as failed
      };

      return stateMapping[status] || ProvisioningStatus.IN_PROGRESS;
    } catch (error) {
      this.logger.error(
        `Failed to get status for environment ${environmentId}: ${error.message}`,
      );
      return ProvisioningStatus.FAILED;
    }
  }

  /**
   * Get resource usage statistics
   * 
   * Returns current app count, API calls, and storage usage
   */
  async getResourceUsage(
    environmentId: string,
    userId: string,
    organizationId: string,
  ): Promise<SandboxResources> {
    try {
      const usage = await this.powerAppsService.getEnvironmentResourceUsage(
        environmentId,
        userId,
        organizationId,
      );

      return {
        appsCount: usage.appsCount,
        apiCallsUsed: usage.apiCallsUsed,
        storageUsed: usage.storageUsed,
      };
    } catch (error) {
      this.logger.error(
        `Failed to get resource usage for ${environmentId}: ${error.message}`,
      );

      // Return zeros if we can't get usage data
      return {
        appsCount: 0,
        apiCallsUsed: 0,
        storageUsed: 0,
      };
    }
  }

  /**
   * Reset environment (clear all apps and data)
   * 
   * Deletes all apps in the environment to provide a clean slate.
   * Does not delete the environment itself.
   */
  async reset(
    environmentId: string,
    userId: string,
    organizationId: string,
  ): Promise<void> {
    this.logger.log(`Resetting PowerApps environment ${environmentId}`);

    try {
      // Get all apps in the environment
      const apps = await this.powerAppsService.getAppsInEnvironment(
        environmentId,
        userId,
        organizationId,
      );

      this.logger.log(`Found ${apps.length} apps to delete in environment ${environmentId}`);

      // Delete each app
      const deletePromises = apps.map((app) =>
        this.powerAppsService
          .deleteApp(app.name, userId, organizationId)
          .catch((error) => {
            this.logger.warn(
              `Failed to delete app ${app.name}: ${error.message}`,
            );
            // Continue with other deletions
          }),
      );

      await Promise.all(deletePromises);

      this.logger.log(
        `Successfully reset PowerApps environment ${environmentId}`,
      );
    } catch (error) {
      this.logger.error(
        `Failed to reset environment ${environmentId}: ${error.message}`,
      );
      throw new BadRequestException(
        `Failed to reset PowerApps environment: ${error.message}`,
      );
    }
  }

  /**
   * Wait for environment provisioning to complete
   * 
   * Polls the environment status until it's ready or times out.
   */
  private async waitForProvisioning(
    environmentId: string,
    userId: string,
    organizationId: string,
  ): Promise<void> {
    const startTime = Date.now();
    let attempts = 0;
    const maxAttempts = this.MAX_PROVISION_WAIT_TIME / this.POLL_INTERVAL;

    this.logger.log(
      `Waiting for PowerApps environment ${environmentId} to become ready...`,
    );

    while (attempts < maxAttempts) {
      const elapsedTime = Date.now() - startTime;

      if (elapsedTime > this.MAX_PROVISION_WAIT_TIME) {
        throw new Error(
          `Environment provisioning timed out after ${this.MAX_PROVISION_WAIT_TIME / 1000} seconds`,
        );
      }

      try {
        const status = await this.getStatus(environmentId, userId, organizationId);

        this.logger.debug(
          `Environment ${environmentId} status: ${status} (attempt ${attempts + 1}/${maxAttempts})`,
        );

        if (status === ProvisioningStatus.COMPLETED) {
          this.logger.log(
            `Environment ${environmentId} is ready after ${elapsedTime / 1000} seconds`,
          );
          return;
        }

        if (status === ProvisioningStatus.FAILED) {
          throw new Error('Environment provisioning failed');
        }

        // Wait before next poll
        await new Promise((resolve) => setTimeout(resolve, this.POLL_INTERVAL));
        attempts++;
      } catch (error) {
        // Re-throw provisioning failures
        if (error.message === 'Environment provisioning failed') {
          throw error;
        }

        // If we can't get status, continue polling
        this.logger.warn(
          `Failed to get status on attempt ${attempts + 1}: ${error.message}`,
        );
        await new Promise((resolve) => setTimeout(resolve, this.POLL_INTERVAL));
        attempts++;
      }
    }

    throw new Error(
      `Environment provisioning did not complete within ${this.MAX_PROVISION_WAIT_TIME / 1000} seconds`,
    );
  }

  /**
   * Build environment URL for accessing PowerApps maker portal
   */
  private buildEnvironmentUrl(environmentId: string, region: string): string {
    // PowerApps maker portal URL format
    const regionPrefix = region.toLowerCase().replace(/\s+/g, '');

    // Most regions use the standard format
    if (region === 'unitedstates' || region === 'preview') {
      return `https://make.powerapps.com/environments/${environmentId}`;
    }

    // Regional URLs
    return `https://make.${regionPrefix}.powerapps.com/environments/${environmentId}`;
  }
}

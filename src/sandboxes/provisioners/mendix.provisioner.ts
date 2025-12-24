import { Injectable, Logger, BadRequestException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../../prisma/prisma.service';
import { MendixService } from '../../connectors/mendix/mendix.service';
import {
  IEnvironmentProvisioner,
  EnvironmentDetails,
  MendixSandboxConfig,
  ProvisioningStatus,
  SandboxResources,
} from '../interfaces/sandbox-environment.interface';

/**
 * Mendix Sandbox Provisioner
 * Handles creation and management of Mendix free sandbox environments
 *
 * @deprecated For creating new Mendix apps, use POST /api/v1/apps/mendix/create endpoint
 * which properly separates app creation from sandbox provisioning.
 * This provisioner creates both a new Mendix app AND a sandbox, which is the old behavior.
 * Going forward, apps should be created first via MendixService.createMendixApp(),
 * and sandboxes should only be created for existing apps.
 */
@Injectable()
export class MendixProvisioner implements IEnvironmentProvisioner {
  private readonly logger = new Logger(MendixProvisioner.name);

  constructor(
    private readonly mendixService: MendixService,
    private readonly configService: ConfigService,
    private readonly prisma: PrismaService,
  ) {}

  /**
   * Provision a new Mendix sandbox environment
   *
   * @deprecated This method creates a new Mendix app if no sourceAppId is provided.
   * For new app creation, use POST /api/v1/apps/mendix/create instead.
   * Use this method only when you need to create a sandbox for an EXISTING Mendix app.
   */
  async provision(config: MendixSandboxConfig): Promise<EnvironmentDetails> {
    // Log deprecation warning when creating new apps (not cloning)
    if (!config.sourceAppId) {
      this.logger.warn(
        `[DEPRECATED] Creating new Mendix app via sandbox provisioning. ` +
          `This flow is deprecated. Use POST /api/v1/apps/mendix/create instead.`,
      );
    }

    this.logger.log(`Provisioning Mendix sandbox: ${config.name}`);

    try {
      // If cloning, look up the external Mendix app ID
      let externalAppId: string | undefined;
      if (config.sourceAppId) {
        this.logger.log(
          `Looking up external app ID for internal ID: ${config.sourceAppId}`,
        );

        const sourceApp = await this.prisma.app.findUnique({
          where: { id: config.sourceAppId },
          select: { externalId: true, name: true },
        });

        if (!sourceApp) {
          throw new BadRequestException(
            `Source app with ID ${config.sourceAppId} not found`,
          );
        }

        if (!sourceApp.externalId) {
          throw new BadRequestException(
            `Source app "${sourceApp.name}" does not have an external ID. Cannot clone.`,
          );
        }

        externalAppId = sourceApp.externalId;
        this.logger.log(
          `Found external app ID: ${externalAppId} for app "${sourceApp.name}"`,
        );
      }

      // Create sandbox via Mendix Cloud Portal API
      const sandbox = await this.mendixService.createSandbox(
        config.userId,
        config.organizationId,
        {
          name: config.name,
          template: config.template,
          mendixVersion: config.mendixVersion,
          sourceAppId: externalAppId, // Pass external Mendix app ID for cloning
        },
      );

      return {
        environmentId: sandbox.environmentId,
        environmentUrl: sandbox.environmentUrl,
        region: 'free-tier', // Mendix free sandboxes don't specify region
        appId: sandbox.appId, // Return external app ID
        isCloned: sandbox.isCloned, // Return whether this was a clone
        metadata: {
          mode: config.mode,
          mendixVersion: config.mendixVersion,
          status: sandbox.status,
        },
      };
    } catch (error) {
      this.logger.error(`Failed to provision Mendix sandbox: ${error.message}`);
      throw new BadRequestException(
        `Failed to provision Mendix sandbox: ${error.message}`,
      );
    }
  }

  /**
   * Deprovision/delete a Mendix sandbox
   */
  async deprovision(
    userId: string,
    organizationId: string,
    environmentId: string,
  ): Promise<void> {
    this.logger.log(`Deprovisioning Mendix sandbox: ${environmentId}`);

    try {
      await this.mendixService.deleteSandbox(
        userId,
        organizationId,
        environmentId,
      );
      this.logger.log(`Successfully deprovisioned sandbox: ${environmentId}`);
    } catch (error) {
      this.logger.error(
        `Failed to deprovision sandbox ${environmentId}: ${error.message}`,
      );
      throw new BadRequestException(
        `Failed to deprovision sandbox: ${error.message}`,
      );
    }
  }

  /**
   * Start a stopped Mendix environment
   */
  async start(
    userId: string,
    organizationId: string,
    environmentId: string,
  ): Promise<void> {
    this.logger.log(`Starting Mendix environment: ${environmentId}`);

    try {
      await this.mendixService.startEnvironment(
        userId,
        organizationId,
        environmentId,
      );
      this.logger.log(`Successfully started environment: ${environmentId}`);
    } catch (error) {
      this.logger.error(
        `Failed to start environment ${environmentId}: ${error.message}`,
      );
      throw new BadRequestException(
        `Failed to start environment: ${error.message}`,
      );
    }
  }

  /**
   * Stop a running Mendix environment
   */
  async stop(
    userId: string,
    organizationId: string,
    environmentId: string,
  ): Promise<void> {
    this.logger.log(`Stopping Mendix environment: ${environmentId}`);

    try {
      await this.mendixService.stopEnvironment(
        userId,
        organizationId,
        environmentId,
      );
      this.logger.log(`Successfully stopped environment: ${environmentId}`);
    } catch (error) {
      this.logger.error(
        `Failed to stop environment ${environmentId}: ${error.message}`,
      );
      throw new BadRequestException(
        `Failed to stop environment: ${error.message}`,
      );
    }
  }

  /**
   * Get environment provisioning status
   */
  async getStatus(
    userId: string,
    organizationId: string,
    environmentId: string,
  ): Promise<ProvisioningStatus> {
    try {
      const status = await this.mendixService.getEnvironmentStatus(
        userId,
        organizationId,
        environmentId,
      );

      switch (status?.toLowerCase()) {
        case 'running':
          return ProvisioningStatus.COMPLETED;
        case 'starting':
        case 'provisioning':
          return ProvisioningStatus.IN_PROGRESS;
        case 'stopped':
        case 'stopping':
          return ProvisioningStatus.COMPLETED; // Stopped is a valid completed state
        case 'failed':
          return ProvisioningStatus.FAILED;
        default:
          return ProvisioningStatus.PENDING;
      }
    } catch (error) {
      this.logger.error(
        `Failed to get status for environment ${environmentId}: ${error.message}`,
      );
      return ProvisioningStatus.FAILED;
    }
  }

  /**
   * Get resource usage for Mendix environment
   */
  async getResourceUsage(
    userId: string,
    organizationId: string,
    environmentId: string,
  ): Promise<SandboxResources> {
    try {
      // Get resource usage from service
      const usage = await this.mendixService.getEnvironmentResourceUsage(
        userId,
        organizationId,
        environmentId,
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
      return {
        appsCount: 0,
        apiCallsUsed: 0,
        storageUsed: 0,
      };
    }
  }

  /**
   * Reset environment data (clean database, restore from template)
   */
  async reset(
    userId: string,
    organizationId: string,
    environmentId: string,
  ): Promise<void> {
    this.logger.log(`Resetting Mendix environment: ${environmentId}`);

    try {
      // Stop environment
      await this.stop(userId, organizationId, environmentId);

      // Clear database
      await this.mendixService.clearEnvironmentData(
        userId,
        organizationId,
        environmentId,
      );

      // Restart environment
      await this.start(userId, organizationId, environmentId);

      this.logger.log(`Successfully reset environment: ${environmentId}`);
    } catch (error) {
      this.logger.error(
        `Failed to reset environment ${environmentId}: ${error.message}`,
      );
      throw new BadRequestException(
        `Failed to reset environment: ${error.message}`,
      );
    }
  }
}

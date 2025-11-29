import { Test, TestingModule } from '@nestjs/testing';
import { BadRequestException } from '@nestjs/common';
import { PowerAppsProvisioner } from './powerapps.provisioner';
import { PowerAppsService } from '../../connectors/powerapps/powerapps.service';
import { ProvisioningStatus } from '../interfaces/sandbox-environment.interface';

describe('PowerAppsProvisioner', () => {
  let provisioner: PowerAppsProvisioner;
  let powerAppsService: PowerAppsService;

  const mockPowerAppsService = {
    createEnvironment: jest.fn(),
    deleteEnvironment: jest.fn(),
    getEnvironment: jest.fn(),
    getEnvironmentStatus: jest.fn(),
    getAppsInEnvironment: jest.fn(),
    deleteApp: jest.fn(),
    getEnvironmentResourceUsage: jest.fn(),
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        PowerAppsProvisioner,
        {
          provide: PowerAppsService,
          useValue: mockPowerAppsService,
        },
      ],
    }).compile();

    provisioner = module.get<PowerAppsProvisioner>(PowerAppsProvisioner);
    powerAppsService = module.get<PowerAppsService>(PowerAppsService);

    jest.clearAllMocks();
  });

  it('should be defined', () => {
    expect(provisioner).toBeDefined();
  });

  describe('provision', () => {
    const config = {
      userId: 'user-123',
      organizationId: 'org-123',
      displayName: 'Test Sandbox',
      environmentType: 'Developer' as const,
      region: 'unitedstates',
      languageCode: 1033,
      currencyCode: 'USD',
    };

    it('should provision a PowerApps environment successfully', async () => {
      const mockEnvironment = {
        environmentId: 'env-123',
        environmentUrl: 'https://admin.powerplatform.microsoft.com/environments/env-123',
        status: 'Succeeded',
      };

      mockPowerAppsService.createEnvironment.mockResolvedValue(mockEnvironment);
      mockPowerAppsService.getEnvironmentStatus.mockResolvedValue('Succeeded');

      const result = await provisioner.provision(config);

      expect(result).toEqual({
        environmentId: 'env-123',
        environmentUrl: 'https://admin.powerplatform.microsoft.com/environments/env-123',
        region: 'unitedstates',
        metadata: expect.objectContaining({
          sku: 'Developer',
          currency: 'USD',
          language: 1033,
          provisionedAt: expect.any(String),
          status: 'Succeeded',
        }),
      });

      expect(mockPowerAppsService.createEnvironment).toHaveBeenCalledWith(
        'user-123',
        'org-123',
        {
          name: 'Test Sandbox',
          region: 'unitedstates',
          type: 'Developer',
        },
      );
    });

    it('should handle provisioning in progress state', async () => {
      const mockEnvironment = {
        environmentId: 'env-123',
        environmentUrl: 'https://admin.powerplatform.microsoft.com/environments/env-123',
        status: 'Provisioning',
      };

      // Reduce the wait time for testing
      const originalMaxWaitTime = (provisioner as any).MAX_PROVISION_WAIT_TIME;
      const originalPollInterval = (provisioner as any).POLL_INTERVAL;
      (provisioner as any).MAX_PROVISION_WAIT_TIME = 5000; // 5 seconds max
      (provisioner as any).POLL_INTERVAL = 100; // 100ms interval

      mockPowerAppsService.createEnvironment.mockResolvedValue(mockEnvironment);
      // Mock the status to change from Provisioning to Succeeded quickly
      mockPowerAppsService.getEnvironmentStatus
        .mockResolvedValueOnce('Provisioning')
        .mockResolvedValueOnce('Succeeded');

      const result = await provisioner.provision(config);

      expect(result.environmentId).toBe('env-123');
      expect(mockPowerAppsService.createEnvironment).toHaveBeenCalled();

      // Restore original values
      (provisioner as any).MAX_PROVISION_WAIT_TIME = originalMaxWaitTime;
      (provisioner as any).POLL_INTERVAL = originalPollInterval;
    }, 15000);

    it('should handle provisioning failures', async () => {
      mockPowerAppsService.createEnvironment.mockRejectedValue(
        new Error('API Error: Quota exceeded'),
      );

      await expect(provisioner.provision(config)).rejects.toThrow(
        BadRequestException,
      );
    });

    it('should map environment types correctly', async () => {
      const sandboxConfig = {
        ...config,
        environmentType: 'Sandbox' as const,
      };
      const mockEnvironment = {
        environmentId: 'env-123',
        environmentUrl: 'https://test.com',
        status: 'Succeeded',
      };

      mockPowerAppsService.createEnvironment.mockResolvedValue(mockEnvironment);
      mockPowerAppsService.getEnvironmentStatus.mockResolvedValue('Succeeded');

      await provisioner.provision(sandboxConfig);

      expect(mockPowerAppsService.createEnvironment).toHaveBeenCalledWith(
        'user-123',
        'org-123',
        expect.objectContaining({
          type: 'Sandbox',
        }),
      );
    });
  });

  describe('deprovision', () => {
    it('should deprovision environment successfully', async () => {
      mockPowerAppsService.deleteEnvironment.mockResolvedValue(undefined);

      await provisioner.deprovision('user-123', 'org-123', 'env-123');

      expect(mockPowerAppsService.deleteEnvironment).toHaveBeenCalledWith(
        'user-123',
        'org-123',
        'env-123',
      );
    });

    it('should handle deprovision errors', async () => {
      // Should NOT throw if environment is not found (it's already deleted)
      mockPowerAppsService.deleteEnvironment.mockRejectedValue(
        new Error('Environment not found'),
      );

      await expect(
        provisioner.deprovision('env-123', 'user-123', 'org-123'),
      ).resolves.not.toThrow();
    });
  });

  describe('start', () => {
    it('should throw error as PowerApps does not support start', async () => {
      await expect(provisioner.start('user-123', 'org-123', 'env-123')).rejects.toThrow(
        BadRequestException,
      );
    });
  });

  describe('stop', () => {
    it('should throw error as PowerApps does not support stop', async () => {
      await expect(provisioner.stop('user-123', 'org-123', 'env-123')).rejects.toThrow(
        BadRequestException,
      );
    });
  });

  describe('getStatus', () => {
    it('should return environment status', async () => {
      mockPowerAppsService.getEnvironmentStatus.mockResolvedValue('Succeeded');

      const result = await provisioner.getStatus('user-123', 'org-123', 'env-123');

      expect(result).toBe(ProvisioningStatus.COMPLETED);
      expect(mockPowerAppsService.getEnvironmentStatus).toHaveBeenCalledWith(
        'user-123',
        'org-123',
        'env-123',
      );
    });

    it('should map provisioning status', async () => {
      mockPowerAppsService.getEnvironmentStatus.mockResolvedValue('Provisioning');

      const result = await provisioner.getStatus('user-123', 'org-123', 'env-123');

      expect(result).toBe(ProvisioningStatus.IN_PROGRESS);
    });

    it('should map failed status', async () => {
      mockPowerAppsService.getEnvironmentStatus.mockResolvedValue('Failed');

      const result = await provisioner.getStatus('user-123', 'org-123', 'env-123');

      expect(result).toBe(ProvisioningStatus.FAILED);
    });

    it('should handle errors', async () => {
      // getStatus catches errors and returns FAILED instead of throwing
      mockPowerAppsService.getEnvironmentStatus.mockRejectedValue(
        new Error('Environment not found'),
      );

      const result = await provisioner.getStatus('user-123', 'org-123', 'env-123');
      expect(result).toBe(ProvisioningStatus.FAILED);
    });
  });

  describe('getResourceUsage', () => {
    it('should return resource usage statistics', async () => {
      const mockUsage = {
        appsCount: 2,
        apiCallsUsed: 500,
        storageUsed: 50,
      };

      mockPowerAppsService.getEnvironmentResourceUsage.mockResolvedValue(mockUsage);

      const result = await provisioner.getResourceUsage('user-123', 'org-123', 'env-123');

      expect(result).toEqual(mockUsage);
      expect(mockPowerAppsService.getEnvironmentResourceUsage).toHaveBeenCalledWith(
        'user-123',
        'org-123',
        'env-123',
      );
    });

    it('should handle errors gracefully', async () => {
      // getResourceUsage catches errors and returns zeros instead of throwing
      mockPowerAppsService.getEnvironmentResourceUsage.mockRejectedValue(
        new Error('API Error'),
      );

      const result = await provisioner.getResourceUsage('env-123', 'user-123', 'org-123');
      expect(result).toEqual({
        appsCount: 0,
        apiCallsUsed: 0,
        storageUsed: 0,
      });
    });
  });

  describe('reset', () => {
    it('should reset environment by deleting all apps', async () => {
      const mockApps = [
        { id: 'app-1', name: 'App 1' },
        { id: 'app-2', name: 'App 2' },
      ];

      mockPowerAppsService.getAppsInEnvironment.mockResolvedValue(mockApps);
      mockPowerAppsService.deleteApp.mockResolvedValue(undefined);

      await provisioner.reset('env-123', 'user-123', 'org-123');

      expect(mockPowerAppsService.getAppsInEnvironment).toHaveBeenCalledWith(
        'env-123',
        'user-123',
        'org-123',
      );
      expect(mockPowerAppsService.deleteApp).toHaveBeenCalledTimes(2);
      // The implementation uses app.name, not app.id
      expect(mockPowerAppsService.deleteApp).toHaveBeenCalledWith('App 1', 'user-123', 'org-123');
      expect(mockPowerAppsService.deleteApp).toHaveBeenCalledWith('App 2', 'user-123', 'org-123');
    });

    it('should handle empty environment', async () => {
      mockPowerAppsService.getAppsInEnvironment.mockResolvedValue([]);

      await provisioner.reset('env-123', 'user-123', 'org-123');

      expect(mockPowerAppsService.deleteApp).not.toHaveBeenCalled();
    });

    it('should continue on delete failures and not throw', async () => {
      const mockApps = [
        { id: 'app-1', name: 'App 1' },
        { id: 'app-2', name: 'App 2' },
      ];

      mockPowerAppsService.getAppsInEnvironment.mockResolvedValue(mockApps);
      mockPowerAppsService.deleteApp
        .mockRejectedValueOnce(new Error('Delete failed'))
        .mockResolvedValueOnce(undefined);

      // Should not throw - individual delete failures are caught
      await expect(provisioner.reset('env-123', 'user-123', 'org-123')).resolves.not.toThrow();

      expect(mockPowerAppsService.deleteApp).toHaveBeenCalledTimes(2);
    });
  });

  describe('waitForProvisioning', () => {
    it('should wait until provisioning completes', async () => {
      // Reduce the wait time for testing
      const originalMaxWaitTime = (provisioner as any).MAX_PROVISION_WAIT_TIME;
      const originalPollInterval = (provisioner as any).POLL_INTERVAL;
      (provisioner as any).MAX_PROVISION_WAIT_TIME = 5000; // 5 seconds max
      (provisioner as any).POLL_INTERVAL = 100; // 100ms interval

      mockPowerAppsService.getEnvironmentStatus
        .mockResolvedValueOnce('Provisioning')
        .mockResolvedValueOnce('Provisioning')
        .mockResolvedValueOnce('Succeeded');

      await (provisioner as any).waitForProvisioning('env-123', 'user-123', 'org-123');

      expect(mockPowerAppsService.getEnvironmentStatus).toHaveBeenCalled();

      // Restore original values
      (provisioner as any).MAX_PROVISION_WAIT_TIME = originalMaxWaitTime;
      (provisioner as any).POLL_INTERVAL = originalPollInterval;
    }, 10000);

    it('should timeout after max attempts', async () => {
      // Mock to always return Provisioning status
      mockPowerAppsService.getEnvironmentStatus.mockResolvedValue('Provisioning');

      // Temporarily reduce the timeout for faster test
      const originalMaxWaitTime = (provisioner as any).MAX_PROVISION_WAIT_TIME;
      const originalPollInterval = (provisioner as any).POLL_INTERVAL;
      
      (provisioner as any).MAX_PROVISION_WAIT_TIME = 200; // 200ms timeout
      (provisioner as any).POLL_INTERVAL = 50; // 50ms interval

      await expect(
        (provisioner as any).waitForProvisioning('env-123', 'user-123', 'org-123')
      ).rejects.toThrow();

      // Restore original values
      (provisioner as any).MAX_PROVISION_WAIT_TIME = originalMaxWaitTime;
      (provisioner as any).POLL_INTERVAL = originalPollInterval;
    }, 5000);

    it('should detect provisioning failure', async () => {
      // Reduce the wait time for testing
      const originalMaxWaitTime = (provisioner as any).MAX_PROVISION_WAIT_TIME;
      const originalPollInterval = (provisioner as any).POLL_INTERVAL;
      (provisioner as any).MAX_PROVISION_WAIT_TIME = 5000; // 5 seconds max
      (provisioner as any).POLL_INTERVAL = 100; // 100ms interval

      mockPowerAppsService.getEnvironmentStatus
        .mockResolvedValueOnce('Provisioning')
        .mockResolvedValueOnce('Failed');

      await expect(
        (provisioner as any).waitForProvisioning('env-123', 'user-123', 'org-123')
      ).rejects.toThrow('Environment provisioning failed');

      // Restore original values
      (provisioner as any).MAX_PROVISION_WAIT_TIME = originalMaxWaitTime;
      (provisioner as any).POLL_INTERVAL = originalPollInterval;
    }, 10000);
  });
});

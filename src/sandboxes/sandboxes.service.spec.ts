import { Test, TestingModule } from '@nestjs/testing';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { SandboxesService } from './sandboxes.service';
import { PrismaService } from '../prisma/prisma.service';
import { NotificationsService } from '../notifications/notifications.service';
import { AuditService } from '../common/audit/audit.service';
import { PowerAppsProvisioner } from './provisioners/powerapps.provisioner';
import { MendixProvisioner } from './provisioners/mendix.provisioner';
import { CreateSandboxDto } from './dto/create-sandbox.dto';
import { UpdateSandboxDto } from './dto/update-sandbox.dto';
import {
  SandboxPlatform,
  SandboxStatus,
  SandboxType,
  ProvisioningStatus,
} from './interfaces/sandbox-environment.interface';

describe('SandboxesService', () => {
  let service: SandboxesService;
  let prismaService: PrismaService;
  let notificationsService: NotificationsService;
  let auditService: AuditService;
  let powerAppsProvisioner: PowerAppsProvisioner;
  let mendixProvisioner: MendixProvisioner;

  const mockUser = {
    id: 'user-123',
    email: 'test@example.com',
    organizationId: 'org-123',
  };

  const mockSandbox = {
    id: 'sandbox-123',
    organizationId: 'org-123',
    createdById: 'user-123',
    name: 'Test Sandbox',
    description: 'Test sandbox description',
    status: SandboxStatus.PROVISIONING,
    environment: {
      platform: SandboxPlatform.POWERAPPS,
      type: SandboxType.PERSONAL,
      provisioningStatus: ProvisioningStatus.IN_PROGRESS,
      environmentId: null,
      environmentUrl: null,
      region: 'unitedstates',
      metadata: {},
    },
    expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
    createdAt: new Date(),
    updatedAt: new Date(),
    organization: {
      id: 'org-123',
      name: 'Test Org',
    },
    createdBy: mockUser,
  };

  const mockPrismaService = {
    sandbox: {
      create: jest.fn(),
      findMany: jest.fn(),
      findUnique: jest.fn(),
      findFirst: jest.fn(),
      update: jest.fn(),
      delete: jest.fn(),
      count: jest.fn(),
    },
    user: {
      findUnique: jest.fn(),
    },
    organization: {
      findUnique: jest.fn(),
    },
  };

  const mockNotificationsService = {
    sendNotification: jest.fn(),
  };

  const mockAuditService = {
    createAuditLog: jest.fn(),
  };

  const mockPowerAppsProvisioner = {
    provision: jest.fn(),
    deprovision: jest.fn(),
    start: jest.fn(),
    stop: jest.fn(),
    getStatus: jest.fn(),
    getResourceUsage: jest.fn(),
    reset: jest.fn(),
  };

  const mockMendixProvisioner = {
    provision: jest.fn(),
    deprovision: jest.fn(),
    start: jest.fn(),
    stop: jest.fn(),
    getStatus: jest.fn(),
    getResourceUsage: jest.fn(),
    reset: jest.fn(),
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        SandboxesService,
        {
          provide: PrismaService,
          useValue: mockPrismaService,
        },
        {
          provide: NotificationsService,
          useValue: mockNotificationsService,
        },
        {
          provide: AuditService,
          useValue: mockAuditService,
        },
        {
          provide: PowerAppsProvisioner,
          useValue: mockPowerAppsProvisioner,
        },
        {
          provide: MendixProvisioner,
          useValue: mockMendixProvisioner,
        },
      ],
    }).compile();

    service = module.get<SandboxesService>(SandboxesService);
    prismaService = module.get<PrismaService>(PrismaService);
    notificationsService = module.get<NotificationsService>(NotificationsService);
    auditService = module.get<AuditService>(AuditService);
    powerAppsProvisioner = module.get<PowerAppsProvisioner>(PowerAppsProvisioner);
    mendixProvisioner = module.get<MendixProvisioner>(MendixProvisioner);

    // Reset mocks
    jest.clearAllMocks();
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  describe('create', () => {
    const createDto: CreateSandboxDto = {
      name: 'Test Sandbox',
      description: 'Test description',
      platform: SandboxPlatform.POWERAPPS,
      type: SandboxType.PERSONAL,
      expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
      platformConfig: {},
    };

    it('should create a sandbox successfully', async () => {
      mockPrismaService.organization.findUnique.mockResolvedValue({
        id: 'org-123',
        name: 'Test Org',
      });
      mockPrismaService.sandbox.count.mockResolvedValue(0);
      mockPrismaService.sandbox.create.mockResolvedValue(mockSandbox);

      const result = await service.create(createDto, 'user-123', 'org-123');

      expect(result).toEqual(mockSandbox);
      expect(mockPrismaService.sandbox.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          organizationId: 'org-123',
          createdById: 'user-123',
          name: createDto.name,
          description: createDto.description,
          status: SandboxStatus.PROVISIONING,
        }),
        include: expect.any(Object),
      });
      expect(mockAuditService.createAuditLog).toHaveBeenCalled();
    });

    it('should throw error if organization not found', async () => {
      mockPrismaService.organization.findUnique.mockResolvedValue(null);

      await expect(service.create(createDto, 'user-123', 'org-123')).rejects.toThrow(
        NotFoundException,
      );
    });

    it('should throw error if personal sandbox quota exceeded', async () => {
      mockPrismaService.organization.findUnique.mockResolvedValue({ id: 'org-123' });
      mockPrismaService.sandbox.count.mockResolvedValue(5);

      await expect(service.create(createDto, 'user-123', 'org-123')).rejects.toThrow(
        BadRequestException,
      );
      expect(mockPrismaService.sandbox.count).toHaveBeenCalledWith({
        where: {
          organizationId: 'org-123',
          createdById: 'user-123',
          status: { notIn: [SandboxStatus.DELETED, SandboxStatus.EXPIRED] },
          environment: {
            path: ['type'],
            equals: SandboxType.PERSONAL,
          },
        },
      });
    });

    it('should throw error if team sandbox quota exceeded', async () => {
      const teamDto = { ...createDto, type: SandboxType.TEAM };
      mockPrismaService.organization.findUnique.mockResolvedValue({ id: 'org-123' });
      mockPrismaService.sandbox.count.mockResolvedValue(15);

      await expect(service.create(teamDto, 'user-123', 'org-123')).rejects.toThrow(
        BadRequestException,
      );
    });
  });

  describe('findAll', () => {
    it('should return all sandboxes for organization', async () => {
      const sandboxes = [mockSandbox];
      mockPrismaService.sandbox.findMany.mockResolvedValue(sandboxes);

      const result = await service.findAll('org-123', {});

      expect(result).toEqual(sandboxes);
      expect(mockPrismaService.sandbox.findMany).toHaveBeenCalledWith({
        where: { organizationId: 'org-123' },
        include: expect.any(Object),
        orderBy: { createdAt: 'desc' },
      });
    });

    it('should filter by status', async () => {
      const sandboxes = [mockSandbox];
      mockPrismaService.sandbox.findMany.mockResolvedValue(sandboxes);

      await service.findAll('org-123', { status: SandboxStatus.ACTIVE });

      expect(mockPrismaService.sandbox.findMany).toHaveBeenCalledWith({
        where: {
          organizationId: 'org-123',
          status: SandboxStatus.ACTIVE,
        },
        include: expect.any(Object),
        orderBy: { createdAt: 'desc' },
      });
    });

    it('should filter by platform', async () => {
      mockPrismaService.sandbox.findMany.mockResolvedValue([mockSandbox]);

      await service.findAll('org-123', { platform: SandboxPlatform.MENDIX });

      expect(mockPrismaService.sandbox.findMany).toHaveBeenCalledWith({
        where: {
          organizationId: 'org-123',
          environment: {
            path: ['platform'],
            equals: SandboxPlatform.MENDIX,
          },
        },
        include: expect.any(Object),
        orderBy: { createdAt: 'desc' },
      });
    });
  });

  describe('findOne', () => {
    it('should return a sandbox by id', async () => {
      mockPrismaService.sandbox.findUnique.mockResolvedValue(mockSandbox);

      const result = await service.findOne('sandbox-123', 'org-123');

      expect(result).toEqual(mockSandbox);
      expect(mockPrismaService.sandbox.findUnique).toHaveBeenCalledWith({
        where: {
          id: 'sandbox-123',
          organizationId: 'org-123',
        },
        include: expect.any(Object),
      });
    });

    it('should throw NotFoundException if sandbox not found', async () => {
      mockPrismaService.sandbox.findUnique.mockResolvedValue(null);

      await expect(service.findOne('sandbox-123', 'org-123')).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  describe('update', () => {
    const updateDto: UpdateSandboxDto = {
      name: 'Updated Sandbox',
      description: 'Updated description',
    };

    it('should update a sandbox', async () => {
      mockPrismaService.sandbox.findFirst.mockResolvedValue(mockSandbox);
      const updatedSandbox = { ...mockSandbox, ...updateDto };
      mockPrismaService.sandbox.update.mockResolvedValue(updatedSandbox);

      const result = await service.update('sandbox-123', 'org-123', updateDto, 'user-123');

      expect(result).toEqual(updatedSandbox);
      expect(mockPrismaService.sandbox.update).toHaveBeenCalledWith({
        where: { id: 'sandbox-123' },
        data: expect.objectContaining(updateDto),
        include: expect.any(Object),
      });
      expect(mockAuditService.createAuditLog).toHaveBeenCalled();
    });

    it('should throw NotFoundException if sandbox not found', async () => {
      mockPrismaService.sandbox.findFirst.mockResolvedValue(null);

      await expect(
        service.update('sandbox-123', 'org-123', updateDto, 'user-123'),
      ).rejects.toThrow(NotFoundException);
    });
  });

  describe('remove', () => {
    it('should delete a sandbox and deprovision environment', async () => {
      const activeSandbox = {
        ...mockSandbox,
        status: SandboxStatus.ACTIVE,
        environment: {
          ...mockSandbox.environment,
          environmentId: 'env-123',
          provisioningStatus: ProvisioningStatus.COMPLETED,
        },
      };
      mockPrismaService.sandbox.findFirst.mockResolvedValue(activeSandbox);
      mockPrismaService.sandbox.update.mockResolvedValue({
        ...activeSandbox,
        status: SandboxStatus.DELETED,
      });
      mockPowerAppsProvisioner.deprovision.mockResolvedValue(undefined);

      await service.remove('sandbox-123', 'org-123', 'user-123');

      expect(mockPowerAppsProvisioner.deprovision).toHaveBeenCalledWith(
        'user-123',
        'org-123',
        'env-123',
      );
      expect(mockPrismaService.sandbox.update).toHaveBeenCalledWith({
        where: { id: 'sandbox-123' },
        data: { status: SandboxStatus.DELETED },
      });
      expect(mockAuditService.createAuditLog).toHaveBeenCalled();
    });

    it('should throw NotFoundException if sandbox not found', async () => {
      mockPrismaService.sandbox.findFirst.mockResolvedValue(null);

      await expect(service.remove('sandbox-123', 'org-123', 'user-123')).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  describe('start', () => {
    it('should start a Mendix sandbox', async () => {
      const mendixSandbox = {
        ...mockSandbox,
        status: SandboxStatus.ACTIVE,
        environment: {
          platform: SandboxPlatform.MENDIX,
          type: SandboxType.PERSONAL,
          provisioningStatus: ProvisioningStatus.COMPLETED,
          environmentId: 'env-123',
          environmentUrl: 'https://app.mendix.com',
          region: 'eu-central-1',
          metadata: {},
        },
      };
      mockPrismaService.sandbox.findFirst.mockResolvedValue(mendixSandbox);
      mockMendixProvisioner.start.mockResolvedValue(undefined);

      await service.start('sandbox-123', 'org-123', 'user-123');

      expect(mockMendixProvisioner.start).toHaveBeenCalledWith(
        'user-123',
        'org-123',
        'env-123',
      );
      expect(mockAuditService.createAuditLog).toHaveBeenCalled();
    });

    it('should throw error for PowerApps (not supported)', async () => {
      const activeSandbox = {
        ...mockSandbox,
        status: SandboxStatus.ACTIVE,
        environment: {
          ...mockSandbox.environment,
          environmentId: 'env-123',
          provisioningStatus: ProvisioningStatus.COMPLETED,
        },
      };
      mockPrismaService.sandbox.findFirst.mockResolvedValue(activeSandbox);

      await expect(service.start('sandbox-123', 'org-123', 'user-123')).rejects.toThrow(
        BadRequestException,
      );
    });

    it('should throw error if sandbox not provisioned', async () => {
      mockPrismaService.sandbox.findFirst.mockResolvedValue(mockSandbox);

      await expect(service.start('sandbox-123', 'org-123', 'user-123')).rejects.toThrow(
        BadRequestException,
      );
    });
  });

  describe('stop', () => {
    it('should stop a Mendix sandbox', async () => {
      const mendixSandbox = {
        ...mockSandbox,
        status: SandboxStatus.ACTIVE,
        environment: {
          platform: SandboxPlatform.MENDIX,
          type: SandboxType.PERSONAL,
          provisioningStatus: ProvisioningStatus.COMPLETED,
          environmentId: 'env-123',
          environmentUrl: 'https://app.mendix.com',
          region: 'eu-central-1',
          metadata: {},
        },
      };
      mockPrismaService.sandbox.findFirst.mockResolvedValue(mendixSandbox);
      mockMendixProvisioner.stop.mockResolvedValue(undefined);

      await service.stop('sandbox-123', 'org-123', 'user-123');

      expect(mockMendixProvisioner.stop).toHaveBeenCalledWith('user-123', 'org-123', 'env-123');
      expect(mockAuditService.createAuditLog).toHaveBeenCalled();
    });
  });

  describe('getStats', () => {
    it('should return sandbox resource statistics', async () => {
      const activeSandbox = {
        ...mockSandbox,
        status: SandboxStatus.ACTIVE,
        environment: {
          ...mockSandbox.environment,
          environmentId: 'env-123',
          provisioningStatus: ProvisioningStatus.COMPLETED,
        },
      };
      mockPrismaService.sandbox.findFirst.mockResolvedValue(activeSandbox);
      mockPowerAppsProvisioner.getResourceUsage.mockResolvedValue({
        appsCount: 2,
        apiCallsUsed: 500,
        storageUsed: 50,
      });

      const result = await service.getStats('sandbox-123', 'org-123');

      expect(result).toEqual({
        appsCount: 2,
        apiCallsUsed: 500,
        storageUsed: 50,
        maxApps: 3,
        maxApiCalls: 1000,
        maxStorage: 100,
      });
      expect(mockPowerAppsProvisioner.getResourceUsage).toHaveBeenCalledWith(
        'user-123',
        'org-123',
        'env-123',
      );
    });

    it('should throw error if sandbox not provisioned', async () => {
      mockPrismaService.sandbox.findFirst.mockResolvedValue(mockSandbox);

      await expect(service.getStats('sandbox-123', 'org-123')).rejects.toThrow(
        BadRequestException,
      );
    });
  });

  describe('extendExpiration', () => {
    it('should extend sandbox expiration', async () => {
      const activeSandbox = {
        ...mockSandbox,
        status: SandboxStatus.ACTIVE,
        expiresAt: new Date(Date.now() + 5 * 24 * 60 * 60 * 1000),
      };
      const newExpiresAt = new Date(Date.now() + 35 * 24 * 60 * 60 * 1000);
      mockPrismaService.sandbox.findFirst.mockResolvedValue(activeSandbox);
      const extendedSandbox = {
        ...activeSandbox,
        expiresAt: newExpiresAt,
      };
      mockPrismaService.sandbox.update.mockResolvedValue(extendedSandbox);

      const result = await service.extendExpiration(
        'sandbox-123',
        'org-123',
        newExpiresAt,
        'user-123',
      );

      expect(result).toEqual(extendedSandbox);
      expect(mockPrismaService.sandbox.update).toHaveBeenCalledWith({
        where: { id: 'sandbox-123' },
        data: {
          expiresAt: newExpiresAt,
        },
        include: expect.any(Object),
      });
      expect(mockAuditService.createAuditLog).toHaveBeenCalled();
    });

    it('should throw error if extending beyond max duration', async () => {
      const activeSandbox = {
        ...mockSandbox,
        status: SandboxStatus.ACTIVE,
        expiresAt: new Date(Date.now() + 5 * 24 * 60 * 60 * 1000),
        environment: {
          ...mockSandbox.environment,
          provisioningStatus: ProvisioningStatus.COMPLETED,
        },
      };
      const newExpiresAt = new Date(Date.now() + 200 * 24 * 60 * 60 * 1000);
      mockPrismaService.sandbox.findFirst.mockResolvedValue(activeSandbox);

      await expect(
        service.extendExpiration('sandbox-123', 'org-123', newExpiresAt, 'user-123'),
      ).rejects.toThrow();
    });
  });

  describe('cleanupExpiredSandboxes', () => {
    it('should cleanup expired sandboxes', async () => {
      const expiredSandbox = {
        ...mockSandbox,
        status: SandboxStatus.ACTIVE,
        expiresAt: new Date(Date.now() - 24 * 60 * 60 * 1000),
        environment: {
          ...mockSandbox.environment,
          environmentId: 'env-123',
          provisioningStatus: ProvisioningStatus.COMPLETED,
        },
      };
      mockPrismaService.sandbox.findMany.mockResolvedValue([expiredSandbox]);
      mockPowerAppsProvisioner.deprovision.mockResolvedValue(undefined);
      mockPrismaService.sandbox.update.mockResolvedValue({
        ...expiredSandbox,
        status: SandboxStatus.EXPIRED,
      });

      await service.cleanupExpiredSandboxes();

      expect(mockPrismaService.sandbox.findMany).toHaveBeenCalledWith({
        where: {
          expiresAt: { lte: expect.any(Date) },
          status: { in: [SandboxStatus.ACTIVE, SandboxStatus.SUSPENDED] },
        },
        include: expect.any(Object),
      });
      expect(mockPowerAppsProvisioner.deprovision).toHaveBeenCalled();
      expect(mockPrismaService.sandbox.update).toHaveBeenCalledWith({
        where: { id: 'sandbox-123' },
        data: { status: SandboxStatus.EXPIRED },
      });
    });
  });

  describe('sendExpirationWarnings', () => {
    it('should send 7-day expiration warnings', async () => {
      const sandboxExpiringSoon = {
        ...mockSandbox,
        status: SandboxStatus.ACTIVE,
        expiresAt: new Date(Date.now() + 6 * 24 * 60 * 60 * 1000),
      };
      mockPrismaService.sandbox.findMany.mockResolvedValue([sandboxExpiringSoon]);

      await service.sendExpirationWarnings();

      expect(mockNotificationsService.sendNotification).toHaveBeenCalledWith(
        expect.objectContaining({
          userId: 'user-123',
          type: 'warning',
        }),
      );
    });

    it('should send 1-day expiration warnings', async () => {
      const sandboxExpiringTomorrow = {
        ...mockSandbox,
        status: SandboxStatus.ACTIVE,
        expiresAt: new Date(Date.now() + 12 * 60 * 60 * 1000), // 12 hours
      };
      mockPrismaService.sandbox.findMany.mockResolvedValue([sandboxExpiringTomorrow]);

      await service.sendExpirationWarnings();

      expect(mockNotificationsService.sendNotification).toHaveBeenCalledWith(
        expect.objectContaining({
          userId: 'user-123',
          type: 'warning',
        }),
      );
    });
  });
});

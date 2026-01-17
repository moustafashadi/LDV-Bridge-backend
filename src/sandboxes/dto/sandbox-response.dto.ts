import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsNumber, IsPositive, Min } from 'class-validator';
import {
  SandboxPlatform,
  SandboxStatus,
  SandboxType,
  ProvisioningStatus,
} from '../interfaces/sandbox-environment.interface';

/**
 * Sandbox response DTO
 * Returned by GET endpoints with full sandbox details
 */
export class SandboxResponseDto {
  @ApiProperty({
    description: 'Unique sandbox identifier',
    example: '550e8400-e29b-41d4-a716-446655440000',
  })
  id: string;

  @ApiProperty({
    description: 'Organization ID',
    example: '550e8400-e29b-41d4-a716-446655440001',
  })
  organizationId: string;

  @ApiProperty({
    description: 'User ID who created the sandbox',
    example: '550e8400-e29b-41d4-a716-446655440002',
  })
  createdById: string;

  @ApiPropertyOptional({
    description: 'ID of the app this sandbox is forked from',
    example: '550e8400-e29b-41d4-a716-446655440003',
  })
  appId?: string;

  @ApiProperty({
    description: 'Sandbox name',
    example: 'My Development Sandbox',
  })
  name: string;

  @ApiPropertyOptional({
    description: 'Sandbox description',
    example: 'Personal sandbox for testing PowerApps components',
  })
  description?: string;

  @ApiProperty({
    description: 'Current sandbox status',
    enum: SandboxStatus,
    example: SandboxStatus.ACTIVE,
  })
  status: SandboxStatus;

  @ApiProperty({
    description: 'Platform type',
    enum: SandboxPlatform,
    example: SandboxPlatform.POWERAPPS,
  })
  platform: SandboxPlatform;

  @ApiProperty({
    description: 'Sandbox type',
    enum: SandboxType,
    example: SandboxType.PERSONAL,
  })
  type: SandboxType;

  @ApiProperty({
    description: 'Provisioning status',
    enum: ProvisioningStatus,
    example: ProvisioningStatus.COMPLETED,
  })
  provisioningStatus: ProvisioningStatus;

  @ApiPropertyOptional({
    description: 'Platform-specific environment ID',
    example: 'env-abc123',
  })
  environmentId?: string;

  @ApiPropertyOptional({
    description: 'Direct URL to access the environment',
    example: 'https://myenv.crm.dynamics.com',
  })
  environmentUrl?: string;

  @ApiPropertyOptional({
    description: 'Region where environment is hosted',
    example: 'unitedstates',
  })
  region?: string;

  @ApiPropertyOptional({
    description: 'Expiration date (ISO 8601)',
    example: '2025-12-31T23:59:59Z',
  })
  expiresAt?: Date;

  @ApiProperty({
    description: 'Creation timestamp',
    example: '2025-11-01T10:00:00Z',
  })
  createdAt: Date;

  @ApiProperty({
    description: 'Last update timestamp',
    example: '2025-11-29T14:30:00Z',
  })
  updatedAt: Date;

  @ApiPropertyOptional({
    description: 'Creator user details',
  })
  createdBy?: {
    id: string;
    email: string;
    name: string | null;
  };

  @ApiPropertyOptional({
    description: 'Organization details',
  })
  organization?: {
    id: string;
    name: string;
  };

  @ApiPropertyOptional({
    description: 'Platform-specific metadata',
    example: { displayName: 'My Dev Env', type: 'Developer' },
  })
  metadata?: Record<string, any>;
}

/**
 * Sandbox resource usage statistics
 */
export class SandboxStatsDto {
  @ApiProperty({
    description: 'Current number of apps deployed',
    example: 2,
  })
  appsCount: number;

  @ApiProperty({
    description: 'API calls used today',
    example: 150,
  })
  apiCallsUsed: number;

  @ApiProperty({
    description: 'Storage used in MB',
    example: 45.2,
  })
  storageUsed: number;

  @ApiProperty({
    description: 'Maximum apps allowed',
    example: 3,
  })
  maxApps: number;

  @ApiProperty({
    description: 'Maximum API calls per day',
    example: 1000,
  })
  maxApiCalls: number;

  @ApiProperty({
    description: 'Maximum storage in MB',
    example: 100,
  })
  maxStorage: number;
}

/**
 * DTO for extending sandbox expiration
 */
export class ExtendExpirationDto {
  @ApiProperty({
    description: 'Number of days to extend (must be positive)',
    example: 30,
    minimum: 1,
  })
  @IsNumber()
  @IsPositive()
  @Min(1)
  days: number;
}

/**
 * DTO for assigning users to a sandbox
 */
export class AssignUsersDto {
  @ApiProperty({
    description: 'Array of user IDs to assign',
    example: ['user-123', 'user-456'],
    type: [String],
  })
  userIds: string[];
}

/**
 * DTO for unassigning users from a sandbox
 */
export class UnassignUsersDto {
  @ApiProperty({
    description: 'Array of user IDs to unassign',
    example: ['user-123'],
    type: [String],
  })
  userIds: string[];
}

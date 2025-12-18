import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class LinkedEnvironmentResponseDto {
  @ApiProperty({ description: 'Unique identifier' })
  id: string;

  @ApiProperty({ description: 'Organization ID' })
  organizationId: string;

  @ApiProperty({ description: 'Display name' })
  name: string;

  @ApiPropertyOptional({ description: 'Description' })
  description?: string;

  @ApiProperty({ description: 'Platform type (POWERAPPS)' })
  platform: string;

  @ApiProperty({ description: 'External environment ID' })
  environmentId: string;

  @ApiPropertyOptional({ description: 'Environment URL' })
  environmentUrl?: string;

  @ApiPropertyOptional({ description: 'Region' })
  region?: string;

  @ApiProperty({ description: 'Whether the environment is active' })
  isActive: boolean;

  @ApiProperty({ description: 'Creation timestamp' })
  createdAt: Date;

  @ApiProperty({ description: 'Last update timestamp' })
  updatedAt: Date;

  @ApiPropertyOptional({ description: 'User who created this link' })
  createdBy?: {
    id: string;
    email: string;
    name?: string;
  };
}

export class LinkedEnvironmentWithAppsDto extends LinkedEnvironmentResponseDto {
  @ApiProperty({ description: 'Apps in this environment', type: 'array' })
  apps: any[]; // Will be populated from PowerApps API
}

import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsString,
  IsEnum,
  IsOptional,
  IsDateString,
  IsObject,
  MinLength,
  MaxLength,
} from 'class-validator';
import { SandboxPlatform, SandboxType } from '../interfaces/sandbox-environment.interface';

/**
 * DTO for creating a new sandbox
 */
export class CreateSandboxDto {
  @ApiProperty({
    description: 'Sandbox name',
    example: 'My Development Sandbox',
    minLength: 3,
    maxLength: 100,
  })
  @IsString()
  @MinLength(3)
  @MaxLength(100)
  name: string;

  @ApiPropertyOptional({
    description: 'Sandbox description',
    example: 'Personal sandbox for testing PowerApps components',
  })
  @IsString()
  @IsOptional()
  description?: string;

  @ApiProperty({
    description: 'Platform for the sandbox',
    enum: SandboxPlatform,
    example: SandboxPlatform.POWERAPPS,
  })
  @IsEnum(SandboxPlatform)
  platform: SandboxPlatform;

  @ApiProperty({
    description: 'Sandbox type (determines quotas and permissions)',
    enum: SandboxType,
    example: SandboxType.PERSONAL,
  })
  @IsEnum(SandboxType)
  type: SandboxType;

  @ApiPropertyOptional({
    description: 'Expiration date (ISO 8601 format). If not provided, calculated based on type.',
    example: '2025-12-31T23:59:59Z',
  })
  @IsDateString()
  @IsOptional()
  expiresAt?: string;

  @ApiPropertyOptional({
    description: 'Source app ID to clone from (must be a synced app in LDV-Bridge). If provided, creates a clone of the existing app instead of a new app from template.',
    example: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890',
  })
  @IsString()
  @IsOptional()
  sourceAppId?: string;

  @ApiPropertyOptional({
    description: 'Platform-specific configuration (PowerApps or Mendix specific settings)',
    example: {
      region: 'unitedstates',
      languageCode: 1033,
    },
  })
  @IsObject()
  @IsOptional()
  platformConfig?: Record<string, any>;
}

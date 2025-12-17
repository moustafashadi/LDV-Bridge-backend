import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsString,
  IsEnum,
  IsOptional,
  IsDateString,
  MinLength,
  MaxLength,
} from 'class-validator';
import { SandboxPlatform, SandboxType } from '../interfaces/sandbox-environment.interface';

/**
 * DTO for linking an existing PowerApps/Mendix environment to LDV-Bridge
 * This allows users to work with pre-existing environments without creating new ones
 */
export class LinkExistingEnvironmentDto {
  @ApiProperty({
    description: 'Sandbox name (for tracking in LDV-Bridge)',
    example: 'My Existing PowerApps Environment',
    minLength: 3,
    maxLength: 100,
  })
  @IsString()
  @MinLength(3)
  @MaxLength(100)
  name: string;

  @ApiPropertyOptional({
    description: 'Sandbox description',
    example: 'Linking my existing PowerApps production environment',
  })
  @IsString()
  @IsOptional()
  description?: string;

  @ApiProperty({
    description: 'Platform of the existing environment',
    enum: SandboxPlatform,
    example: SandboxPlatform.POWERAPPS,
  })
  @IsEnum(SandboxPlatform)
  platform: SandboxPlatform;

  @ApiProperty({
    description: 'The external environment ID from PowerApps/Mendix',
    example: 'Default-919a36ea-e454-402f-bbb8-95e014ac858e',
  })
  @IsString()
  environmentId: string;

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
}

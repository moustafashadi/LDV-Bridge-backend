import { IsString, IsOptional, IsEnum, IsNotEmpty } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export enum PlatformType {
  POWERAPPS = 'POWERAPPS',
  MENDIX = 'MENDIX',
}

export enum AppStatus {
  DRAFT = 'DRAFT',
  ACTIVE = 'ACTIVE',
  INACTIVE = 'INACTIVE',
  ARCHIVED = 'ARCHIVED',
}

export class CreateAppDto {
  @ApiProperty({ description: 'App name' })
  @IsString()
  @IsNotEmpty()
  name: string;

  @ApiPropertyOptional({ description: 'App description' })
  @IsString()
  @IsOptional()
  description?: string;

  @ApiProperty({ enum: PlatformType, description: 'Platform type (POWERAPPS or MENDIX)' })
  @IsEnum(PlatformType)
  platform: PlatformType;

  @ApiPropertyOptional({ description: 'External app ID from the platform (if syncing existing app)' })
  @IsString()
  @IsOptional()
  externalId?: string;

  @ApiPropertyOptional({ description: 'Connector ID (required if syncing from external platform)' })
  @IsString()
  @IsOptional()
  connectorId?: string;

  @ApiPropertyOptional({ enum: AppStatus, description: 'Initial app status', default: 'DRAFT' })
  @IsEnum(AppStatus)
  @IsOptional()
  status?: AppStatus;

  @ApiPropertyOptional({ description: 'App version' })
  @IsString()
  @IsOptional()
  version?: string;

  @ApiPropertyOptional({ description: 'Additional metadata as JSON' })
  @IsOptional()
  metadata?: Record<string, any>;
}

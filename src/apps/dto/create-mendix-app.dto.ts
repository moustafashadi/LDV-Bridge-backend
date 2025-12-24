import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsNotEmpty,
  IsString,
  IsOptional,
  MaxLength,
  MinLength,
  Matches,
} from 'class-validator';

/**
 * DTO for creating a new Mendix app.
 * This is used by the dedicated Mendix app creation endpoint which:
 * 1. Creates a new Mendix project via Build API
 * 2. Creates a GitHub repository for version control
 * 3. Performs initial sync using Model SDK
 *
 * NOTE: This does NOT create a sandbox. Sandboxes should be created
 * separately after the app is created.
 */
export class CreateMendixAppDto {
  @ApiProperty({
    description: 'Name of the Mendix app to create',
    example: 'My New App',
    minLength: 1,
    maxLength: 100,
  })
  @IsNotEmpty({ message: 'App name is required' })
  @IsString()
  @MinLength(1, { message: 'App name must be at least 1 character' })
  @MaxLength(100, { message: 'App name must be at most 100 characters' })
  @Matches(/^[a-zA-Z0-9\s\-_]+$/, {
    message:
      'App name can only contain letters, numbers, spaces, hyphens, and underscores',
  })
  name: string;

  @ApiPropertyOptional({
    description: 'Optional description for the app',
    example: 'A customer management application',
    maxLength: 500,
  })
  @IsOptional()
  @IsString()
  @MaxLength(500, { message: 'Description must be at most 500 characters' })
  description?: string;

  @ApiPropertyOptional({
    description:
      'The ID of the Mendix connector to use. If not provided, the default active connector will be used.',
    example: 'conn_abc123',
  })
  @IsOptional()
  @IsString()
  connectorId?: string;
}

/**
 * Response DTO for Mendix app creation
 */
export class CreateMendixAppResponseDto {
  @ApiProperty({ description: 'Internal app ID in LDV-Bridge' })
  id: string;

  @ApiProperty({ description: 'App name' })
  name: string;

  @ApiProperty({ description: 'App description' })
  description?: string;

  @ApiProperty({ description: 'Mendix project ID (UUID)' })
  projectId: string;

  @ApiProperty({
    description: 'Mendix app ID (subdomain), available after deployment',
  })
  appId?: string;

  @ApiProperty({ description: 'Running app URL, available after deployment' })
  appUrl?: string;

  @ApiProperty({ description: 'GitHub repository URL' })
  githubRepoUrl?: string;

  @ApiProperty({ description: 'Mendix Developer Portal URL' })
  portalUrl: string;

  @ApiProperty({
    description: 'Creation status',
    enum: ['created', 'deployed', 'synced'],
    example: 'deployed',
  })
  status: 'created' | 'deployed' | 'synced';

  @ApiProperty({ description: 'Whether initial sync was successful' })
  syncCompleted: boolean;

  @ApiProperty({ description: 'Sync details or error message if sync failed' })
  syncMessage?: string;

  @ApiProperty({ description: 'Creation timestamp' })
  createdAt: Date;
}

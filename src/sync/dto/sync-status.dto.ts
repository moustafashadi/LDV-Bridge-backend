import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { PlatformType, SyncStatus } from '@prisma/client';

export class CurrentSyncDto {
  @ApiProperty({
    description: 'Bull job ID',
    example: '123',
  })
  jobId: string;

  @ApiProperty({
    description: 'Sync status',
    enum: SyncStatus,
    example: 'IN_PROGRESS',
  })
  status: SyncStatus;

  @ApiProperty({
    description: 'Sync started timestamp',
  })
  startedAt: Date;

  @ApiPropertyOptional({
    description: 'Progress percentage (0-100)',
    example: 45,
  })
  progress?: number;

  @ApiPropertyOptional({
    description: 'Current operation description',
    example: 'Fetching app metadata from PowerApps',
  })
  currentOperation?: string;
}

export class SyncStatusResponseDto {
  @ApiProperty({
    description: 'App ID',
    example: '123e4567-e89b-12d3-a456-426614174000',
  })
  appId: string;

  @ApiProperty({
    description: 'App name',
    example: 'My PowerApp',
  })
  appName: string;

  @ApiProperty({
    description: 'Platform type',
    enum: PlatformType,
    example: 'POWERAPPS',
  })
  platform: PlatformType;

  @ApiPropertyOptional({
    description: 'Last successful sync timestamp',
  })
  lastSyncedAt?: Date;

  @ApiPropertyOptional({
    description: 'Current sync operation (if any)',
  })
  currentSync?: CurrentSyncDto;

  @ApiPropertyOptional({
    description: 'Next scheduled automatic sync',
  })
  nextScheduledSync?: Date;

  @ApiPropertyOptional({
    description: 'Number of items synced in last sync',
    example: 42,
  })
  lastSyncItemsCount?: number;

  @ApiPropertyOptional({
    description: 'Duration of last sync in milliseconds',
    example: 15000,
  })
  lastSyncDuration?: number;
}

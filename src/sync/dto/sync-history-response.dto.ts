import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { PlatformType, SyncStatus, SyncTriggerType } from '@prisma/client';

export class SyncHistoryItemDto {
  @ApiProperty({
    description: 'Sync history record ID',
    example: '123e4567-e89b-12d3-a456-426614174000',
  })
  id: string;

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

  @ApiProperty({
    description: 'Sync status',
    enum: SyncStatus,
    example: 'COMPLETED',
  })
  status: SyncStatus;

  @ApiProperty({
    description: 'User or system that triggered the sync',
    example: 'John Doe',
  })
  triggeredBy: string;

  @ApiProperty({
    description: 'Trigger type',
    enum: SyncTriggerType,
    example: 'MANUAL',
  })
  triggerType: SyncTriggerType;

  @ApiPropertyOptional({
    description: 'Sync started timestamp',
  })
  startedAt?: Date;

  @ApiPropertyOptional({
    description: 'Sync completed timestamp',
  })
  completedAt?: Date;

  @ApiPropertyOptional({
    description: 'Sync duration in milliseconds',
    example: 15000,
  })
  duration?: number;

  @ApiPropertyOptional({
    description: 'Number of items synced',
    example: 42,
  })
  itemsSynced?: number;

  @ApiPropertyOptional({
    description: 'Error message (if failed)',
    example: 'Connection timeout',
  })
  errorMessage?: string;

  @ApiProperty({
    description: 'Record created timestamp',
  })
  createdAt: Date;
}

export class PaginationMetaDto {
  @ApiProperty({
    description: 'Total number of records',
    example: 150,
  })
  total: number;

  @ApiProperty({
    description: 'Current page number',
    example: 1,
  })
  page: number;

  @ApiProperty({
    description: 'Records per page',
    example: 20,
  })
  limit: number;

  @ApiProperty({
    description: 'Total number of pages',
    example: 8,
  })
  totalPages: number;

  @ApiProperty({
    description: 'Whether there are more pages',
    example: true,
  })
  hasMore: boolean;
}

export class SyncHistoryResponseDto {
  @ApiProperty({
    description: 'List of sync history records',
    type: [SyncHistoryItemDto],
  })
  data: SyncHistoryItemDto[];

  @ApiProperty({
    description: 'Pagination metadata',
  })
  pagination: PaginationMetaDto;
}

export class SyncJobData {
  appId: string;
  userId: string;
  triggerType: SyncTriggerType;
  reason?: string;
}

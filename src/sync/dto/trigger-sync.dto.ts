import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsEnum, IsOptional, IsUUID, IsString } from 'class-validator';
import { PlatformType } from '@prisma/client';

export class TriggerSyncDto {
  @ApiProperty({
    description: 'Platform type',
    enum: PlatformType,
    example: 'POWERAPPS',
  })
  @IsEnum(PlatformType)
  platform: PlatformType;

  @ApiProperty({
    description: 'App ID to sync',
    example: '123e4567-e89b-12d3-a456-426614174000',
  })
  @IsUUID()
  appId: string;

  @ApiPropertyOptional({
    description: 'Optional reason for manual sync',
    example: 'Testing new changes',
  })
  @IsOptional()
  @IsString()
  reason?: string;
}

export class TriggerSyncResponseDto {
  @ApiProperty({
    description: 'Success status',
    example: true,
  })
  success: boolean;

  @ApiProperty({
    description: 'Response message',
    example: 'Sync job queued successfully',
  })
  message: string;

  @ApiProperty({
    description: 'Sync job details',
  })
  data: {
    jobId: string;
    appId: string;
    appName: string;
    platform: PlatformType;
    status: string;
    queuedAt: Date;
  };
}

import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { ChangeType, ChangeStatus } from '@prisma/client';

export class ChangeResponseDto {
  @ApiProperty({ example: '123e4567-e89b-12d3-a456-426614174000' })
  id: string;

  @ApiProperty({ example: '123e4567-e89b-12d3-a456-426614174000' })
  organizationId: string;

  @ApiProperty({ example: '123e4567-e89b-12d3-a456-426614174000' })
  appId: string;

  @ApiProperty({ example: 'My PowerApp' })
  appName: string;

  @ApiProperty({ example: '123e4567-e89b-12d3-a456-426614174000' })
  authorId: string;

  @ApiProperty({ example: 'John Doe' })
  authorName: string;

  @ApiProperty({ example: 'Updated login screen formula' })
  title: string;

  @ApiPropertyOptional({
    example: 'Modified the authentication logic to support MFA',
  })
  description?: string;

  @ApiProperty({ enum: ChangeType, example: ChangeType.UPDATE })
  changeType: ChangeType;

  @ApiProperty({ enum: ChangeStatus, example: ChangeStatus.DRAFT })
  status: ChangeStatus;

  @ApiPropertyOptional({
    description: 'Diff summary with change counts and operations',
    example: {
      totalChanges: 15,
      added: 5,
      modified: 8,
      deleted: 2,
      operations: [],
    },
  })
  diffSummary?: any;

  @ApiPropertyOptional({ example: 65, description: 'Risk score 0-100' })
  riskScore?: number;

  @ApiPropertyOptional({
    example: { overallRisk: 'medium', factors: [] },
  })
  riskAssessment?: any;

  @ApiPropertyOptional()
  submittedAt?: Date;

  @ApiProperty()
  createdAt: Date;

  @ApiProperty()
  updatedAt: Date;
}

export class DetectChangesResponseDto {
  @ApiProperty({ example: true })
  success: boolean;

  @ApiProperty({ example: 'Detected 15 changes in app' })
  message: string;

  @ApiProperty({ example: 15 })
  totalChanges: number;

  @ApiPropertyOptional({ type: ChangeResponseDto })
  change?: ChangeResponseDto;
}

export class PaginatedChangesResponseDto {
  @ApiProperty({ type: [ChangeResponseDto] })
  items: ChangeResponseDto[];

  @ApiProperty({ example: 100 })
  total: number;

  @ApiProperty({ example: 1 })
  page: number;

  @ApiProperty({ example: 20 })
  limit: number;

  @ApiProperty({ example: 5 })
  totalPages: number;
}

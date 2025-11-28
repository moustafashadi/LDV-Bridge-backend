import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { ReviewStatus } from '@prisma/client';

export class ReviewerDto {
  @ApiProperty({ example: '550e8400-e29b-41d4-a716-446655440001' })
  id: string;

  @ApiProperty({ example: 'John Doe' })
  name: string;

  @ApiProperty({ example: 'john.doe@example.com' })
  email: string;

  @ApiPropertyOptional({ example: 'PRO_DEVELOPER' })
  role?: string;
}

export class ChangeDetailsDto {
  @ApiProperty({ example: '550e8400-e29b-41d4-a716-446655440000' })
  id: string;

  @ApiProperty({ example: 'Updated login formula' })
  title: string;

  @ApiProperty({ example: 'UPDATE' })
  changeType: string;

  @ApiPropertyOptional({ example: 'medium' })
  riskLevel?: string;

  @ApiPropertyOptional({ example: 65 })
  riskScore?: number;
}

export class ReviewSLADto {
  @ApiPropertyOptional({
    description: 'Response time in hours (time from submission to review start)',
    example: 2.5,
  })
  responseTime?: number;

  @ApiPropertyOptional({
    description: 'Review time in hours (time from start to completion)',
    example: 4.2,
  })
  reviewTime?: number;

  @ApiProperty({
    description: 'Whether the review is overdue based on SLA thresholds',
    example: false,
  })
  isOverdue: boolean;

  @ApiPropertyOptional({
    description: 'Expected completion time based on risk level',
    example: '2025-11-28T18:00:00Z',
  })
  expectedCompletionAt?: Date;
}

export class ReviewResponseDto {
  @ApiProperty({ example: '550e8400-e29b-41d4-a716-446655440002' })
  id: string;

  @ApiProperty({ example: '550e8400-e29b-41d4-a716-446655440000' })
  changeId: string;

  @ApiProperty()
  change: ChangeDetailsDto;

  @ApiProperty({ example: '550e8400-e29b-41d4-a716-446655440001' })
  reviewerId: string;

  @ApiProperty()
  reviewer: ReviewerDto;

  @ApiProperty({ enum: ReviewStatus, example: 'PENDING' })
  status: ReviewStatus;

  @ApiPropertyOptional({ example: 'approve' })
  decision?: string;

  @ApiPropertyOptional({
    example: 'Code looks good. Please add unit tests.',
  })
  feedback?: string;

  @ApiPropertyOptional({ example: '2025-11-28T10:00:00Z' })
  startedAt?: Date;

  @ApiPropertyOptional({ example: '2025-11-28T14:00:00Z' })
  completedAt?: Date;

  @ApiProperty({ example: '2025-11-28T09:00:00Z' })
  createdAt: Date;

  @ApiProperty({ example: '2025-11-28T14:00:00Z' })
  updatedAt: Date;

  @ApiProperty()
  sla: ReviewSLADto;
}

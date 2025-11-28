import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class RiskLevelMetricsDto {
  @ApiProperty({ example: 150 })
  count: number;

  @ApiProperty({ description: 'Average review time in hours', example: 6.5 })
  averageReviewTime: number;

  @ApiProperty({ description: 'Approval rate (0-1)', example: 0.85 })
  approvalRate: number;
}

export class ReviewMetricsDto {
  @ApiProperty({ example: 1250 })
  totalReviews: number;

  @ApiProperty({ example: 45 })
  pendingReviews: number;

  @ApiProperty({ example: 12 })
  inProgressReviews: number;

  @ApiProperty({ example: 980 })
  completedReviews: number;

  @ApiProperty({ description: 'Average response time in hours', example: 8.5 })
  averageResponseTime: number;

  @ApiProperty({ description: 'Average review time in hours', example: 14.2 })
  averageReviewTime: number;

  @ApiProperty({ description: 'Approval rate (0-1)', example: 0.78 })
  approvalRate: number;

  @ApiProperty({ description: 'Rejection rate (0-1)', example: 0.12 })
  rejectionRate: number;

  @ApiProperty({
    description: 'Changes requested rate (0-1)',
    example: 0.1,
  })
  changesRequestedRate: number;

  @ApiProperty({ example: 5 })
  overdueReviews: number;

  @ApiPropertyOptional({
    description: 'Metrics broken down by risk level',
  })
  byRiskLevel?: {
    low?: RiskLevelMetricsDto;
    medium?: RiskLevelMetricsDto;
    high?: RiskLevelMetricsDto;
    critical?: RiskLevelMetricsDto;
  };

  @ApiPropertyOptional({
    description: 'Date range for metrics',
  })
  dateRange?: {
    from: Date;
    to: Date;
  };
}

import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsArray, IsUUID } from 'class-validator';

export class SubmitForReviewDto {
  @ApiPropertyOptional({
    description:
      'Optional array of reviewer IDs for manual assignment. If not provided, reviewers will be auto-assigned based on risk level.',
    example: [
      '550e8400-e29b-41d4-a716-446655440001',
      '550e8400-e29b-41d4-a716-446655440002',
    ],
    type: [String],
  })
  @IsOptional()
  @IsArray()
  @IsUUID('4', { each: true })
  reviewerIds?: string[];
}

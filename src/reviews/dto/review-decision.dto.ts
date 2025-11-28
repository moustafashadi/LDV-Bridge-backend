import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString, MaxLength } from 'class-validator';

export class ReviewDecisionDto {
  @ApiPropertyOptional({
    description: 'Feedback or comments about the review decision',
    example:
      'Great work! Code looks good. Please add unit tests before merging.',
    maxLength: 5000,
  })
  @IsOptional()
  @IsString()
  @MaxLength(5000)
  feedback?: string;
}

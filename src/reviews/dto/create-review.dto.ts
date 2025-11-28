import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsNotEmpty, IsUUID, IsString, IsOptional } from 'class-validator';

export class CreateReviewDto {
  @ApiProperty({
    description: 'ID of the change to review',
    example: '550e8400-e29b-41d4-a716-446655440000',
  })
  @IsNotEmpty()
  @IsUUID()
  changeId: string;

  @ApiProperty({
    description: 'ID of the assigned reviewer',
    example: '550e8400-e29b-41d4-a716-446655440001',
  })
  @IsNotEmpty()
  @IsUUID()
  reviewerId: string;

  @ApiPropertyOptional({
    description: 'Additional notes or context for the reviewer',
    example: 'Please focus on security aspects',
  })
  @IsOptional()
  @IsString()
  notes?: string;
}

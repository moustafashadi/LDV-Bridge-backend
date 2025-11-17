import { ApiProperty } from '@nestjs/swagger';
import { IsString, IsOptional, IsInt, Min, Max } from 'class-validator';
import { Type } from 'class-transformer';

/**
 * DTO for searching organizations during signup
 */
export class SearchOrganizationDto {
  @ApiProperty({
    example: 'ACME',
    description: 'Search query (matches organization name)',
    required: false,
  })
  @IsString()
  @IsOptional()
  query?: string;

  @ApiProperty({
    example: 'acme.com',
    description: 'Email domain to match',
    required: false,
  })
  @IsString()
  @IsOptional()
  domain?: string;

  @ApiProperty({
    example: 10,
    description: 'Maximum number of results',
    default: 10,
    required: false,
  })
  @IsInt()
  @Min(1)
  @Max(50)
  @Type(() => Number)
  @IsOptional()
  limit?: number = 10;
}

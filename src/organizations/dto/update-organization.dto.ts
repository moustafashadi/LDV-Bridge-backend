import { ApiProperty } from '@nestjs/swagger';
import { IsString, IsNotEmpty, IsOptional, MinLength, MaxLength } from 'class-validator';

/**
 * DTO for updating organization details
 */
export class UpdateOrganizationDto {
  @ApiProperty({
    example: 'ACME Corporation',
    description: 'Organization name',
    required: false,
  })
  @IsString()
  @IsOptional()
  @MinLength(2)
  @MaxLength(100)
  name?: string;

  @ApiProperty({
    example: 'acme.com',
    description: 'Primary email domain',
    required: false,
  })
  @IsString()
  @IsOptional()
  domain?: string;

  @ApiProperty({
    example: { industry: 'technology', teamSize: '11-50', theme: 'dark' },
    description: 'Organization settings',
    required: false,
  })
  @IsOptional()
  settings?: Record<string, any>;
}

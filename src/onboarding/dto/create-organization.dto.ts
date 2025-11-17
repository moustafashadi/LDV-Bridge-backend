import { ApiProperty } from '@nestjs/swagger';
import { IsString, IsNotEmpty, IsOptional, IsEmail, MaxLength, MinLength } from 'class-validator';

/**
 * DTO for creating a new organization during signup
 */
export class CreateOrganizationDto {
  @ApiProperty({
    example: 'ACME Corporation',
    description: 'Organization name',
  })
  @IsString()
  @IsNotEmpty()
  @MinLength(2)
  @MaxLength(100)
  name: string;

  @ApiProperty({
    example: 'acme-corp',
    description: 'URL-friendly slug (auto-generated if not provided)',
    required: false,
  })
  @IsString()
  @IsOptional()
  @MinLength(2)
  @MaxLength(50)
  slug?: string;

  @ApiProperty({
    example: 'acme.com',
    description: 'Primary email domain for the organization',
    required: false,
  })
  @IsString()
  @IsOptional()
  domain?: string;

  @ApiProperty({
    example: { industry: 'technology', teamSize: '11-50' },
    description: 'Additional organization settings',
    required: false,
  })
  @IsOptional()
  settings?: Record<string, any>;
}

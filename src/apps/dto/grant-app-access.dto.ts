import { ApiProperty } from '@nestjs/swagger';
import { IsString, IsEnum, IsOptional, IsDateString, IsArray, ArrayMinSize } from 'class-validator';
import { AppAccessLevel } from '@prisma/client';

/**
 * DTO for granting app access to one or more users
 */
export class GrantAppAccessDto {
  @ApiProperty({
    description: 'User IDs to grant access to',
    example: ['user-uuid-1', 'user-uuid-2'],
    type: [String],
  })
  @IsArray()
  @ArrayMinSize(1)
  @IsString({ each: true })
  userIds: string[];

  @ApiProperty({
    enum: AppAccessLevel,
    example: AppAccessLevel.VIEWER,
    description: 'Access level to grant',
  })
  @IsEnum(AppAccessLevel)
  accessLevel: AppAccessLevel;

  @ApiProperty({
    example: '2025-12-31T23:59:59Z',
    description: 'Optional expiration date for access',
    required: false,
  })
  @IsDateString()
  @IsOptional()
  expiresAt?: string;
}

/**
 * DTO for updating app access level
 */
export class UpdateAppAccessDto {
  @ApiProperty({
    enum: AppAccessLevel,
    example: AppAccessLevel.EDITOR,
    description: 'New access level',
  })
  @IsEnum(AppAccessLevel)
  accessLevel: AppAccessLevel;

  @ApiProperty({
    example: '2025-12-31T23:59:59Z',
    description: 'Optional expiration date for access',
    required: false,
  })
  @IsDateString()
  @IsOptional()
  expiresAt?: string;
}

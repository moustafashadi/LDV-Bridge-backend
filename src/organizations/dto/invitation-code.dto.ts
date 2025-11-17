import { ApiProperty } from '@nestjs/swagger';
import { IsString, IsNotEmpty, IsOptional, IsEnum, IsInt, Min, Max, IsBoolean, IsDateString } from 'class-validator';
import { Type } from 'class-transformer';
import { UserRole } from '@prisma/client';

/**
 * DTO for creating an invitation code
 */
export class CreateInvitationCodeDto {
  @ApiProperty({
    enum: UserRole,
    example: UserRole.CITIZEN_DEVELOPER,
    description: 'Role that will be assigned to users who use this code',
  })
  @IsEnum(UserRole)
  role: UserRole;

  @ApiProperty({
    example: 10,
    description: 'Maximum number of times this code can be used (null = unlimited)',
    required: false,
  })
  @IsInt()
  @Min(1)
  @Max(1000)
  @Type(() => Number)
  @IsOptional()
  maxUses?: number;

  @ApiProperty({
    example: '2025-12-31T23:59:59Z',
    description: 'Expiration date (null = never expires)',
    required: false,
  })
  @IsDateString()
  @IsOptional()
  expiresAt?: string;
}

/**
 * DTO for updating an invitation code
 */
export class UpdateInvitationCodeDto {
  @ApiProperty({
    example: true,
    description: 'Whether the code is active',
    required: false,
  })
  @IsBoolean()
  @IsOptional()
  isActive?: boolean;

  @ApiProperty({
    example: '2025-12-31T23:59:59Z',
    description: 'New expiration date',
    required: false,
  })
  @IsDateString()
  @IsOptional()
  expiresAt?: string;
}

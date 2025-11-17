import { ApiProperty } from '@nestjs/swagger';
import { IsEnum, IsString, IsOptional, MaxLength } from 'class-validator';
import { UserRole } from '@prisma/client';

/**
 * DTO for approving a join request
 */
export class ApproveJoinRequestDto {
  @ApiProperty({
    enum: UserRole,
    example: UserRole.CITIZEN_DEVELOPER,
    description: 'Role to assign to the user (admin can override requested role)',
  })
  @IsEnum(UserRole)
  role: UserRole;
}

/**
 * DTO for rejecting a join request
 */
export class RejectJoinRequestDto {
  @ApiProperty({
    example: 'We are not accepting new members at this time.',
    description: 'Reason for rejection',
    required: false,
  })
  @IsString()
  @IsOptional()
  @MaxLength(500)
  reason?: string;
}

import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsEnum, IsOptional } from 'class-validator';
import { UserRole } from '@prisma/client';

export class UpdateUserRoleDto {
  @ApiProperty({ 
    description: 'New role to assign to the user',
    enum: UserRole,
    example: UserRole.PRO_DEVELOPER
  })
  @IsEnum(UserRole)
  role: UserRole;
}

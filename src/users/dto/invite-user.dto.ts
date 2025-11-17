import { ApiProperty } from '@nestjs/swagger';
import { IsEmail, IsEnum, IsOptional, IsString, MinLength } from 'class-validator';
import { UserRole } from '@prisma/client';

export class InviteUserDto {
  @ApiProperty({ 
    description: 'Email address of the user to invite',
    example: 'john.doe@example.com'
  })
  @IsEmail()
  email: string;

  @ApiProperty({ 
    description: 'Role to assign to the invited user',
    enum: UserRole,
    example: UserRole.CITIZEN_DEVELOPER
  })
  @IsEnum(UserRole)
  role: UserRole;

  @ApiProperty({ 
    description: 'Optional welcome message',
    required: false
  })
  @IsOptional()
  @IsString()
  message?: string;
}

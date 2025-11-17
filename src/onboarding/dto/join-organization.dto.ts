import { ApiProperty } from '@nestjs/swagger';
import { IsString, IsNotEmpty, IsOptional, IsEnum, MaxLength } from 'class-validator';
import { UserRole } from '@prisma/client';

/**
 * DTO for requesting to join an existing organization
 */
export class JoinOrganizationDto {
  @ApiProperty({
    example: '123e4567-e89b-12d3-a456-426614174000',
    description: 'ID of the organization to join',
  })
  @IsString()
  @IsNotEmpty()
  organizationId: string;

  @ApiProperty({
    enum: UserRole,
    example: UserRole.CITIZEN_DEVELOPER,
    description: 'Requested role',
  })
  @IsEnum(UserRole)
  requestedRole: UserRole;

  @ApiProperty({
    example: 'I am a developer in the IT department and would like access to build apps.',
    description: 'Message to organization admins',
    required: false,
  })
  @IsString()
  @IsOptional()
  @MaxLength(500)
  message?: string;
}

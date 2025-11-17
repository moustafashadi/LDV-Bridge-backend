import { ApiProperty } from '@nestjs/swagger';
import { UserRole, UserStatus } from '@prisma/client';

export class UserResponseDto {
  @ApiProperty()
  id: string;

  @ApiProperty()
  email: string;

  @ApiProperty({ required: false, nullable: true })
  name?: string | null;

  @ApiProperty({ required: false, nullable: true })
  displayName?: string | null;

  @ApiProperty({ required: false, nullable: true })
  avatarUrl?: string | null;

  @ApiProperty({ enum: UserStatus })
  role: UserRole;

  @ApiProperty({ enum: UserStatus })
  status: UserStatus;

  @ApiProperty()
  organizationId: string;

  @ApiProperty({ required: false, nullable: true })
  lastLoginAt?: Date | null;

  @ApiProperty()
  createdAt: Date;

  @ApiProperty()
  updatedAt: Date;
}

export class PaginatedUsersResponseDto {
  @ApiProperty({ type: [UserResponseDto] })
  data: UserResponseDto[];

  @ApiProperty({ description: 'Total number of users' })
  total: number;

  @ApiProperty({ description: 'Current page number' })
  page: number;

  @ApiProperty({ description: 'Items per page' })
  limit: number;

  @ApiProperty({ description: 'Total number of pages' })
  totalPages: number;
}

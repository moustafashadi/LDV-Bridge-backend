import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsEnum, IsOptional, IsString, IsInt, Min, Max } from 'class-validator';
import { Type } from 'class-transformer';
import { UserRole, UserStatus } from '@prisma/client';

export class ListUsersQueryDto {
  @ApiPropertyOptional({ 
    description: 'Page number (1-indexed)',
    example: 1,
    minimum: 1
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number = 1;

  @ApiPropertyOptional({ 
    description: 'Number of items per page',
    example: 50,
    minimum: 1,
    maximum: 100
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number = 50;

  @ApiPropertyOptional({ 
    description: 'Filter by user role',
    enum: UserRole
  })
  @IsOptional()
  @IsEnum(UserRole)
  role?: UserRole;

  @ApiPropertyOptional({ 
    description: 'Filter by user status',
    enum: UserStatus
  })
  @IsOptional()
  @IsEnum(UserStatus)
  status?: UserStatus;

  @ApiPropertyOptional({ 
    description: 'Search by email or display name',
    example: 'john'
  })
  @IsOptional()
  @IsString()
  search?: string;
}

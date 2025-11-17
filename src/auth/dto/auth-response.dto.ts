import { ApiProperty } from '@nestjs/swagger';
import { UserRole } from '@prisma/client';

export class AuthResponseDto {
  @ApiProperty({ description: 'User ID' })
  id: string;

  @ApiProperty({ description: 'User email' })
  email: string;

  @ApiProperty({ description: 'User role', enum: UserRole })
  role: UserRole;

  @ApiProperty({ description: 'Organization ID' })
  organizationId: string;

  @ApiProperty({ description: 'User name', required: false })
  name?: string;

  @ApiProperty({ description: 'Profile picture URL', required: false })
  picture?: string;
}

export class LoginResponseDto {
  @ApiProperty({ description: 'Access token' })
  accessToken: string;

  @ApiProperty({ description: 'Refresh token', required: false })
  refreshToken?: string;

  @ApiProperty({ description: 'Token type', example: 'Bearer' })
  tokenType: string;

  @ApiProperty({ description: 'Expires in seconds', example: 86400 })
  expiresIn: number;

  @ApiProperty({ description: 'User information', type: AuthResponseDto })
  user: AuthResponseDto;
}

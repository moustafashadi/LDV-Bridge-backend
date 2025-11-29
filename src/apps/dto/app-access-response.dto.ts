import { ApiProperty } from '@nestjs/swagger';

export class AppPermissionResponseDto {
  @ApiProperty()
  id: string;

  @ApiProperty()
  appId: string;

  @ApiProperty()
  userId: string;

  @ApiProperty({ enum: ['VIEWER', 'EDITOR', 'OWNER'] })
  accessLevel: string;

  @ApiProperty()
  grantedBy: string;

  @ApiProperty()
  grantedAt: Date;

  @ApiProperty({ required: false, nullable: true })
  expiresAt?: Date | null;

  @ApiProperty()
  createdAt: Date;

  @ApiProperty()
  updatedAt: Date;

  // Populated user info
  @ApiProperty({ required: false })
  user?: {
    id: string;
    email: string;
    name?: string | null;
    displayName?: string | null;
    role: string;
  };
}

export class UserAppAccessResponseDto {
  @ApiProperty()
  appId: string;

  @ApiProperty()
  appName: string;

  @ApiProperty()
  platform: string;

  @ApiProperty({ enum: ['VIEWER', 'EDITOR', 'OWNER'] })
  accessLevel: string;

  @ApiProperty()
  grantedAt: Date;

  @ApiProperty({ required: false, nullable: true })
  expiresAt?: Date | null;
}

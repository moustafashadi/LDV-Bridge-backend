import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString, IsUrl, IsObject, MinLength, MaxLength } from 'class-validator';

export class UpdateUserDto {
  @ApiPropertyOptional({ 
    description: 'User display name (public-facing)',
    example: 'John D.',
    minLength: 2,
    maxLength: 50
  })
  @IsOptional()
  @IsString()
  @MinLength(2)
  @MaxLength(50)
  displayName?: string;

  @ApiPropertyOptional({ 
    description: 'Avatar/profile picture URL',
    example: 'https://example.com/avatar.jpg'
  })
  @IsOptional()
  @IsUrl()
  avatarUrl?: string;

  @ApiPropertyOptional({ 
    description: 'User preferences and settings (JSON object)',
    example: { theme: 'dark', notifications: true }
  })
  @IsOptional()
  @IsObject()
  settings?: Record<string, any>;
}

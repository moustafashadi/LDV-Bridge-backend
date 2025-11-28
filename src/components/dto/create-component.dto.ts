import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsString,
  IsEnum,
  IsOptional,
  IsObject,
  IsUUID,
} from 'class-validator';
import { ComponentType } from '@prisma/client';

export class CreateComponentDto {
  @ApiProperty({
    description: 'App ID that this component belongs to',
    example: '123e4567-e89b-12d3-a456-426614174000',
  })
  @IsUUID()
  appId: string;

  @ApiPropertyOptional({
    description: 'External component ID from the platform',
    example: 'screen_login_001',
  })
  @IsOptional()
  @IsString()
  externalId?: string;

  @ApiProperty({
    description: 'Component name',
    example: 'Login Screen',
  })
  @IsString()
  name: string;

  @ApiProperty({
    description: 'Component type',
    enum: ComponentType,
    example: 'SCREEN',
  })
  @IsEnum(ComponentType)
  type: ComponentType;

  @ApiPropertyOptional({
    description: 'Component path in app hierarchy',
    example: '/screens/auth/login',
  })
  @IsOptional()
  @IsString()
  path?: string;

  @ApiPropertyOptional({
    description: 'Component properties (JSON object)',
    example: {
      width: 1024,
      height: 768,
      backgroundColor: '#ffffff',
    },
  })
  @IsOptional()
  @IsObject()
  properties?: Record<string, any>;

  @ApiPropertyOptional({
    description: 'Component code block (PowerFx, microflow XML, etc.)',
    example: 'Navigate(HomeScreen, ScreenTransition.Fade)',
  })
  @IsOptional()
  @IsString()
  codeBlock?: string;

  @ApiPropertyOptional({
    description: 'Component metadata including version, tags, dependencies',
    example: {
      version: '1.0.0',
      isReusable: true,
      tags: ['authentication', 'login'],
      dependencies: [],
      description: 'User login screen with SSO support',
    },
  })
  @IsOptional()
  @IsObject()
  metadata?: {
    version?: string;
    isReusable?: boolean;
    tags?: string[];
    dependencies?: string[];
    description?: string;
    [key: string]: any;
  };
}

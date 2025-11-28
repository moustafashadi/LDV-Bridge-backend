import { ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsString,
  IsEnum,
  IsOptional,
  IsObject,
} from 'class-validator';
import { ComponentType } from '@prisma/client';

export class UpdateComponentDto {
  @ApiPropertyOptional({
    description: 'Component name',
    example: 'Login Screen v2',
  })
  @IsOptional()
  @IsString()
  name?: string;

  @ApiPropertyOptional({
    description: 'Component type',
    enum: ComponentType,
    example: 'SCREEN',
  })
  @IsOptional()
  @IsEnum(ComponentType)
  type?: ComponentType;

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
      width: 1280,
      height: 720,
    },
  })
  @IsOptional()
  @IsObject()
  properties?: Record<string, any>;

  @ApiPropertyOptional({
    description: 'Component code block',
    example: 'Navigate(HomeScreen, ScreenTransition.Slide)',
  })
  @IsOptional()
  @IsString()
  codeBlock?: string;

  @ApiPropertyOptional({
    description: 'Component metadata',
    example: {
      version: '1.1.0',
      isReusable: true,
      tags: ['authentication', 'login', 'sso'],
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

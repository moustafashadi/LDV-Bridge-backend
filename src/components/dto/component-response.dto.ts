import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { ComponentType } from '@prisma/client';

export class ComponentResponseDto {
  @ApiProperty({
    description: 'Component ID',
    example: '123e4567-e89b-12d3-a456-426614174000',
  })
  id: string;

  @ApiProperty({
    description: 'App ID',
    example: '123e4567-e89b-12d3-a456-426614174000',
  })
  appId: string;

  @ApiProperty({
    description: 'App name',
    example: 'My PowerApp',
  })
  appName: string;

  @ApiPropertyOptional({
    description: 'External component ID from platform',
    example: 'screen_login_001',
  })
  externalId?: string;

  @ApiProperty({
    description: 'Component name',
    example: 'Login Screen',
  })
  name: string;

  @ApiProperty({
    description: 'Component type',
    enum: ComponentType,
    example: 'SCREEN',
  })
  type: ComponentType;

  @ApiPropertyOptional({
    description: 'Component path',
    example: '/screens/auth/login',
  })
  path?: string;

  @ApiPropertyOptional({
    description: 'Component properties',
  })
  properties?: Record<string, any>;

  @ApiPropertyOptional({
    description: 'Component code block',
  })
  codeBlock?: string;

  @ApiPropertyOptional({
    description: 'Component metadata',
  })
  metadata?: {
    version?: string;
    isReusable?: boolean;
    tags?: string[];
    dependencies?: string[];
    description?: string;
    [key: string]: any;
  };

  @ApiProperty({
    description: 'Created timestamp',
  })
  createdAt: Date;

  @ApiProperty({
    description: 'Updated timestamp',
  })
  updatedAt: Date;

  // Helper properties extracted from metadata
  @ApiPropertyOptional({
    description: 'Component version (from metadata)',
    example: '1.0.0',
  })
  version?: string;

  @ApiPropertyOptional({
    description: 'Is reusable component (from metadata)',
    example: true,
  })
  isReusable?: boolean;

  @ApiPropertyOptional({
    description: 'Component tags (from metadata)',
    example: ['authentication', 'login'],
  })
  tags?: string[];
}

export class PaginationMetaDto {
  @ApiProperty({
    description: 'Total number of records',
    example: 150,
  })
  total: number;

  @ApiProperty({
    description: 'Current page number',
    example: 1,
  })
  page: number;

  @ApiProperty({
    description: 'Records per page',
    example: 20,
  })
  limit: number;

  @ApiProperty({
    description: 'Total number of pages',
    example: 8,
  })
  totalPages: number;

  @ApiProperty({
    description: 'Whether there are more pages',
    example: true,
  })
  hasMore: boolean;
}

export class ComponentListResponseDto {
  @ApiProperty({
    description: 'List of components',
    type: [ComponentResponseDto],
  })
  data: ComponentResponseDto[];

  @ApiProperty({
    description: 'Pagination metadata',
  })
  pagination: PaginationMetaDto;
}

export class ExtractComponentsResponseDto {
  @ApiProperty({
    description: 'Success status',
    example: true,
  })
  success: boolean;

  @ApiProperty({
    description: 'Response message',
    example: 'Extracted 42 components from app',
  })
  message: string;

  @ApiProperty({
    description: 'Number of components extracted',
    example: 42,
  })
  componentsExtracted: number;

  @ApiProperty({
    description: 'App ID',
    example: '123e4567-e89b-12d3-a456-426614174000',
  })
  appId: string;

  @ApiProperty({
    description: 'App name',
    example: 'My PowerApp',
  })
  appName: string;
}

import {
  IsString,
  IsOptional,
  IsEnum,
  IsUUID,
  IsObject,
  MinLength,
  MaxLength,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { ChangeType } from '@prisma/client';

export class CreateChangeDto {
  @ApiProperty({
    description: 'ID of the app this change belongs to',
    example: '123e4567-e89b-12d3-a456-426614174000',
  })
  @IsUUID()
  appId: string;

  @ApiProperty({
    description: 'Change title',
    example: 'Updated login screen formula',
    minLength: 3,
    maxLength: 255,
  })
  @IsString()
  @MinLength(3)
  @MaxLength(255)
  title: string;

  @ApiPropertyOptional({
    description: 'Detailed description of the change',
    example: 'Modified the authentication logic to support multi-factor authentication',
  })
  @IsOptional()
  @IsString()
  description?: string;

  @ApiProperty({
    description: 'Type of change',
    enum: ChangeType,
    example: ChangeType.UPDATE,
  })
  @IsEnum(ChangeType)
  changeType: ChangeType;

  @ApiPropertyOptional({
    description: 'App metadata before the change (JSON)',
    example: { screens: ['Home', 'Login'], formulas: ['CalculateTotal'] },
  })
  @IsOptional()
  @IsObject()
  beforeMetadata?: any;

  @ApiPropertyOptional({
    description: 'App metadata after the change (JSON)',
    example: {
      screens: ['Home', 'Login', 'Dashboard'],
      formulas: ['CalculateTotal', 'ValidateUser'],
    },
  })
  @IsOptional()
  @IsObject()
  afterMetadata?: any;

  @ApiPropertyOptional({
    description: 'Code/formula before the change',
    example: 'Sum(Items, Price)',
  })
  @IsOptional()
  @IsString()
  beforeCode?: string;

  @ApiPropertyOptional({
    description: 'Code/formula after the change',
    example: 'Sum(Items, Price * Quantity)',
  })
  @IsOptional()
  @IsString()
  afterCode?: string;
}

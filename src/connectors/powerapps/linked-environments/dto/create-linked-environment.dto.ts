import {
  IsEnum,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUrl,
  MaxLength,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export enum LinkedEnvironmentPlatform {
  POWERAPPS = 'POWERAPPS',
}

export class CreateLinkedEnvironmentDto {
  @ApiProperty({
    description: 'Display name for this environment in LDV-Bridge',
    example: 'Production Environment',
  })
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  name: string;

  @ApiPropertyOptional({
    description: 'Description of the environment',
    example: 'Main production PowerApps environment',
  })
  @IsString()
  @IsOptional()
  @MaxLength(500)
  description?: string;

  @ApiProperty({
    description: 'Platform type (currently PowerApps only)',
    enum: LinkedEnvironmentPlatform,
    example: LinkedEnvironmentPlatform.POWERAPPS,
  })
  @IsEnum(LinkedEnvironmentPlatform)
  platform: LinkedEnvironmentPlatform;

  @ApiProperty({
    description: 'External environment ID from the platform',
    example: 'Default-12345-abcd-efgh-ijkl-mnopqrstuvwx',
  })
  @IsString()
  @IsNotEmpty()
  environmentId: string;

  @ApiPropertyOptional({
    description: 'Environment URL (Dataverse instance URL)',
    example: 'https://org12345.crm4.dynamics.com/',
  })
  @IsString()
  @IsOptional()
  @IsUrl({}, { message: 'environmentUrl must be a valid URL' })
  environmentUrl?: string;

  @ApiPropertyOptional({
    description: 'Region where the environment is hosted',
    example: 'europe',
  })
  @IsString()
  @IsOptional()
  @MaxLength(50)
  region?: string;
}

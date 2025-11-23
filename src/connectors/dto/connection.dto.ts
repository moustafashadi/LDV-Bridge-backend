import { IsString, IsEnum, IsOptional, IsObject } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';
import { PlatformType } from '../interfaces/base-connector.interface';

export class InitiateConnectionDto {
  @ApiProperty({
    description: 'Platform type to connect to',
    enum: PlatformType,
    example: PlatformType.POWERAPPS,
  })
  @IsEnum(PlatformType)
  platform: PlatformType;

  @ApiProperty({
    description: 'Optional additional parameters for OAuth flow',
    required: false,
  })
  @IsOptional()
  @IsObject()
  additionalParams?: Record<string, string>;
}

export class CompleteConnectionDto {
  @ApiProperty({
    description: 'Authorization code from OAuth provider',
    example: 'abc123xyz',
  })
  @IsString()
  code: string;

  @ApiProperty({
    description: 'State parameter for verification',
    example: 'base64encodedstate',
  })
  @IsString()
  state: string;
}

export class TestConnectionDto {
  @ApiProperty({
    description: 'Platform type to test',
    enum: PlatformType,
    example: PlatformType.POWERAPPS,
  })
  @IsEnum(PlatformType)
  platform: PlatformType;
}

export class DisconnectDto {
  @ApiProperty({
    description: 'Platform to disconnect from',
    enum: PlatformType,
    example: PlatformType.POWERAPPS,
  })
  @IsEnum(PlatformType)
  platform: PlatformType;
}

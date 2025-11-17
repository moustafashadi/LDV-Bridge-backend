import { ApiProperty } from '@nestjs/swagger';
import { IsString, IsOptional, ValidateNested, IsEnum } from 'class-validator';
import { Type } from 'class-transformer';
import { CreateOrganizationDto } from './create-organization.dto';
import { JoinOrganizationDto } from './join-organization.dto';

/**
 * Onboarding flow type
 */
export enum OnboardingFlow {
  CREATE_ORG = 'create_org',      // Create new organization (user becomes admin)
  JOIN_ORG = 'join_org',          // Join existing org (needs approval)
  USE_CODE = 'use_code',          // Use invitation code (auto-approved)
}

/**
 * DTO for completing the onboarding process
 */
export class CompleteOnboardingDto {
  @ApiProperty({
    enum: OnboardingFlow,
    example: OnboardingFlow.CREATE_ORG,
    description: 'Type of onboarding flow',
  })
  @IsEnum(OnboardingFlow)
  flow: OnboardingFlow;

  @ApiProperty({
    example: 'user@example.com',
    description: 'User email address (required for creating account)',
  })
  @IsString()
  email: string;

  @ApiProperty({
    example: 'John Doe',
    description: 'User full name (optional)',
    required: false,
  })
  @IsString()
  @IsOptional()
  name?: string;

  @ApiProperty({
    type: CreateOrganizationDto,
    description: 'Organization details (required if flow is CREATE_ORG)',
    required: false,
  })
  @ValidateNested()
  @Type(() => CreateOrganizationDto)
  @IsOptional()
  createOrg?: CreateOrganizationDto;

  @ApiProperty({
    type: JoinOrganizationDto,
    description: 'Join request details (required if flow is JOIN_ORG)',
    required: false,
  })
  @ValidateNested()
  @Type(() => JoinOrganizationDto)
  @IsOptional()
  joinOrg?: JoinOrganizationDto;

  @ApiProperty({
    example: 'ORG-ACME-A7X2Q',
    description: 'Invitation code (required if flow is USE_CODE)',
    required: false,
  })
  @IsString()
  @IsOptional()
  invitationCode?: string;
}

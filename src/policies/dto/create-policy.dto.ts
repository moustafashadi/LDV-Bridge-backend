import { ApiProperty } from '@nestjs/swagger';
import { IsString, IsNotEmpty, IsOptional, IsBoolean, IsObject } from 'class-validator';

/**
 * DTO for creating a new policy
 */
export class CreatePolicyDto {
  @ApiProperty({ 
    description: 'Policy name', 
    example: 'Require Code Review for Production Changes' 
  })
  @IsString()
  @IsNotEmpty()
  name: string;

  @ApiProperty({ 
    description: 'Policy description', 
    example: 'All changes to production apps must be reviewed by at least 2 pro developers',
    required: false 
  })
  @IsString()
  @IsOptional()
  description?: string;

  @ApiProperty({ 
    description: 'Policy rules in JSON format', 
    example: {
      conditions: [
        { field: 'environment', operator: 'equals', value: 'production' }
      ],
      actions: [
        { type: 'require_review', minimumReviewers: 2, requiredRoles: ['PRO_DEVELOPER'] }
      ]
    }
  })
  @IsObject()
  @IsNotEmpty()
  rules: Record<string, any>;

  @ApiProperty({ 
    description: 'Policy scope (app, team, organization)', 
    example: 'organization',
    required: false 
  })
  @IsString()
  @IsOptional()
  scope?: string;

  @ApiProperty({ 
    description: 'Whether policy is active', 
    example: true,
    default: true 
  })
  @IsBoolean()
  @IsOptional()
  isActive?: boolean;
}

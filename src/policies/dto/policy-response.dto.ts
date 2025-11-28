import { ApiProperty } from '@nestjs/swagger';

/**
 * Response DTO for policy operations
 */
export class PolicyResponseDto {
  @ApiProperty({ description: 'Policy ID' })
  id: string;

  @ApiProperty({ description: 'Organization ID' })
  organizationId: string;

  @ApiProperty({ description: 'Policy name' })
  name: string;

  @ApiProperty({ description: 'Policy description', required: false })
  description?: string | null;

  @ApiProperty({ description: 'Policy rules in JSON format' })
  rules: Record<string, any>;

  @ApiProperty({ description: 'Whether policy is active' })
  isActive: boolean;

  @ApiProperty({ description: 'Policy scope', required: false })
  scope?: string | null;

  @ApiProperty({ description: 'Creation timestamp' })
  createdAt: Date;

  @ApiProperty({ description: 'Last update timestamp' })
  updatedAt: Date;
}

/**
 * Response DTO for policy evaluation
 */
export class PolicyEvaluationResultDto {
  @ApiProperty({ description: 'Policy ID' })
  policyId: string;

  @ApiProperty({ description: 'Policy name' })
  policyName: string;

  @ApiProperty({ description: 'Whether the evaluation passed' })
  passed: boolean;

  @ApiProperty({ description: 'Violations found', type: [String] })
  violations: string[];

  @ApiProperty({ description: 'Actions required', type: [String] })
  requiredActions: string[];

  @ApiProperty({ description: 'Evaluation timestamp' })
  evaluatedAt: Date;
}

/**
 * Request DTO for evaluating policies
 */
export class EvaluatePolicyDto {
  @ApiProperty({ 
    description: 'Context data for policy evaluation', 
    example: {
      appId: 'abc-123',
      environment: 'production',
      changeType: 'update',
      userId: 'user-456'
    }
  })
  context: Record<string, any>;
}

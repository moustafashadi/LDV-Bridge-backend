import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsString,
  IsEnum,
  IsOptional,
  IsArray,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';

/**
 * Individual check result from CI/CD pipeline.
 */
export class PipelineCheckResult {
  @ApiProperty({ description: 'Name of the check (e.g., "schema-validation")' })
  @IsString()
  name: string;

  @ApiProperty({
    enum: ['passed', 'failed', 'skipped'],
    description: 'Check result status',
  })
  @IsEnum(['passed', 'failed', 'skipped'])
  status: 'passed' | 'failed' | 'skipped';

  @ApiPropertyOptional({
    description: 'Detailed message about the check result',
  })
  @IsString()
  @IsOptional()
  message?: string;

  @ApiPropertyOptional({ description: 'Duration in seconds' })
  @IsOptional()
  duration?: number;
}

/**
 * DTO for pipeline webhook callback payload.
 * Sent by GitHub Actions workflow to report validation results.
 */
export class PipelineWebhookDto {
  @ApiProperty({ description: 'LDV-Bridge Change ID' })
  @IsString()
  changeId: string;

  @ApiProperty({
    enum: ['pending', 'running', 'passed', 'failed'],
    description: 'Overall pipeline status',
  })
  @IsEnum(['pending', 'running', 'passed', 'failed'])
  status: 'pending' | 'running' | 'passed' | 'failed';

  @ApiPropertyOptional({ description: 'GitHub Actions run ID' })
  @IsString()
  @IsOptional()
  runId?: string;

  @ApiPropertyOptional({ description: 'URL to the GitHub Actions run' })
  @IsString()
  @IsOptional()
  runUrl?: string;

  @ApiPropertyOptional({
    type: [PipelineCheckResult],
    description: 'Individual check results',
  })
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => PipelineCheckResult)
  @IsOptional()
  checks?: PipelineCheckResult[];

  @ApiPropertyOptional({ description: 'Full log output from pipeline' })
  @IsString()
  @IsOptional()
  logs?: string;
}

/**
 * DTO for triggering a new pipeline run.
 */
export class TriggerPipelineDto {
  @ApiProperty({ description: 'Change ID to validate' })
  @IsString()
  changeId: string;

  @ApiProperty({ description: 'Sandbox ID containing the change' })
  @IsString()
  sandboxId: string;
}

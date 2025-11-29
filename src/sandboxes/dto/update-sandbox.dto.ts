import { PartialType } from '@nestjs/swagger';
import { CreateSandboxDto } from './create-sandbox.dto';
import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsEnum, IsOptional } from 'class-validator';
import { SandboxStatus } from '../interfaces/sandbox-environment.interface';

/**
 * DTO for updating an existing sandbox
 * All fields from CreateSandboxDto are optional, plus status
 */
export class UpdateSandboxDto extends PartialType(CreateSandboxDto) {
  @ApiPropertyOptional({
    description: 'Update sandbox status',
    enum: SandboxStatus,
    example: SandboxStatus.SUSPENDED,
  })
  @IsEnum(SandboxStatus)
  @IsOptional()
  status?: SandboxStatus;
}

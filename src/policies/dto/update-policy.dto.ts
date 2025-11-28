import { PartialType } from '@nestjs/swagger';
import { CreatePolicyDto } from './create-policy.dto';

/**
 * DTO for updating an existing policy
 * All fields from CreatePolicyDto are optional
 */
export class UpdatePolicyDto extends PartialType(CreatePolicyDto) {}

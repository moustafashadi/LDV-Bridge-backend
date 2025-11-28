import { Injectable, Logger, NotFoundException, BadRequestException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { CreatePolicyDto } from './dto/create-policy.dto';
import { UpdatePolicyDto } from './dto/update-policy.dto';
import { PolicyResponseDto } from './dto/policy-response.dto';
import { Policy, Prisma } from '@prisma/client';

/**
 * Policy Service
 * Handles CRUD operations for governance policies
 */
@Injectable()
export class PoliciesService {
  private readonly logger = new Logger(PoliciesService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Convert Prisma Policy entity to PolicyResponseDto
   */
  private mapToResponseDto(policy: Policy): PolicyResponseDto {
    // Safely convert JsonValue to Record<string, any>
    // Prisma's JsonValue can be object, array, string, number, boolean, or null
    // For policy rules, we expect it to always be an object
    const rules = policy.rules as Record<string, any>;
    
    return {
      id: policy.id,
      organizationId: policy.organizationId,
      name: policy.name,
      description: policy.description,
      rules,
      isActive: policy.isActive,
      scope: policy.scope,
      createdAt: policy.createdAt,
      updatedAt: policy.updatedAt,
    };
  }

  /**
   * Create a new policy
   */
  async create(
    userId: string,
    organizationId: string,
    createPolicyDto: CreatePolicyDto,
  ): Promise<PolicyResponseDto> {
    this.logger.log(`Creating policy "${createPolicyDto.name}" for organization ${organizationId}`);

    try {
      // Validate rules structure
      this.validatePolicyRules(createPolicyDto.rules);

      const policy = await this.prisma.policy.create({
        data: {
          organizationId,
          name: createPolicyDto.name,
          description: createPolicyDto.description,
          rules: createPolicyDto.rules,
          scope: createPolicyDto.scope || 'organization',
          isActive: createPolicyDto.isActive ?? true,
        },
      });

      this.logger.log(`Policy created: ${policy.id}`);
      return this.mapToResponseDto(policy);
    } catch (error) {
      this.logger.error(`Failed to create policy: ${error.message}`);
      throw error;
    }
  }

  /**
   * Get all policies for an organization
   */
  async findAll(organizationId: string, activeOnly: boolean = false): Promise<PolicyResponseDto[]> {
    this.logger.log(`Fetching policies for organization ${organizationId} (activeOnly: ${activeOnly})`);

    const where: any = { organizationId };
    if (activeOnly) {
      where.isActive = true;
    }

    const policies = await this.prisma.policy.findMany({
      where,
      orderBy: { createdAt: 'desc' },
    });

    return policies.map(policy => this.mapToResponseDto(policy));
  }

  /**
   * Get a specific policy by ID
   */
  async findOne(policyId: string, organizationId: string): Promise<PolicyResponseDto> {
    this.logger.log(`Fetching policy ${policyId} for organization ${organizationId}`);

    const policy = await this.prisma.policy.findFirst({
      where: {
        id: policyId,
        organizationId,
      },
    });

    if (!policy) {
      throw new NotFoundException(`Policy ${policyId} not found`);
    }

    return this.mapToResponseDto(policy);
  }

  /**
   * Update a policy
   */
  async update(
    policyId: string,
    organizationId: string,
    updatePolicyDto: UpdatePolicyDto,
  ): Promise<PolicyResponseDto> {
    this.logger.log(`Updating policy ${policyId} for organization ${organizationId}`);

    // Verify policy exists and belongs to organization
    await this.findOne(policyId, organizationId);

    try {
      // Validate rules if provided
      if (updatePolicyDto.rules) {
        this.validatePolicyRules(updatePolicyDto.rules);
      }

      const policy = await this.prisma.policy.update({
        where: { id: policyId },
        data: {
          name: updatePolicyDto.name,
          description: updatePolicyDto.description,
          rules: updatePolicyDto.rules,
          scope: updatePolicyDto.scope,
          isActive: updatePolicyDto.isActive,
        },
      });

      this.logger.log(`Policy updated: ${policy.id}`);
      return this.mapToResponseDto(policy);
    } catch (error) {
      this.logger.error(`Failed to update policy: ${error.message}`);
      throw error;
    }
  }

  /**
   * Delete a policy (soft delete by setting isActive = false)
   */
  async remove(policyId: string, organizationId: string): Promise<void> {
    this.logger.log(`Removing policy ${policyId} for organization ${organizationId}`);

    // Verify policy exists and belongs to organization
    await this.findOne(policyId, organizationId);

    await this.prisma.policy.update({
      where: { id: policyId },
      data: { isActive: false },
    });

    this.logger.log(`Policy removed (soft delete): ${policyId}`);
  }

  /**
   * Hard delete a policy (permanent)
   */
  async hardDelete(policyId: string, organizationId: string): Promise<void> {
    this.logger.log(`Hard deleting policy ${policyId} for organization ${organizationId}`);

    // Verify policy exists and belongs to organization
    await this.findOne(policyId, organizationId);

    await this.prisma.policy.delete({
      where: { id: policyId },
    });

    this.logger.log(`Policy permanently deleted: ${policyId}`);
  }

  /**
   * Activate or deactivate a policy
   */
  async setActive(policyId: string, organizationId: string, isActive: boolean): Promise<PolicyResponseDto> {
    this.logger.log(`Setting policy ${policyId} active status to ${isActive}`);

    // Verify policy exists and belongs to organization
    await this.findOne(policyId, organizationId);

    const policy = await this.prisma.policy.update({
      where: { id: policyId },
      data: { isActive },
    });

    return this.mapToResponseDto(policy);
  }

  /**
   * Validate policy rules structure
   * Basic validation - will be enhanced by policy engine
   */
  private validatePolicyRules(rules: Record<string, any>): void {
    if (!rules || typeof rules !== 'object') {
      throw new BadRequestException('Policy rules must be a valid JSON object');
    }

    // Check for required fields
    if (!rules.conditions || !Array.isArray(rules.conditions)) {
      throw new BadRequestException('Policy rules must include "conditions" array');
    }

    if (!rules.actions || !Array.isArray(rules.actions)) {
      throw new BadRequestException('Policy rules must include "actions" array');
    }

    // Validate conditions structure
    for (const condition of rules.conditions) {
      if (!condition.field || !condition.operator) {
        throw new BadRequestException('Each condition must have "field" and "operator"');
      }
    }

    // Validate actions structure
    for (const action of rules.actions) {
      if (!action.type) {
        throw new BadRequestException('Each action must have "type"');
      }
    }
  }
}

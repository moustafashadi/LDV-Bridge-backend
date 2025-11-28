import {
  Controller,
  Get,
  Post,
  Body,
  Patch,
  Param,
  Delete,
  Query,
  HttpCode,
  HttpStatus,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiBearerAuth,
  ApiQuery,
  ApiParam,
} from '@nestjs/swagger';
import { PoliciesService } from './policies.service';
import { CreatePolicyDto } from './dto/create-policy.dto';
import { UpdatePolicyDto } from './dto/update-policy.dto';
import { PolicyResponseDto } from './dto/policy-response.dto';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { Roles } from '../auth/decorators/roles.decorator';
import type { AuthenticatedUser } from '../auth/interfaces/authenticated-user.interface';

/**
 * Policy Controller
 * Manages governance policies for organizations
 */
@ApiTags('Policies')
@ApiBearerAuth()
@Controller('policies')
export class PoliciesController {
  private readonly logger = new Logger(PoliciesController.name);

  constructor(private readonly policiesService: PoliciesService) {}

  @Post()
  @Roles('ADMIN', 'PRO_DEVELOPER')
  @ApiOperation({ summary: 'Create a new policy' })
  @ApiResponse({ 
    status: 201, 
    description: 'Policy created successfully',
    type: PolicyResponseDto 
  })
  @ApiResponse({ status: 400, description: 'Invalid policy rules' })
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  @ApiResponse({ status: 403, description: 'Forbidden - Admin or Pro Developer role required' })
  async create(
    @CurrentUser() user: AuthenticatedUser,
    @Body() createPolicyDto: CreatePolicyDto,
  ): Promise<PolicyResponseDto> {
    if (!user.id || !user.organizationId) {
      throw new UnauthorizedException('User must complete onboarding before managing policies');
    }

    this.logger.log(`User ${user.id} creating policy for organization ${user.organizationId}`);

    return this.policiesService.create(user.id, user.organizationId, createPolicyDto);
  }

  @Get()
  @ApiOperation({ summary: 'Get all policies for the organization' })
  @ApiQuery({ 
    name: 'activeOnly', 
    required: false, 
    type: Boolean, 
    description: 'Filter to only active policies' 
  })
  @ApiResponse({ 
    status: 200, 
    description: 'Policies retrieved successfully',
    type: [PolicyResponseDto] 
  })
  async findAll(
    @CurrentUser() user: AuthenticatedUser,
    @Query('activeOnly') activeOnly?: string,
  ): Promise<PolicyResponseDto[]> {
    if (!user.id || !user.organizationId) {
      throw new UnauthorizedException('User must complete onboarding before accessing policies');
    }

    this.logger.log(`User ${user.id} fetching policies for organization ${user.organizationId}`);

    const active = activeOnly === 'true';
    return this.policiesService.findAll(user.organizationId, active);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get a specific policy by ID' })
  @ApiParam({ name: 'id', description: 'Policy ID' })
  @ApiResponse({ 
    status: 200, 
    description: 'Policy retrieved successfully',
    type: PolicyResponseDto 
  })
  @ApiResponse({ status: 404, description: 'Policy not found' })
  async findOne(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
  ): Promise<PolicyResponseDto> {
    if (!user.id || !user.organizationId) {
      throw new UnauthorizedException('User must complete onboarding before accessing policies');
    }

    this.logger.log(`User ${user.id} fetching policy ${id}`);

    return this.policiesService.findOne(id, user.organizationId);
  }

  @Patch(':id')
  @Roles('ADMIN', 'PRO_DEVELOPER')
  @ApiOperation({ summary: 'Update a policy' })
  @ApiParam({ name: 'id', description: 'Policy ID' })
  @ApiResponse({ 
    status: 200, 
    description: 'Policy updated successfully',
    type: PolicyResponseDto 
  })
  @ApiResponse({ status: 400, description: 'Invalid policy rules' })
  @ApiResponse({ status: 404, description: 'Policy not found' })
  @ApiResponse({ status: 403, description: 'Forbidden - Admin or Pro Developer role required' })
  async update(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Body() updatePolicyDto: UpdatePolicyDto,
  ): Promise<PolicyResponseDto> {
    if (!user.id || !user.organizationId) {
      throw new UnauthorizedException('User must complete onboarding before managing policies');
    }

    this.logger.log(`User ${user.id} updating policy ${id}`);

    return this.policiesService.update(id, user.organizationId, updatePolicyDto);
  }

  @Delete(':id')
  @Roles('ADMIN')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Soft delete a policy (set isActive = false)' })
  @ApiParam({ name: 'id', description: 'Policy ID' })
  @ApiResponse({ status: 204, description: 'Policy deleted successfully' })
  @ApiResponse({ status: 404, description: 'Policy not found' })
  @ApiResponse({ status: 403, description: 'Forbidden - Admin role required' })
  async remove(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
  ): Promise<void> {
    if (!user.id || !user.organizationId) {
      throw new UnauthorizedException('User must complete onboarding before managing policies');
    }

    this.logger.log(`User ${user.id} removing policy ${id}`);

    await this.policiesService.remove(id, user.organizationId);
  }

  @Delete(':id/hard')
  @Roles('ADMIN')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Permanently delete a policy (cannot be undone)' })
  @ApiParam({ name: 'id', description: 'Policy ID' })
  @ApiResponse({ status: 204, description: 'Policy permanently deleted' })
  @ApiResponse({ status: 404, description: 'Policy not found' })
  @ApiResponse({ status: 403, description: 'Forbidden - Admin role required' })
  async hardDelete(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
  ): Promise<void> {
    if (!user.id || !user.organizationId) {
      throw new UnauthorizedException('User must complete onboarding before managing policies');
    }

    this.logger.log(`User ${user.id} hard deleting policy ${id}`);

    await this.policiesService.hardDelete(id, user.organizationId);
  }

  @Patch(':id/activate')
  @Roles('ADMIN', 'PRO_DEVELOPER')
  @ApiOperation({ summary: 'Activate a policy' })
  @ApiParam({ name: 'id', description: 'Policy ID' })
  @ApiResponse({ 
    status: 200, 
    description: 'Policy activated successfully',
    type: PolicyResponseDto 
  })
  @ApiResponse({ status: 404, description: 'Policy not found' })
  async activate(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
  ): Promise<PolicyResponseDto> {
    if (!user.id || !user.organizationId) {
      throw new UnauthorizedException('User must complete onboarding before managing policies');
    }

    this.logger.log(`User ${user.id} activating policy ${id}`);

    return this.policiesService.setActive(id, user.organizationId, true);
  }

  @Patch(':id/deactivate')
  @Roles('ADMIN', 'PRO_DEVELOPER')
  @ApiOperation({ summary: 'Deactivate a policy' })
  @ApiParam({ name: 'id', description: 'Policy ID' })
  @ApiResponse({ 
    status: 200, 
    description: 'Policy deactivated successfully',
    type: PolicyResponseDto 
  })
  @ApiResponse({ status: 404, description: 'Policy not found' })
  async deactivate(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
  ): Promise<PolicyResponseDto> {
    if (!user.id || !user.organizationId) {
      throw new UnauthorizedException('User must complete onboarding before managing policies');
    }

    this.logger.log(`User ${user.id} deactivating policy ${id}`);

    return this.policiesService.setActive(id, user.organizationId, false);
  }
}

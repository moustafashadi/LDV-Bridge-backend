import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Body,
  Param,
  UseGuards,
} from '@nestjs/common';
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiBearerAuth,
} from '@nestjs/swagger';
import { OrganizationsService } from './organizations.service';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { OnboardedGuard } from '../auth/guards/onboarded.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { UserRole } from '@prisma/client';
import {
  UpdateOrganizationDto,
  ApproveJoinRequestDto,
  RejectJoinRequestDto,
  CreateInvitationCodeDto,
  UpdateInvitationCodeDto,
} from './dto';

/**
 * Organizations Controller
 * Manages organizations, join requests, and invitation codes
 */
@ApiTags('Organizations')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, OnboardedGuard, RolesGuard)
@Controller('organizations')
export class OrganizationsController {
  constructor(private readonly organizationsService: OrganizationsService) {}

  // ========================================
  // ORGANIZATION CRUD
  // ========================================

  @Get(':id')
  @ApiOperation({ summary: 'Get organization details' })
  @ApiResponse({ status: 200, description: 'Organization retrieved successfully' })
  @ApiResponse({ status: 403, description: 'Access denied' })
  @ApiResponse({ status: 404, description: 'Organization not found' })
  async getOrganization(
    @Param('id') id: string,
    @CurrentUser() user: any,
  ) {
    return this.organizationsService.findOne(id, user.id);
  }

  @Patch(':id')
  @Roles(UserRole.ADMIN)
  @ApiOperation({ summary: 'Update organization details (admin only)' })
  @ApiResponse({ status: 200, description: 'Organization updated successfully' })
  @ApiResponse({ status: 403, description: 'Admin access required' })
  async updateOrganization(
    @Param('id') id: string,
    @CurrentUser() user: any,
    @Body() dto: UpdateOrganizationDto,
  ) {
    return this.organizationsService.update(id, user.id, dto);
  }

  @Get(':id/stats')
  @ApiOperation({ summary: 'Get organization statistics' })
  @ApiResponse({ status: 200, description: 'Stats retrieved successfully' })
  async getOrganizationStats(
    @Param('id') id: string,
    @CurrentUser() user: any,
  ) {
    return this.organizationsService.getStats(id, user.id);
  }

  // ========================================
  // JOIN REQUESTS MANAGEMENT
  // ========================================

  @Get(':id/join-requests')
  @Roles(UserRole.ADMIN)
  @ApiOperation({ summary: 'Get pending join requests (admin only)' })
  @ApiResponse({ status: 200, description: 'List of pending requests' })
  @ApiResponse({ status: 403, description: 'Admin access required' })
  async getPendingJoinRequests(
    @Param('id') organizationId: string,
    @CurrentUser() user: any,
  ) {
    return this.organizationsService.getPendingJoinRequests(organizationId, user.id);
  }

  @Post(':id/join-requests/:requestId/approve')
  @Roles(UserRole.ADMIN)
  @ApiOperation({ summary: 'Approve join request and create user (admin only)' })
  @ApiResponse({ status: 201, description: 'Request approved, user created' })
  @ApiResponse({ status: 403, description: 'Admin access required' })
  @ApiResponse({ status: 404, description: 'Request not found' })
  async approveJoinRequest(
    @Param('id') organizationId: string,
    @Param('requestId') requestId: string,
    @CurrentUser() user: any,
    @Body() dto: ApproveJoinRequestDto,
  ) {
    return this.organizationsService.approveJoinRequest(
      organizationId,
      requestId,
      user.id,
      dto,
    );
  }

  @Post(':id/join-requests/:requestId/reject')
  @Roles(UserRole.ADMIN)
  @ApiOperation({ summary: 'Reject join request (admin only)' })
  @ApiResponse({ status: 200, description: 'Request rejected' })
  @ApiResponse({ status: 403, description: 'Admin access required' })
  @ApiResponse({ status: 404, description: 'Request not found' })
  async rejectJoinRequest(
    @Param('id') organizationId: string,
    @Param('requestId') requestId: string,
    @CurrentUser() user: any,
    @Body() dto: RejectJoinRequestDto,
  ) {
    return this.organizationsService.rejectJoinRequest(
      organizationId,
      requestId,
      user.id,
      dto,
    );
  }

  // ========================================
  // INVITATION CODES MANAGEMENT
  // ========================================

  @Post(':id/invitation-codes')
  @Roles(UserRole.ADMIN)
  @ApiOperation({ summary: 'Create invitation code (admin only)' })
  @ApiResponse({ status: 201, description: 'Invitation code created' })
  @ApiResponse({ status: 403, description: 'Admin access required' })
  async createInvitationCode(
    @Param('id') organizationId: string,
    @CurrentUser() user: any,
    @Body() dto: CreateInvitationCodeDto,
  ) {
    return this.organizationsService.createInvitationCode(
      organizationId,
      user.id,
      dto,
    );
  }

  @Get(':id/invitation-codes')
  @Roles(UserRole.ADMIN)
  @ApiOperation({ summary: 'List invitation codes (admin only)' })
  @ApiResponse({ status: 200, description: 'List of invitation codes' })
  @ApiResponse({ status: 403, description: 'Admin access required' })
  async listInvitationCodes(
    @Param('id') organizationId: string,
    @CurrentUser() user: any,
  ) {
    return this.organizationsService.listInvitationCodes(organizationId, user.id);
  }

  @Patch(':id/invitation-codes/:codeId')
  @Roles(UserRole.ADMIN)
  @ApiOperation({ summary: 'Update invitation code (admin only)' })
  @ApiResponse({ status: 200, description: 'Invitation code updated' })
  @ApiResponse({ status: 403, description: 'Admin access required' })
  @ApiResponse({ status: 404, description: 'Code not found' })
  async updateInvitationCode(
    @Param('id') organizationId: string,
    @Param('codeId') codeId: string,
    @CurrentUser() user: any,
    @Body() dto: UpdateInvitationCodeDto,
  ) {
    return this.organizationsService.updateInvitationCode(
      organizationId,
      codeId,
      user.id,
      dto,
    );
  }

  @Delete(':id/invitation-codes/:codeId')
  @Roles(UserRole.ADMIN)
  @ApiOperation({ summary: 'Delete invitation code (admin only)' })
  @ApiResponse({ status: 200, description: 'Invitation code deleted' })
  @ApiResponse({ status: 403, description: 'Admin access required' })
  @ApiResponse({ status: 404, description: 'Code not found' })
  async deleteInvitationCode(
    @Param('id') organizationId: string,
    @Param('codeId') codeId: string,
    @CurrentUser() user: any,
  ) {
    return this.organizationsService.deleteInvitationCode(
      organizationId,
      codeId,
      user.id,
    );
  }
}

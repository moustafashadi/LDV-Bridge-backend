import {
  Controller,
  Get,
  Post,
  Body,
  Patch,
  Param,
  Delete,
  Query,
  UseGuards,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiBearerAuth,
  ApiParam,
} from '@nestjs/swagger';
import { UsersService } from './users.service';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { OnboardedGuard } from '../auth/guards/onboarded.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import type { AuthenticatedUser } from '../auth/interfaces/authenticated-user.interface';
import { UserRole } from '@prisma/client';
import { InviteUserDto } from './dto/invite-user.dto';
import { UpdateUserDto } from './dto/update-user.dto';
import { UpdateUserRoleDto } from './dto/update-user-role.dto';
import { ListUsersQueryDto } from './dto/list-users-query.dto';
import { UserResponseDto, PaginatedUsersResponseDto } from './dto/user-response.dto';

/**
 * Users Controller
 * Handles user management endpoints
 * Requires users to be fully onboarded (with organization and role)
 */
@ApiTags('Users')
@Controller('users')
@UseGuards(JwtAuthGuard, OnboardedGuard, RolesGuard)
@ApiBearerAuth()
export class UsersController {
  constructor(private readonly usersService: UsersService) {}

  /**
   * List all users in the organization (paginated)
   */
  @Get()
  @ApiOperation({ summary: 'List users with pagination and filtering' })
  @ApiResponse({ status: 200, description: 'Returns paginated users', type: PaginatedUsersResponseDto })
  async findAll(
    @CurrentUser() user: AuthenticatedUser,
    @Query() query: ListUsersQueryDto,
  ): Promise<PaginatedUsersResponseDto> {
    // OnboardedGuard ensures organizationId is not null
    return this.usersService.findAll(user.organizationId!, query);
  }

  /**
   * Get current user profile
   */
  @Get('me')
  @ApiOperation({ summary: 'Get current user profile' })
  @ApiResponse({ status: 200, description: 'Returns current user', type: UserResponseDto })
  async getMe(@CurrentUser() user: AuthenticatedUser) {
    // OnboardedGuard ensures id is not null
    return this.usersService.getMe(user.id!);
  }

  /**
   * Get user by ID
   */
  @Get(':id')
  @ApiOperation({ summary: 'Get user by ID' })
  @ApiParam({ name: 'id', description: 'User ID' })
  @ApiResponse({ status: 200, description: 'Returns user', type: UserResponseDto })
  @ApiResponse({ status: 404, description: 'User not found' })
  async findOne(
    @Param('id') id: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.usersService.findOne(id, user.organizationId!);
  }

  /**
   * Update user profile
   * Users can update their own profile, admins can update any user
   */
  @Patch(':id')
  @ApiOperation({ summary: 'Update user profile' })
  @ApiParam({ name: 'id', description: 'User ID' })
  @ApiResponse({ status: 200, description: 'User updated successfully', type: UserResponseDto })
  @ApiResponse({ status: 403, description: 'Forbidden - can only update own profile unless admin' })
  async update(
    @Param('id') id: string,
    @Body() updateUserDto: UpdateUserDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    // Users can only update themselves unless they're admin
    if (id !== user.id && user.role !== UserRole.ADMIN) {
      throw new Error('You can only update your own profile');
    }

    return this.usersService.update(id, updateUserDto, user.organizationId!);
  }

  /**
   * Update user role (admin only)
   */
  @Patch(':id/role')
  @Roles(UserRole.ADMIN)
  @ApiOperation({ summary: 'Update user role (admin only)' })
  @ApiParam({ name: 'id', description: 'User ID' })
  @ApiResponse({ status: 200, description: 'User role updated', type: UserResponseDto })
  @ApiResponse({ status: 403, description: 'Forbidden - admin only' })
  async updateRole(
    @Param('id') id: string,
    @Body() updateUserRoleDto: UpdateUserRoleDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.usersService.updateRole(id, updateUserRoleDto, user.organizationId!);
  }

  /**
   * Invite a new user (admin only)
   */
  @Post('invite')
  @Roles(UserRole.ADMIN)
  @ApiOperation({ summary: 'Invite a new user (admin only)' })
  @ApiResponse({ status: 201, description: 'Invitation sent successfully' })
  @ApiResponse({ status: 409, description: 'User or invitation already exists' })
  async invite(
    @Body() inviteUserDto: InviteUserDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.usersService.inviteUser(inviteUserDto, user.organizationId!);
  }

  /**
   * Get pending invitations (admin only)
   */
  @Get('invitations/pending')
  @Roles(UserRole.ADMIN)
  @ApiOperation({ summary: 'Get pending invitations (admin only)' })
  @ApiResponse({ status: 200, description: 'Returns pending invitations' })
  async getPendingInvitations(@CurrentUser() user: AuthenticatedUser) {
    return this.usersService.getPendingInvitations(user.organizationId!);
  }

  /**
   * Revoke invitation (admin only)
   */
  @Delete('invitations/:id')
  @Roles(UserRole.ADMIN)
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Revoke invitation (admin only)' })
  @ApiParam({ name: 'id', description: 'Invitation ID' })
  @ApiResponse({ status: 204, description: 'Invitation revoked' })
  @ApiResponse({ status: 404, description: 'Invitation not found' })
  async revokeInvitation(
    @Param('id') id: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.usersService.revokeInvitation(id, user.organizationId!);
  }

  /**
   * Deactivate user (admin only)
   */
  @Delete(':id/deactivate')
  @Roles(UserRole.ADMIN)
  @ApiOperation({ summary: 'Deactivate user (admin only)' })
  @ApiParam({ name: 'id', description: 'User ID' })
  @ApiResponse({ status: 200, description: 'User deactivated', type: UserResponseDto })
  async deactivate(
    @Param('id') id: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.usersService.deactivate(id, user.organizationId!);
  }

  /**
   * Reactivate user (admin only)
   */
  @Post(':id/reactivate')
  @Roles(UserRole.ADMIN)
  @ApiOperation({ summary: 'Reactivate user (admin only)' })
  @ApiParam({ name: 'id', description: 'User ID' })
  @ApiResponse({ status: 200, description: 'User reactivated', type: UserResponseDto })
  async reactivate(
    @Param('id') id: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.usersService.reactivate(id, user.organizationId!);
  }

  /**
   * Suspend user (admin only)
   */
  @Post(':id/suspend')
  @Roles(UserRole.ADMIN)
  @ApiOperation({ summary: 'Suspend user (admin only)' })
  @ApiParam({ name: 'id', description: 'User ID' })
  @ApiResponse({ status: 200, description: 'User suspended', type: UserResponseDto })
  async suspend(
    @Param('id') id: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.usersService.suspend(id, user.organizationId!);
  }
}


import {
  Controller,
  Get,
  Post,
  Put,
  Delete,
  Body,
  Param,
  Query,
  UseGuards,
  ParseUUIDPipe,
  ParseEnumPipe,
  DefaultValuePipe,
  ParseIntPipe,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiBearerAuth, ApiQuery } from '@nestjs/swagger';
import { ChangesService } from './changes.service';
import { CreateChangeDto } from './dto/create-change.dto';
import { UpdateChangeDto } from './dto/update-change.dto';
import {
  ChangeResponseDto,
  DetectChangesResponseDto,
  PaginatedChangesResponseDto,
} from './dto/change-response.dto';
import { AuthGuard } from '@nestjs/passport';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import type { AuthenticatedUser } from '../auth/interfaces/authenticated-user.interface';
import { ChangeStatus, ChangeType, UserRole } from '@prisma/client';

@ApiTags('Changes')
@ApiBearerAuth()
@Controller('changes')
@UseGuards(AuthGuard('jwt'), RolesGuard)
export class ChangesController {
  constructor(private readonly changesService: ChangesService) {}

  /**
   * Manually trigger change detection for an app
   */
  @Post('detect/:appId')
  @Roles(UserRole.ADMIN, UserRole.PRO_DEVELOPER)
  @ApiOperation({ summary: 'Manually trigger change detection for an app' })
  @ApiResponse({ status: 200, description: 'Changes detected', type: DetectChangesResponseDto })
  @ApiResponse({ status: 404, description: 'App not found' })
  async detectChanges(
    @Param('appId', ParseUUIDPipe) appId: string,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<DetectChangesResponseDto> {
    return this.changesService.detectChanges(appId, user.id!, user.organizationId!);
  }

  /**
   * Manually trigger sync for a sandbox (will detect changes from platform)
   */
  @Post('sync/:sandboxId')
  @Roles(UserRole.ADMIN, UserRole.PRO_DEVELOPER, UserRole.CITIZEN_DEVELOPER)
  @ApiOperation({ summary: 'Manually sync changes from a sandbox environment' })
  @ApiResponse({ status: 200, description: 'Sync completed' })
  @ApiResponse({ status: 404, description: 'Sandbox not found' })
  async syncSandbox(
    @Param('sandboxId', ParseUUIDPipe) sandboxId: string,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<{ success: boolean; message: string; changeCount: number }> {
    return this.changesService.syncSandbox(sandboxId, user.id!, user.organizationId!);
  }

  /**
   * Create a manual change record
   */
  @Post()
  @Roles(UserRole.ADMIN, UserRole.PRO_DEVELOPER, UserRole.CITIZEN_DEVELOPER)
  @ApiOperation({ summary: 'Create a manual change record' })
  @ApiResponse({ status: 201, description: 'Change created', type: ChangeResponseDto })
  @ApiResponse({ status: 404, description: 'App not found' })
  async create(
    @Body() createChangeDto: CreateChangeDto,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<ChangeResponseDto> {
    return this.changesService.create(createChangeDto, user.id!, user.organizationId!);
  }

  /**
   * Get all changes (with filters)
   */
  @Get()
  @Roles(UserRole.ADMIN, UserRole.PRO_DEVELOPER, UserRole.CITIZEN_DEVELOPER)
  @ApiOperation({ summary: 'Get all changes with optional filters' })
  @ApiResponse({ status: 200, description: 'Changes retrieved', type: PaginatedChangesResponseDto })
  @ApiQuery({ name: 'appId', required: false, description: 'Filter by app ID' })
  @ApiQuery({ name: 'status', required: false, enum: ChangeStatus, description: 'Filter by status' })
  @ApiQuery({
    name: 'changeType',
    required: false,
    enum: ChangeType,
    description: 'Filter by change type',
  })
  @ApiQuery({ name: 'page', required: false, type: Number, description: 'Page number (default: 1)' })
  @ApiQuery({
    name: 'limit',
    required: false,
    type: Number,
    description: 'Items per page (default: 20)',
  })
  async findAll(
    @Query('appId') appId?: string,
    @Query('status') status?: ChangeStatus,
    @Query('changeType') changeType?: ChangeType,
    @Query('page', new DefaultValuePipe(1), ParseIntPipe) page?: number,
    @Query('limit', new DefaultValuePipe(20), ParseIntPipe) limit?: number,
    @CurrentUser() user?: AuthenticatedUser,
  ): Promise<PaginatedChangesResponseDto> {
    return this.changesService.findAll(user!.organizationId!, {
      appId,
      status,
      changeType,
      page,
      limit,
    });
  }

  /**
   * Get a single change by ID
   */
  @Get(':id')
  @Roles(UserRole.ADMIN, UserRole.PRO_DEVELOPER, UserRole.CITIZEN_DEVELOPER)
  @ApiOperation({ summary: 'Get a single change by ID' })
  @ApiResponse({ status: 200, description: 'Change retrieved', type: ChangeResponseDto })
  @ApiResponse({ status: 404, description: 'Change not found' })
  async findOne(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<ChangeResponseDto> {
    return this.changesService.findOne(id, user.organizationId!);
  }

  /**
   * Get visual diff for a change
   */
  @Get(':id/diff')
  @Roles(UserRole.ADMIN, UserRole.PRO_DEVELOPER, UserRole.CITIZEN_DEVELOPER)
  @ApiOperation({ summary: 'Get visual diff for a change' })
  @ApiResponse({ status: 200, description: 'Diff retrieved', type: String })
  @ApiResponse({ status: 404, description: 'Change not found' })
  @ApiQuery({
    name: 'format',
    required: false,
    enum: ['json', 'html', 'text'],
    description: 'Diff format (default: json)',
  })
  async getVisualDiff(
    @Param('id', ParseUUIDPipe) id: string,
    @Query('format', new DefaultValuePipe('json')) format: 'json' | 'html' | 'text',
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<string> {
    return this.changesService.getVisualDiff(id, user.organizationId!, format);
  }

  /**
   * Update a change
   */
  @Put(':id')
  @Roles(UserRole.ADMIN, UserRole.PRO_DEVELOPER, UserRole.CITIZEN_DEVELOPER)
  @ApiOperation({ summary: 'Update a change' })
  @ApiResponse({ status: 200, description: 'Change updated', type: ChangeResponseDto })
  @ApiResponse({ status: 404, description: 'Change not found' })
  async update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() updateChangeDto: UpdateChangeDto,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<ChangeResponseDto> {
    return this.changesService.update(id, updateChangeDto, user.id!, user.organizationId!);
  }

  /**
   * Delete a change
   */
  @Delete(':id')
  @Roles(UserRole.ADMIN, UserRole.PRO_DEVELOPER)
  @ApiOperation({ summary: 'Delete a change' })
  @ApiResponse({ status: 200, description: 'Change deleted' })
  @ApiResponse({ status: 404, description: 'Change not found' })
  async remove(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<{ success: boolean; message: string }> {
    await this.changesService.remove(id, user.id!, user.organizationId!);
    return {
      success: true,
      message: 'Change deleted successfully',
    };
  }

  /**
   * Undo (soft delete) a change
   */
  @Post(':id/undo')
  @Roles(UserRole.ADMIN, UserRole.PRO_DEVELOPER, UserRole.CITIZEN_DEVELOPER)
  @ApiOperation({ summary: 'Undo a change (soft delete)' })
  @ApiResponse({ status: 200, description: 'Change undone', type: ChangeResponseDto })
  @ApiResponse({ status: 404, description: 'Change not found or already undone' })
  async undo(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<ChangeResponseDto> {
    return this.changesService.undo(id, user.id!, user.organizationId!);
  }

  /**
   * Restore (undelete) a change
   */
  @Post(':id/restore')
  @Roles(UserRole.ADMIN, UserRole.PRO_DEVELOPER, UserRole.CITIZEN_DEVELOPER)
  @ApiOperation({ summary: 'Restore an undone change' })
  @ApiResponse({ status: 200, description: 'Change restored', type: ChangeResponseDto })
  @ApiResponse({ status: 404, description: 'Change not found or not undone' })
  async restore(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<ChangeResponseDto> {
    return this.changesService.restore(id, user.id!, user.organizationId!);
  }
}

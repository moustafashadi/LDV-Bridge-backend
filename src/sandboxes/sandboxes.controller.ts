import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Body,
  Param,
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
  ApiQuery,
} from '@nestjs/swagger';
import { SandboxesService } from './sandboxes.service';
import { CreateSandboxDto } from './dto/create-sandbox.dto';
import { UpdateSandboxDto } from './dto/update-sandbox.dto';
import {
  SandboxResponseDto,
  SandboxStatsDto,
  ExtendExpirationDto,
  AssignUsersDto,
  UnassignUsersDto,
} from './dto/sandbox-response.dto';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { UserRole } from '@prisma/client';
import { SandboxPlatform, SandboxStatus, SandboxType } from './interfaces/sandbox-environment.interface';

@ApiTags('Sandboxes')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Controller('sandboxes')
export class SandboxesController {
  constructor(private readonly sandboxesService: SandboxesService) {}

  @Post()
  @ApiOperation({ summary: 'Create a new sandbox with environment provisioning' })
  @ApiResponse({
    status: 201,
    description: 'Sandbox created and provisioning started',
    type: SandboxResponseDto,
  })
  @ApiResponse({ status: 400, description: 'Bad Request' })
  async create(
    @Body() createSandboxDto: CreateSandboxDto,
    @CurrentUser('id') userId: string,
    @CurrentUser('organizationId') organizationId: string,
  ): Promise<SandboxResponseDto> {
    return this.sandboxesService.create(
      createSandboxDto,
      userId,
      organizationId,
    );
  }

  @Get()
  @ApiOperation({ summary: 'List all sandboxes in organization' })
  @ApiQuery({ name: 'platform', enum: SandboxPlatform, required: false })
  @ApiQuery({ name: 'status', enum: SandboxStatus, required: false })
  @ApiQuery({ name: 'type', enum: SandboxType, required: false })
  @ApiQuery({ name: 'page', type: Number, required: false, example: 1 })
  @ApiQuery({ name: 'limit', type: Number, required: false, example: 20 })
  @ApiResponse({
    status: 200,
    description: 'List of sandboxes',
    type: [SandboxResponseDto],
  })
  async findAll(
    @CurrentUser('organizationId') organizationId: string,
    @Query('platform') platform?: SandboxPlatform,
    @Query('status') status?: SandboxStatus,
    @Query('type') type?: SandboxType,
    @Query('page') page?: number,
    @Query('limit') limit?: number,
  ): Promise<{ data: SandboxResponseDto[]; total: number }> {
    return this.sandboxesService.findAll(
      organizationId,
      { platform, status, type },
      page ? Number(page) : 1,
      limit ? Number(limit) : 20,
    );
  }

  @Get('my')
  @ApiOperation({ summary: 'List my sandboxes' })
  @ApiResponse({
    status: 200,
    description: 'List of user sandboxes',
    type: [SandboxResponseDto],
  })
  async findMy(
    @CurrentUser('id') userId: string,
    @CurrentUser('organizationId') organizationId: string,
  ): Promise<{ data: SandboxResponseDto[]; total: number }> {
    return this.sandboxesService.findAll(organizationId, { userId });
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get sandbox by ID' })
  @ApiResponse({
    status: 200,
    description: 'Sandbox details',
    type: SandboxResponseDto,
  })
  @ApiResponse({ status: 404, description: 'Sandbox not found' })
  async findOne(
    @Param('id') id: string,
    @CurrentUser('organizationId') organizationId: string,
  ): Promise<SandboxResponseDto> {
    return this.sandboxesService.findOne(id, organizationId);
  }

  @Patch(':id')
  @ApiOperation({ summary: 'Update sandbox' })
  @ApiResponse({
    status: 200,
    description: 'Sandbox updated',
    type: SandboxResponseDto,
  })
  @ApiResponse({ status: 404, description: 'Sandbox not found' })
  async update(
    @Param('id') id: string,
    @Body() updateSandboxDto: UpdateSandboxDto,
    @CurrentUser('id') userId: string,
    @CurrentUser('organizationId') organizationId: string,
  ): Promise<SandboxResponseDto> {
    return this.sandboxesService.update(
      id,
      organizationId,
      updateSandboxDto,
      userId,
    );
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Delete sandbox and deprovision environment' })
  @ApiResponse({ status: 204, description: 'Sandbox deleted' })
  @ApiResponse({ status: 404, description: 'Sandbox not found' })
  async remove(
    @Param('id') id: string,
    @CurrentUser('id') userId: string,
    @CurrentUser('organizationId') organizationId: string,
  ): Promise<void> {
    return this.sandboxesService.remove(id, organizationId, userId);
  }

  @Post(':id/start')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Start sandbox environment' })
  @ApiResponse({ status: 204, description: 'Sandbox started' })
  @ApiResponse({ status: 404, description: 'Sandbox not found' })
  async start(
    @Param('id') id: string,
    @CurrentUser('id') userId: string,
    @CurrentUser('organizationId') organizationId: string,
  ): Promise<void> {
    return this.sandboxesService.start(id, organizationId, userId);
  }

  @Post(':id/stop')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Stop sandbox environment' })
  @ApiResponse({ status: 204, description: 'Sandbox stopped' })
  @ApiResponse({ status: 404, description: 'Sandbox not found' })
  async stop(
    @Param('id') id: string,
    @CurrentUser('id') userId: string,
    @CurrentUser('organizationId') organizationId: string,
  ): Promise<void> {
    return this.sandboxesService.stop(id, organizationId, userId);
  }

  @Get(':id/stats')
  @ApiOperation({ summary: 'Get sandbox resource usage statistics' })
  @ApiResponse({
    status: 200,
    description: 'Sandbox statistics',
    type: SandboxStatsDto,
  })
  @ApiResponse({ status: 404, description: 'Sandbox not found' })
  async getStats(
    @Param('id') id: string,
    @CurrentUser('organizationId') organizationId: string,
  ): Promise<SandboxStatsDto> {
    return this.sandboxesService.getStats(id, organizationId);
  }

  @Post(':id/extend')
  @ApiOperation({ summary: 'Extend sandbox expiration date' })
  @ApiResponse({
    status: 200,
    description: 'Expiration extended',
    type: SandboxResponseDto,
  })
  @ApiResponse({ status: 404, description: 'Sandbox not found' })
  async extendExpiration(
    @Param('id') id: string,
    @Body() dto: ExtendExpirationDto,
    @CurrentUser('id') userId: string,
    @CurrentUser('organizationId') organizationId: string,
  ): Promise<SandboxResponseDto> {
    // Calculate new expiration date by adding days to current date
    const newExpiresAt = new Date();
    newExpiresAt.setDate(newExpiresAt.getDate() + dto.days);
    
    return this.sandboxesService.extendExpiration(
      id,
      organizationId,
      newExpiresAt,
      userId,
    );
  }

  @Post(':id/assign')
  @Roles(UserRole.ADMIN, UserRole.PRO_DEVELOPER)
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Assign users to sandbox (Admin/Pro only)' })
  @ApiResponse({ status: 204, description: 'Users assigned' })
  @ApiResponse({ status: 404, description: 'Sandbox not found' })
  async assignUsers(
    @Param('id') id: string,
    @Body() dto: AssignUsersDto,
    @CurrentUser('organizationId') organizationId: string,
  ): Promise<void> {
    // TODO: Implement user assignment (requires junction table)
    // This is placeholder for future implementation
  }

  @Post(':id/unassign')
  @Roles(UserRole.ADMIN, UserRole.PRO_DEVELOPER)
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Unassign users from sandbox (Admin/Pro only)' })
  @ApiResponse({ status: 204, description: 'Users unassigned' })
  @ApiResponse({ status: 404, description: 'Sandbox not found' })
  async unassignUsers(
    @Param('id') id: string,
    @Body() dto: UnassignUsersDto,
    @CurrentUser('organizationId') organizationId: string,
  ): Promise<void> {
    // TODO: Implement user removal (requires junction table)
    // This is placeholder for future implementation
  }

  @Get(':id/users')
  @ApiOperation({ summary: 'List users assigned to sandbox' })
  @ApiResponse({ status: 200, description: 'List of assigned users' })
  @ApiResponse({ status: 404, description: 'Sandbox not found' })
  async getAssignedUsers(
    @Param('id') id: string,
    @CurrentUser('organizationId') organizationId: string,
  ): Promise<any[]> {
    // TODO: Implement user listing (requires junction table)
    // This is placeholder for future implementation
    return [];
  }
}

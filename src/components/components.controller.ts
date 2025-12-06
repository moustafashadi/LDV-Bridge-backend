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
  ParseIntPipe,
  ParseEnumPipe,
  ParseBoolPipe,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiBearerAuth,
  ApiParam,
  ApiQuery,
} from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import type { AuthenticatedUser } from '../auth/interfaces/authenticated-user.interface';
import { ComponentsService } from './components.service';
import { CreateComponentDto } from './dto/create-component.dto';
import { UpdateComponentDto } from './dto/update-component.dto';
import {
  ComponentResponseDto,
  ComponentListResponseDto,
  ExtractComponentsResponseDto,
} from './dto/component-response.dto';
import { ComponentType, UserRole } from '@prisma/client';

@ApiTags('Components')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Controller('api/v1/components')
export class ComponentsController {
  constructor(private readonly componentsService: ComponentsService) { }

  @Post()
  @Roles(UserRole.ADMIN, UserRole.PRO_DEVELOPER)
  @ApiOperation({
    summary: 'Create a new component',
    description: 'Create a component for an app (ADMIN/PRO_DEVELOPER only)',
  })
  @ApiResponse({
    status: 201,
    description: 'Component created successfully',
    type: ComponentResponseDto,
  })
  @ApiResponse({
    status: 404,
    description: 'App not found',
  })
  async create(
    @Body() createComponentDto: CreateComponentDto,
    @CurrentUser() user?: AuthenticatedUser,
  ): Promise<ComponentResponseDto> {
    if (!user?.id || !user.organizationId) {
      throw new Error('User ID and organization ID are required');
    }

    return this.componentsService.create(
      createComponentDto,
      user.id,
      user.organizationId,
    );
  }

  @Get()
  @ApiOperation({
    summary: 'List components with filters',
    description: 'Get paginated list of components with search and filters',
  })
  @ApiQuery({
    name: 'appId',
    required: false,
    description: 'Filter by app ID',
  })
  @ApiQuery({
    name: 'type',
    required: false,
    enum: ComponentType,
    description: 'Filter by component type',
  })
  @ApiQuery({
    name: 'search',
    required: false,
    description: 'Search by name or path',
  })
  @ApiQuery({
    name: 'tags',
    required: false,
    description: 'Filter by tags (comma-separated)',
  })
  @ApiQuery({
    name: 'isReusable',
    required: false,
    type: Boolean,
    description: 'Filter reusable components',
  })
  @ApiQuery({
    name: 'page',
    required: false,
    type: Number,
    description: 'Page number (default: 1)',
  })
  @ApiQuery({
    name: 'limit',
    required: false,
    type: Number,
    description: 'Records per page (default: 20)',
  })
  @ApiResponse({
    status: 200,
    description: 'Components retrieved successfully',
    type: ComponentListResponseDto,
  })
  async findAll(
    @Query('appId') appId?: string,
    @Query('type', new ParseEnumPipe(ComponentType, { optional: true }))
    type?: ComponentType,
    @Query('search') search?: string,
    @Query('tags') tags?: string,
    @Query('isReusable', new ParseBoolPipe({ optional: true }))
    isReusable?: boolean,
    @Query('page', new ParseIntPipe({ optional: true })) page?: number,
    @Query('limit', new ParseIntPipe({ optional: true })) limit?: number,
    @CurrentUser() user?: AuthenticatedUser,
  ): Promise<ComponentListResponseDto> {
    if (!user?.organizationId) {
      throw new Error('Organization ID is required');
    }

    return this.componentsService.findAll(user.organizationId, {
      appId,
      type,
      search,
      tags,
      isReusable,
      page,
      limit,
    });
  }

  @Get('reusable')
  @ApiOperation({
    summary: 'Get reusable component library',
    description: 'Get all reusable components available in the organization',
  })
  @ApiQuery({
    name: 'type',
    required: false,
    enum: ComponentType,
    description: 'Filter by component type',
  })
  @ApiQuery({
    name: 'tags',
    required: false,
    description: 'Filter by tags (comma-separated)',
  })
  @ApiQuery({
    name: 'page',
    required: false,
    type: Number,
    description: 'Page number (default: 1)',
  })
  @ApiQuery({
    name: 'limit',
    required: false,
    type: Number,
    description: 'Records per page (default: 20)',
  })
  @ApiResponse({
    status: 200,
    description: 'Reusable components retrieved successfully',
    type: ComponentListResponseDto,
  })
  async findReusable(
    @Query('type', new ParseEnumPipe(ComponentType, { optional: true }))
    type?: ComponentType,
    @Query('tags') tags?: string,
    @Query('page', new ParseIntPipe({ optional: true })) page?: number,
    @Query('limit', new ParseIntPipe({ optional: true })) limit?: number,
    @CurrentUser() user?: AuthenticatedUser,
  ): Promise<ComponentListResponseDto> {
    if (!user?.organizationId) {
      throw new Error('Organization ID is required');
    }

    return this.componentsService.findReusable(user.organizationId, {
      type,
      tags,
      page,
      limit,
    });
  }

  @Get(':id')
  @ApiOperation({
    summary: 'Get component by ID',
    description: 'Get detailed information about a specific component',
  })
  @ApiParam({
    name: 'id',
    description: 'Component ID',
  })
  @ApiResponse({
    status: 200,
    description: 'Component retrieved successfully',
    type: ComponentResponseDto,
  })
  @ApiResponse({
    status: 404,
    description: 'Component not found',
  })
  async findOne(
    @Param('id') id: string,
    @CurrentUser() user?: AuthenticatedUser,
  ): Promise<ComponentResponseDto> {
    if (!user?.organizationId) {
      throw new Error('Organization ID is required');
    }

    return this.componentsService.findOne(id, user.organizationId);
  }

  @Put(':id')
  @Roles(UserRole.ADMIN, UserRole.PRO_DEVELOPER)
  @ApiOperation({
    summary: 'Update component',
    description: 'Update component information (ADMIN/PRO_DEVELOPER only)',
  })
  @ApiParam({
    name: 'id',
    description: 'Component ID',
  })
  @ApiResponse({
    status: 200,
    description: 'Component updated successfully',
    type: ComponentResponseDto,
  })
  @ApiResponse({
    status: 404,
    description: 'Component not found',
  })
  async update(
    @Param('id') id: string,
    @Body() updateComponentDto: UpdateComponentDto,
    @CurrentUser() user?: AuthenticatedUser,
  ): Promise<ComponentResponseDto> {
    if (!user?.id || !user.organizationId) {
      throw new Error('User ID and organization ID are required');
    }

    return this.componentsService.update(
      id,
      updateComponentDto,
      user.id,
      user.organizationId,
    );
  }

  @Delete(':id')
  @Roles(UserRole.ADMIN, UserRole.PRO_DEVELOPER)
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary: 'Delete component',
    description: 'Delete a component (ADMIN/PRO_DEVELOPER only)',
  })
  @ApiParam({
    name: 'id',
    description: 'Component ID',
  })
  @ApiResponse({
    status: 204,
    description: 'Component deleted successfully',
  })
  @ApiResponse({
    status: 404,
    description: 'Component not found',
  })
  async remove(
    @Param('id') id: string,
    @CurrentUser() user?: AuthenticatedUser,
  ): Promise<void> {
    if (!user?.id || !user.organizationId) {
      throw new Error('User ID and organization ID are required');
    }

    return this.componentsService.remove(id, user.id, user.organizationId);
  }

  @Post('extract/:appId')
  @Roles(UserRole.ADMIN, UserRole.PRO_DEVELOPER)
  @ApiOperation({
    summary: 'Extract components from app',
    description:
      'Extract components from synced app metadata (ADMIN/PRO_DEVELOPER only)',
  })
  @ApiParam({
    name: 'appId',
    description: 'App ID',
  })
  @ApiResponse({
    status: 201,
    description: 'Components extracted successfully',
    type: ExtractComponentsResponseDto,
  })
  @ApiResponse({
    status: 404,
    description: 'App not found',
  })
  @ApiResponse({
    status: 400,
    description: 'App has no metadata or extraction not supported',
  })
  async extractFromApp(
    @Param('appId') appId: string,
    @CurrentUser() user?: AuthenticatedUser,
  ): Promise<ExtractComponentsResponseDto> {
    if (!user?.id || !user.organizationId) {
      throw new Error('User ID and organization ID are required');
    }

    return this.componentsService.extractFromApp(
      appId,
      user.id,
      user.organizationId,
    );
  }
}

import {
  Controller,
  Get,
  Post,
  Delete,
  Body,
  Param,
  Query,
  UseGuards,
  HttpCode,
  HttpStatus,
  UnauthorizedException,
} from '@nestjs/common';
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiBearerAuth,
  ApiQuery,
} from '@nestjs/swagger';
import { JwtAuthGuard } from '../../../auth/guards/jwt-auth.guard';
import { CurrentUser } from '../../../auth/decorators/current-user.decorator';
import { LinkedEnvironmentsService } from './linked-environments.service';
import {
  CreateLinkedEnvironmentDto,
  LinkedEnvironmentPlatform,
} from './dto/create-linked-environment.dto';
import {
  LinkedEnvironmentResponseDto,
  LinkedEnvironmentWithAppsDto,
} from './dto/linked-environment-response.dto';

@ApiTags('Linked Environments')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('linked-environments')
export class LinkedEnvironmentsController {
  constructor(
    private readonly linkedEnvironmentsService: LinkedEnvironmentsService,
  ) {}

  @Post()
  @ApiOperation({
    summary: 'Link a PowerApps environment',
    description:
      'Links an existing PowerApps environment to LDV-Bridge for browsing and syncing apps. This does NOT create a sandbox.',
  })
  @ApiResponse({
    status: 201,
    description: 'Environment linked successfully',
    type: LinkedEnvironmentResponseDto,
  })
  @ApiResponse({
    status: 400,
    description: 'Invalid request or environment not found',
  })
  @ApiResponse({ status: 409, description: 'Environment already linked' })
  async create(
    @CurrentUser('id') userId: string,
    @CurrentUser('organizationId') organizationId: string,
    @Body() dto: CreateLinkedEnvironmentDto,
  ): Promise<LinkedEnvironmentResponseDto> {
    return this.linkedEnvironmentsService.create(dto, userId, organizationId);
  }

  @Get()
  @ApiOperation({
    summary: 'List linked environments',
    description: 'Returns all linked environments for the organization',
  })
  @ApiQuery({
    name: 'platform',
    required: false,
    enum: LinkedEnvironmentPlatform,
  })
  @ApiQuery({ name: 'isActive', required: false, type: Boolean })
  @ApiResponse({
    status: 200,
    description: 'List of linked environments',
    type: [LinkedEnvironmentResponseDto],
  })
  async findAll(
    @CurrentUser('organizationId') organizationId: string,
    @Query('platform') platform?: LinkedEnvironmentPlatform,
    @Query('isActive') isActive?: string,
  ): Promise<LinkedEnvironmentResponseDto[]> {
    return this.linkedEnvironmentsService.findAll(organizationId, {
      platform,
      isActive: isActive !== undefined ? isActive === 'true' : undefined,
    });
  }

  @Get(':id')
  @ApiOperation({
    summary: 'Get linked environment details',
    description: 'Returns details of a specific linked environment',
  })
  @ApiResponse({
    status: 200,
    description: 'Linked environment details',
    type: LinkedEnvironmentResponseDto,
  })
  @ApiResponse({ status: 404, description: 'Environment not found' })
  async findOne(
    @CurrentUser('organizationId') organizationId: string,
    @Param('id') id: string,
  ): Promise<LinkedEnvironmentResponseDto> {
    return this.linkedEnvironmentsService.findOne(id, organizationId);
  }

  @Get(':id/apps')
  @ApiOperation({
    summary: 'Get apps in environment',
    description:
      'Returns the linked environment with a list of apps from the platform',
  })
  @ApiResponse({
    status: 200,
    description: 'Environment with apps',
    type: LinkedEnvironmentWithAppsDto,
  })
  @ApiResponse({ status: 404, description: 'Environment not found' })
  async findOneWithApps(
    @CurrentUser('id') userId: string,
    @CurrentUser('organizationId') organizationId: string,
    @Param('id') id: string,
  ): Promise<LinkedEnvironmentWithAppsDto> {
    return this.linkedEnvironmentsService.findOneWithApps(
      id,
      organizationId,
      userId,
    );
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary: 'Unlink environment',
    description: 'Removes the link between the environment and LDV-Bridge',
  })
  @ApiResponse({ status: 204, description: 'Environment unlinked' })
  @ApiResponse({ status: 404, description: 'Environment not found' })
  async remove(
    @CurrentUser('id') userId: string,
    @CurrentUser('organizationId') organizationId: string,
    @Param('id') id: string,
  ): Promise<void> {
    return this.linkedEnvironmentsService.remove(id, organizationId, userId);
  }
}

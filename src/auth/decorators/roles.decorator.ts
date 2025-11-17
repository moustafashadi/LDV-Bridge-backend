import { SetMetadata } from '@nestjs/common';
import { UserRole } from '@prisma/client';

export const ROLES_KEY = 'roles';

/**
 * Roles Decorator
 * Specifies which roles are allowed to access a route
 * Works with RolesGuard
 * 
 * @example
 * @Roles(UserRole.ADMIN)
 * @Get('users')
 * getAllUsers() { ... }
 * 
 * @example
 * @Roles(UserRole.ADMIN, UserRole.PRO_DEVELOPER)
 * @Post('deploy')
 * deployApp() { ... }
 */
export const Roles = (...roles: UserRole[]) => SetMetadata(ROLES_KEY, roles);

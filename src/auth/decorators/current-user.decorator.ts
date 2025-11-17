import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import { AuthenticatedUser } from '../interfaces/authenticated-user.interface';

/**
 * Current User Decorator
 * Extracts authenticated user from request
 * 
 * @example
 * @Get('profile')
 * getProfile(@CurrentUser() user: AuthenticatedUser) {
 *   return user;
 * }
 */
export const CurrentUser = createParamDecorator(
  (data: keyof AuthenticatedUser | undefined, ctx: ExecutionContext): AuthenticatedUser | any => {
    const request = ctx.switchToHttp().getRequest();
    const user: AuthenticatedUser = request.user;

    // If a specific property is requested, return that
    return data ? user?.[data] : user;
  },
);

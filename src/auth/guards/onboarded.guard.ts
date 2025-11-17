import {
  Injectable,
  CanActivate,
  ExecutionContext,
  UnauthorizedException,
} from '@nestjs/common';

/**
 * Onboarded Guard
 * Ensures the user has completed onboarding before accessing protected endpoints
 * Use this guard on endpoints that require a fully onboarded user with org and role
 */
@Injectable()
export class OnboardedGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest();
    const user = request.user;

    if (!user) {
      throw new UnauthorizedException('User not authenticated');
    }

    // Check if user has completed onboarding (has id, org, and role)
    if (!user.id || !user.organizationId || !user.role) {
      throw new UnauthorizedException(
        'User has not completed onboarding. Please complete your profile setup first.',
      );
    }

    return true;
  }
}

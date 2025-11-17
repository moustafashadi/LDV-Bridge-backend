import { Injectable, NestMiddleware, ForbiddenException } from '@nestjs/common';
import { Request, Response, NextFunction } from 'express';
import { AuthenticatedUser } from '../../auth/interfaces/authenticated-user.interface';

/**
 * Tenant Context Middleware
 * Ensures all requests are scoped to the authenticated user's organization
 * Prevents cross-tenant data access
 */
@Injectable()
export class TenantContextMiddleware implements NestMiddleware {
  use(req: Request & { user?: AuthenticatedUser }, res: Response, next: NextFunction) {
    // Skip for public routes or unauthenticated requests
    if (!req.user) {
      return next();
    }

    const user = req.user;

    // Attach organization context to request for easy access
    (req as any).organizationId = user.organizationId;
    (req as any).userRole = user.role;

    // If request has organizationId in params/query/body, validate it matches user's org
    const paramOrgId = req.params.organizationId;
    const queryOrgId = (req.query as any).organizationId;
    const bodyOrgId = (req.body as any)?.organizationId;

    const requestedOrgId = paramOrgId || queryOrgId || bodyOrgId;

    if (requestedOrgId && requestedOrgId !== user.organizationId) {
      throw new ForbiddenException(
        'Access denied: Cannot access resources from another organization',
      );
    }

    next();
  }
}

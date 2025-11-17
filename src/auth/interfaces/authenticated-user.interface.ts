import { UserRole } from '@prisma/client';

/**
 * Authenticated User Interface
 * Represents the user object attached to requests after authentication
 * 
 * Note: id, role, and organizationId can be null for users who haven't
 * completed onboarding yet. The auth0Id and email are always present
 * from the Auth0 JWT token.
 */
export interface AuthenticatedUser {
  id: string | null; // User ID from database (null if not onboarded)
  auth0Id: string; // Auth0 user ID (sub claim)
  email: string;
  role: UserRole | null; // User role (null if not onboarded)
  organizationId: string | null; // Organization ID (null if not onboarded)
  name?: string;
  picture?: string;
  sub?: string; // Auth0 subject identifier (for compatibility)
}

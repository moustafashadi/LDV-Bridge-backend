/**
 * JWT Payload Interface
 * Represents the decoded JWT token from Auth0
 */
export interface JwtPayload {
  sub: string; // Auth0 user ID
  email: string;
  email_verified?: boolean;
  name?: string;
  picture?: string;
  iat?: number; // Issued at
  exp?: number; // Expiration
  aud?: string | string[]; // Audience
  iss?: string; // Issuer
  
  // Custom claims (set in Auth0 rules/actions)
  'https://ldv-bridge.com/organizationId'?: string;
  'https://ldv-bridge.com/role'?: string;
  'https://ldv-bridge.com/userId'?: string;
}

import { Injectable, UnauthorizedException } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import { Strategy, ExtractJwt } from 'passport-jwt';
import { passportJwtSecret } from 'jwks-rsa';
import { ConfigService } from '@nestjs/config';
import { JwtPayload } from '../interfaces/jwt-payload.interface';
import { AuthService } from '../auth.service';
import { AuthenticatedUser } from '../interfaces/authenticated-user.interface';

/**
 * JWT Strategy for Auth0
 * Validates JWT tokens from Auth0 and extracts user information
 */
@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  constructor(
    private configService: ConfigService,
    private authService: AuthService,
  ) {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      audience: configService.get<string>('AUTH0_AUDIENCE'),
      issuer: `https://${configService.get<string>('AUTH0_DOMAIN')}/`,
      algorithms: ['RS256'],
      passReqToCallback: true, // Pass request to validate method to access token
      
      // Dynamically fetch Auth0 public key for JWT verification
      secretOrKeyProvider: passportJwtSecret({
        cache: true,
        rateLimit: true,
        jwksRequestsPerMinute: 5,
        jwksUri: `https://${configService.get<string>('AUTH0_DOMAIN')}/.well-known/jwks.json`,
      }),
    });
  }

  /**
   * Validate JWT payload and return authenticated user
   * This method is called automatically by Passport after JWT verification
   */
  async validate(request: any, payload: JwtPayload): Promise<AuthenticatedUser> {
    console.log('[JwtStrategy] Validating JWT payload:', {
      sub: payload.sub,
      email: payload.email,
      name: payload.name,
      customClaims: {
        userId: payload['https://ldv-bridge.com/userId'],
        organizationId: payload['https://ldv-bridge.com/organizationId'],
        role: payload['https://ldv-bridge.com/role'],
      }
    });
    
    // Extract email from JWT payload
    // Auth0 includes email in standard 'email' claim, but also check namespace claims
    let email = payload.email || 
                payload['https://ldv-bridge.com/email'] || 
                payload['http://ldv-bridge.com/email'];
    
    // If email is not in JWT, fetch it from Auth0 userinfo endpoint
    if (!email) {
      console.log('[JwtStrategy] Email not in JWT, fetching from Auth0 userinfo...');
      const authHeader = request.headers.authorization;
      if (authHeader) {
        const token = authHeader.replace('Bearer ', '');
        email = await this.authService.getUserEmailFromAuth0(token);
      }
    }
    
    if (!email) {
      console.error('[JwtStrategy] No email found in JWT payload or userinfo for user:', payload.sub);
      throw new UnauthorizedException('Email not found in token');
    }
    
    console.log('[JwtStrategy] Email resolved:', email);
    const name = payload.name;
    
    // Extract custom claims from Auth0
    const organizationId = payload['https://ldv-bridge.com/organizationId'];
    const role = payload['https://ldv-bridge.com/role'];
    const userId = payload['https://ldv-bridge.com/userId'];

    // If no custom claims, this might be the first login
    // We need to look up the user
    if (!userId || !organizationId) {
      console.log('No custom claims found in JWT, validating user from Auth0...');
      const user = await this.authService.validateUserFromAuth0(
        payload.sub,
        email,
      );
      
      if (!user) {
        // User doesn't exist yet - they need to complete onboarding
        // Return basic Auth0 info so they can access onboarding endpoints
        console.log('New user detected (no invitation found), email:', email);
        return {
          id: null,
          auth0Id: payload.sub,
          email: email,
          role: null,
          organizationId: null,
          name: name,
          picture: payload.picture,
          sub: payload.sub, // Include sub for onboarding service
        };
      }

      console.log(`User validated from Auth0: ${user.email}, org: ${user.organizationId}, role: ${user.role}`);
      return {
        id: user.id,
        auth0Id: user.auth0Id,
        email: user.email || email,
        role: user.role,
        organizationId: user.organizationId,
        name: name,
        picture: payload.picture,
        sub: payload.sub,
      };
    }

    // Validate user exists and is active
    const user = await this.authService.validateUser(userId, organizationId);
    
    if (!user) {
      throw new UnauthorizedException('User not found or deactivated');
    }

    // Return authenticated user object that will be attached to request
    return {
      id: user.id,
      auth0Id: user.auth0Id,
      email: user.email,
      role: user.role,
      organizationId: user.organizationId,
      name: payload.name || user.email,
      picture: payload.picture,
      sub: payload.sub,
    };
  }
}

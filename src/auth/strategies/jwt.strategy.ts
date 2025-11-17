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
  async validate(payload: JwtPayload): Promise<AuthenticatedUser> {
    console.log('JWT Payload received:', JSON.stringify(payload, null, 2));
    
    // Extract email - it might be in payload.email or we need to fetch from userinfo
    const email = payload.email || `${payload.sub}@temp.auth0`; // Temporary fallback
    const name = payload.name;
    
    // Extract custom claims from Auth0
    const organizationId = payload['https://ldv-bridge.com/organizationId'];
    const role = payload['https://ldv-bridge.com/role'];
    const userId = payload['https://ldv-bridge.com/userId'];

    // If no custom claims, this might be the first login
    // We need to look up the user
    if (!userId || !organizationId) {
      const user = await this.authService.validateUserFromAuth0(
        payload.sub,
        email,
      );
      
      if (!user) {
        // User doesn't exist yet - they need to complete onboarding
        // Return basic Auth0 info so they can access onboarding endpoints
        console.log('New user detected, email:', email);
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

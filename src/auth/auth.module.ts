import { Module } from '@nestjs/common';
import { PassportModule } from '@nestjs/passport';
import { JwtModule } from '@nestjs/jwt';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { APP_GUARD } from '@nestjs/core';

import { AuthService } from './auth.service';
import { AuthController } from './auth.controller';
import { JwtStrategy } from './strategies/jwt.strategy';
import { JwtAuthGuard } from './guards/jwt-auth.guard';
import { RolesGuard } from './guards/roles.guard';

/**
 * Authentication Module
 * Provides Auth0 JWT authentication and RBAC
 */
@Module({
  imports: [
    PassportModule.register({ defaultStrategy: 'jwt' }),
    JwtModule.registerAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: async (configService: ConfigService) => ({
        secret: configService.get<string>('JWT_SECRET'),
        signOptions: {
          expiresIn: '24h',
        },
      }),
    }),
  ],
  providers: [
    AuthService,
    JwtStrategy,
    // Apply JwtAuthGuard globally to all routes
    // Use @Public() decorator to bypass authentication
    {
      provide: APP_GUARD,
      useClass: JwtAuthGuard,
    },
    // Apply RolesGuard globally for RBAC
    {
      provide: APP_GUARD,
      useClass: RolesGuard,
    },
  ],
  controllers: [AuthController],
  exports: [AuthService, JwtStrategy],
})
export class AuthModule {}

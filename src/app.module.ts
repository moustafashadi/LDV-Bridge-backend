import { Module, MiddlewareConsumer, NestModule } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { AuthModule } from './auth/auth.module';
import { PrismaModule } from './prisma/prisma.module';
import { TenantContextMiddleware } from './common/middleware/tenant-context.middleware';
import { UsersModule } from './users/users.module';
import { OrganizationsModule } from './organizations/organizations.module';
import { OnboardingModule } from './onboarding/onboarding.module';

@Module({
  imports: [
    // Global configuration module
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: ['.env.development', '.env'],
    }),
    PrismaModule,
    AuthModule,
    OnboardingModule,
    UsersModule,
    OrganizationsModule,
  ],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer) {
    // Apply tenant context middleware to all routes
    consumer.apply(TenantContextMiddleware).forRoutes('*');
  }
}

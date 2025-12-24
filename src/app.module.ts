import { Module, MiddlewareConsumer, NestModule } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { APP_INTERCEPTOR } from '@nestjs/core';
import { BullModule } from '@nestjs/bull';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { AuthModule } from './auth/auth.module';
import { PrismaModule } from './prisma/prisma.module';
import { TenantContextMiddleware } from './common/middleware/tenant-context.middleware';
import { UsersModule } from './users/users.module';
import { OrganizationsModule } from './organizations/organizations.module';
import { OnboardingModule } from './onboarding/onboarding.module';
import { LoggerModule } from './common/logger/logger.module';
import { AuditModule } from './common/audit/audit.module';
import { HealthModule } from './health/health.module';
import { ConnectorsModule } from './connectors/connectors.module';
import { LoggingInterceptor } from './common/interceptors/logging.interceptor';
import { WebSocketModule } from './websocket/websocket.module';
import { PoliciesModule } from './policies/policies.module';
import { NotificationsModule } from './notifications/notifications.module';
import { SyncModule } from './sync/sync.module';
import { ComponentsModule } from './components/components.module';
import { ChangesModule } from './changes/changes.module';
import { ReviewsModule } from './reviews/reviews.module';
import { SandboxesModule } from './sandboxes/sandboxes.module';
import { AppsModule } from './apps/apps.module';
import { LinkedEnvironmentsModule } from './connectors/powerapps/linked-environments/linked-environments.module';
import { GitHubModule } from './github/github.module';
import { CicdModule } from './cicd/cicd.module';

@Module({
  imports: [
    // Global configuration module
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: ['.env.development', '.env'],
    }),
    // Bull Queue Configuration (for background jobs)
    BullModule.forRootAsync({
      imports: [ConfigModule],
      useFactory: async (configService: ConfigService) => ({
        redis: {
          host: configService.get<string>('REDIS_HOST', 'localhost'),
          port: configService.get<number>('REDIS_PORT', 6379),
          password: configService.get<string>('REDIS_PASSWORD'),
        },
      }),
      inject: [ConfigService],
    }),
    PrismaModule,
    LoggerModule, // Global logger
    AuditModule, // Global audit logging
    HealthModule, // Health check endpoints
    AuthModule,
    OnboardingModule,
    UsersModule,
    OrganizationsModule,
    ConnectorsModule, // Platform connectors (PowerApps & Mendix)
    WebSocketModule, // Real-time updates via Socket.IO
    PoliciesModule, // Policy Engine for governance
    NotificationsModule, // Multi-channel notification system
    SyncModule, // App sync service (manual & automatic)
    ComponentsModule, // Component management & reusable library
    ChangesModule, // Change detection engine with diff & impact analysis
    ReviewsModule, // Code review workflow with approval system
    SandboxesModule, // Sandbox environments with provisioning
    AppsModule, // App access control and permissions
    LinkedEnvironmentsModule, // Linked external environments (PowerApps)
    GitHubModule, // GitHub integration for version control
    CicdModule, // CI/CD pipeline integration with GitHub Actions
  ],
  controllers: [AppController],
  providers: [
    AppService,
    // Global logging interceptor
    {
      provide: APP_INTERCEPTOR,
      useClass: LoggingInterceptor,
    },
  ],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer) {
    // Apply tenant context middleware to all routes
    consumer.apply(TenantContextMiddleware).forRoutes('*');
  }
}

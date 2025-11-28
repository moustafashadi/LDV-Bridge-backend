import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bull';
import { JwtModule } from '@nestjs/jwt';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { NotificationsController } from './notifications.controller';
import { NotificationsService } from './notifications.service';
import { EmailService } from './email/email.service';
import { NotificationsGateway } from './websocket/notifications.gateway';
import { PrismaModule } from '../prisma/prisma.module';
import { EmailProcessor } from './processors/email.processor';

/**
 * Notifications Module
 * Provides multi-channel notification system (in-app, email, WebSocket)
 */
@Module({
  imports: [
    PrismaModule,
    JwtModule.registerAsync({
      imports: [ConfigModule],
      useFactory: async (configService: ConfigService) => ({
        secret: configService.get<string>('AUTH0_SECRET') || 'your-secret-key',
        signOptions: { expiresIn: '1d' },
      }),
      inject: [ConfigService],
    }),
    BullModule.registerQueue({
      name: 'notifications',
    }),
  ],
  controllers: [NotificationsController],
  providers: [
    NotificationsService,
    EmailService,
    NotificationsGateway,
    EmailProcessor,
  ],
  exports: [NotificationsService], // Export for use in other modules
})
export class NotificationsModule {}

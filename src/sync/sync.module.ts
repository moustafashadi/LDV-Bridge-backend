import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bull';
import { ScheduleModule } from '@nestjs/schedule';
import { JwtModule } from '@nestjs/jwt';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { SyncService } from './sync.service';
import { SyncController } from './sync.controller';
import { SyncProcessor } from './processors/sync.processor';
import { PrismaModule } from '../prisma/prisma.module';
import { PowerAppsModule } from '../connectors/powerapps/powerapps.module';
import { MendixModule } from '../connectors/mendix/mendix.module';

@Module({
  imports: [
    PrismaModule,
    PowerAppsModule,
    MendixModule,
    ScheduleModule.forRoot(), // Enable cron jobs
    BullModule.registerQueue({
      name: 'app-sync',
      defaultJobOptions: {
        attempts: 3, // Retry 3 times on failure
        backoff: {
          type: 'exponential',
          delay: 2000, // Start with 2s, then 4s, then 8s
        },
        removeOnComplete: {
          age: 7 * 24 * 60 * 60, // Keep completed jobs for 7 days
          count: 1000, // Keep last 1000 completed jobs
        },
        removeOnFail: {
          age: 30 * 24 * 60 * 60, // Keep failed jobs for 30 days
        },
      },
    }),
    JwtModule.registerAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: async (configService: ConfigService) => ({
        secret: configService.get<string>('AUTH0_SECRET'),
        signOptions: {
          expiresIn: '1d',
        },
      }),
    }),
  ],
  controllers: [SyncController],
  providers: [SyncService, SyncProcessor],
  exports: [SyncService],
})
export class SyncModule {}

import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { MendixController } from './mendix.controller';
import { MendixService } from './mendix.service';
import { TokenManagerService } from '../services/token-manager.service';
import { PrismaModule } from '../../prisma/prisma.module';

@Module({
  imports: [
    ConfigModule,
    PrismaModule,
  ],
  controllers: [MendixController],
  providers: [
    MendixService,
    TokenManagerService,
  ],
  exports: [MendixService],
})
export class MendixModule {}

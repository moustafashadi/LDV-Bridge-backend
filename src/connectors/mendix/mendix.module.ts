import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { MendixController } from './mendix.controller';
import { MendixService } from './mendix.service';
import { TokenManagerService } from '../services/token-manager.service';
import { PrismaModule } from '../../prisma/prisma.module';
import { WebSocketModule } from '../../websocket/websocket.module';

@Module({
  imports: [
    ConfigModule,
    PrismaModule,
    WebSocketModule,
  ],
  controllers: [MendixController],
  providers: [
    MendixService,
    TokenManagerService,
  ],
  exports: [MendixService],
})
export class MendixModule {}

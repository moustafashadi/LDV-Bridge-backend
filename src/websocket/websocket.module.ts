import { Module } from '@nestjs/common';
import { ConnectorsWebSocketGateway } from './websocket.gateway';

/**
 * WebSocket Module
 * Provides real-time communication via Socket.IO
 */
@Module({
  providers: [ConnectorsWebSocketGateway],
  exports: [ConnectorsWebSocketGateway],
})
export class WebSocketModule {}

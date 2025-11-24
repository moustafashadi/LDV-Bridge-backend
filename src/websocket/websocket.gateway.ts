import {
  WebSocketGateway,
  WebSocketServer,
  OnGatewayInit,
  OnGatewayConnection,
  OnGatewayDisconnect,
  SubscribeMessage,
  MessageBody,
  ConnectedSocket,
} from '@nestjs/websockets';
import { Logger, UseGuards } from '@nestjs/common';
import { Server, Socket } from 'socket.io';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import type { AuthenticatedUser } from '../auth/interfaces/authenticated-user.interface';

/**
 * WebSocket Gateway for real-time updates
 * Emits events for connector status changes and app sync updates
 */
@WebSocketGateway({
  cors: {
    origin: process.env.CORS_ORIGIN || 'http://localhost:3000',
    credentials: true,
  },
  namespace: '/',
})
export class ConnectorsWebSocketGateway
  implements OnGatewayInit, OnGatewayConnection, OnGatewayDisconnect
{
  @WebSocketServer()
  server: Server;

  private readonly logger = new Logger(WebSocketGateway.name);
  private connectedClients = new Map<string, Socket>();

  afterInit(server: Server) {
    this.logger.log('WebSocket Gateway initialized');
  }

  handleConnection(client: Socket, ...args: any[]) {
    this.logger.log(`Client connected: ${client.id}`);
    this.connectedClients.set(client.id, client);

    // Send welcome message
    client.emit('connected', {
      clientId: client.id,
      timestamp: new Date().toISOString(),
    });
  }

  handleDisconnect(client: Socket) {
    this.logger.log(`Client disconnected: ${client.id}`);
    this.connectedClients.delete(client.id);
  }

  /**
   * Emit connector status change to all connected clients
   */
  emitConnectionStatusChanged(data: {
    platform: string;
    userId: string;
    status: string;
  }) {
    this.logger.log(
      `Emitting connection-status-changed: ${data.platform} - ${data.status}`,
    );
    
    this.server.emit('connection-status-changed', {
      ...data,
      timestamp: new Date().toISOString(),
    });
  }

  /**
   * Emit app synced event to all connected clients
   */
  emitAppSynced(data: {
    platform: string;
    appId: string;
    appName: string;
  }) {
    this.logger.log(`Emitting app-synced: ${data.platform} - ${data.appName}`);
    
    this.server.emit('app-synced', {
      ...data,
      timestamp: new Date().toISOString(),
    });
  }

  /**
   * Send message to specific user's sockets
   */
  emitToUser(userId: string, event: string, data: any) {
    // In a production app, you'd track userId -> socketId mapping
    // For now, we broadcast to all clients
    this.server.emit(event, data);
  }

  /**
   * Ping handler for connection testing
   */
  @SubscribeMessage('ping')
  handlePing(@ConnectedSocket() client: Socket): void {
    client.emit('pong', {
      timestamp: new Date().toISOString(),
    });
  }

  /**
   * Get connected clients count
   */
  getConnectedClientsCount(): number {
    return this.connectedClients.size;
  }
}

import {
  WebSocketGateway,
  WebSocketServer,
  SubscribeMessage,
  OnGatewayConnection,
  OnGatewayDisconnect,
  ConnectedSocket,
  MessageBody,
} from '@nestjs/websockets';
import { Server, Socket } from 'socket.io';
import { Logger } from '@nestjs/common';

/**
 * WebSocket Gateway for real-time change notifications
 * Clients can subscribe to sandbox-specific rooms to receive updates
 */
@WebSocketGateway({
  cors: {
    origin: process.env.FRONTEND_URL || 'http://localhost:3000',
    credentials: true,
  },
  namespace: '/changes',
})
export class ChangesGateway implements OnGatewayConnection, OnGatewayDisconnect {
  @WebSocketServer()
  server: Server;

  private readonly logger = new Logger(ChangesGateway.name);

  /**
   * Handle client connection
   */
  handleConnection(client: Socket) {
    this.logger.log(`Client connected: ${client.id}`);
  }

  /**
   * Handle client disconnection
   */
  handleDisconnect(client: Socket) {
    this.logger.log(`Client disconnected: ${client.id}`);
  }

  /**
   * Subscribe to changes for a specific sandbox
   */
  @SubscribeMessage('subscribe:sandbox')
  handleSubscribeSandbox(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: { sandboxId: string },
  ) {
    const room = `sandbox:${data.sandboxId}`;
    client.join(room);
    this.logger.log(`Client ${client.id} subscribed to ${room}`);
    return { success: true, room };
  }

  /**
   * Unsubscribe from sandbox updates
   */
  @SubscribeMessage('unsubscribe:sandbox')
  handleUnsubscribeSandbox(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: { sandboxId: string },
  ) {
    const room = `sandbox:${data.sandboxId}`;
    client.leave(room);
    this.logger.log(`Client ${client.id} unsubscribed from ${room}`);
    return { success: true, room };
  }

  /**
   * Emit change detected event to sandbox subscribers
   */
  emitChangeDetected(sandboxId: string, change: any) {
    const room = `sandbox:${sandboxId}`;
    this.server.to(room).emit('change:detected', {
      sandboxId,
      change,
      timestamp: new Date().toISOString(),
    });
    this.logger.log(`Emitted change:detected to ${room}`);
  }

  /**
   * Emit change updated event
   */
  emitChangeUpdated(sandboxId: string, change: any) {
    const room = `sandbox:${sandboxId}`;
    this.server.to(room).emit('change:updated', {
      sandboxId,
      change,
      timestamp: new Date().toISOString(),
    });
    this.logger.log(`Emitted change:updated to ${room}`);
  }

  /**
   * Emit change deleted/undone event
   */
  emitChangeDeleted(sandboxId: string, changeId: string) {
    const room = `sandbox:${sandboxId}`;
    this.server.to(room).emit('change:deleted', {
      sandboxId,
      changeId,
      timestamp: new Date().toISOString(),
    });
    this.logger.log(`Emitted change:deleted to ${room}`);
  }

  /**
   * Emit change restored event
   */
  emitChangeRestored(sandboxId: string, change: any) {
    const room = `sandbox:${sandboxId}`;
    this.server.to(room).emit('change:restored', {
      sandboxId,
      change,
      timestamp: new Date().toISOString(),
    });
    this.logger.log(`Emitted change:restored to ${room}`);
  }

  /**
   * Emit sync started event
   */
  emitSyncStarted(sandboxId: string) {
    const room = `sandbox:${sandboxId}`;
    this.server.to(room).emit('sync:started', {
      sandboxId,
      timestamp: new Date().toISOString(),
    });
    this.logger.log(`Emitted sync:started to ${room}`);
  }

  /**
   * Emit sync completed event
   */
  emitSyncCompleted(sandboxId: string, changeCount: number) {
    const room = `sandbox:${sandboxId}`;
    this.server.to(room).emit('sync:completed', {
      sandboxId,
      changeCount,
      timestamp: new Date().toISOString(),
    });
    this.logger.log(`Emitted sync:completed to ${room} (${changeCount} changes)`);
  }
}

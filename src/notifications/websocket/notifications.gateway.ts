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
import { Logger, UseGuards } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';

/**
 * WebSocket Gateway for Real-Time Notifications
 * Handles WebSocket connections and notification broadcasting
 */
@WebSocketGateway({
  cors: {
    origin: '*', // In production, restrict to frontend URL
    credentials: true,
  },
  namespace: '/notifications',
})
export class NotificationsGateway implements OnGatewayConnection, OnGatewayDisconnect {
  @WebSocketServer()
  server: Server;

  private readonly logger = new Logger(NotificationsGateway.name);
  private connectedClients: Map<string, Set<string>> = new Map(); // userId -> Set of socketIds

  constructor(
    private readonly jwtService: JwtService,
    private readonly configService: ConfigService,
  ) {}

  /**
   * Handle client connection
   */
  async handleConnection(client: Socket): Promise<void> {
    try {
      // Extract token from handshake
      const token = client.handshake.auth.token || client.handshake.headers.authorization?.split(' ')[1];

      if (!token) {
        this.logger.warn(`Client ${client.id} connected without authentication token`);
        client.disconnect();
        return;
      }

      // Verify JWT token
      const payload = await this.verifyToken(token);
      if (!payload || !payload.sub) {
        this.logger.warn(`Client ${client.id} provided invalid token`);
        client.disconnect();
        return;
      }

      const userId = payload.sub;

      // Store user ID in socket data
      client.data.userId = userId;

      // Join user-specific room
      await client.join(`user:${userId}`);

      // Track connected client
      if (!this.connectedClients.has(userId)) {
        this.connectedClients.set(userId, new Set());
      }
      this.connectedClients.get(userId)!.add(client.id);

      this.logger.log(`Client ${client.id} connected for user ${userId} (${this.connectedClients.get(userId)!.size} active sessions)`);

      // Send connection success event
      client.emit('connected', { 
        message: 'Connected to notification service',
        userId 
      });
    } catch (error) {
      this.logger.error(`Connection error for client ${client.id}: ${error.message}`);
      client.disconnect();
    }
  }

  /**
   * Handle client disconnection
   */
  handleDisconnect(client: Socket): void {
    const userId = client.data.userId;

    if (userId) {
      const userClients = this.connectedClients.get(userId);
      if (userClients) {
        userClients.delete(client.id);
        if (userClients.size === 0) {
          this.connectedClients.delete(userId);
        }
      }

      this.logger.log(`Client ${client.id} disconnected for user ${userId}`);
    } else {
      this.logger.log(`Client ${client.id} disconnected (no user association)`);
    }
  }

  /**
   * Verify JWT token
   */
  private async verifyToken(token: string): Promise<any> {
    try {
      const secret = this.configService.get<string>('AUTH0_SECRET') || 'your-secret-key';
      const payload = await this.jwtService.verifyAsync(token, { secret });
      return payload;
    } catch (error) {
      this.logger.error(`Token verification failed: ${error.message}`);
      return null;
    }
  }

  /**
   * Send notification to specific user
   * Called by NotificationsService
   */
  async sendNotificationToUser(
    userId: string,
    notification: {
      id: string;
      type: string;
      title: string;
      message: string;
      data?: any;
      createdAt: Date;
    },
  ): Promise<boolean> {
    try {
      const room = `user:${userId}`;
      
      // Check if user has any connected clients
      const userClients = this.connectedClients.get(userId);
      if (!userClients || userClients.size === 0) {
        this.logger.log(`No connected clients for user ${userId} - notification will be delivered when they connect`);
        return false;
      }

      // Emit to user's room (all their connected devices)
      this.server.to(room).emit('notification', notification);

      this.logger.log(`Notification sent to user ${userId} (${userClients.size} clients)`);
      return true;
    } catch (error) {
      this.logger.error(`Failed to send notification to user ${userId}: ${error.message}`);
      return false;
    }
  }

  /**
   * Broadcast notification to all connected users (system-wide)
   */
  async broadcastNotification(notification: any): Promise<void> {
    this.server.emit('notification', notification);
    this.logger.log('Notification broadcast to all connected clients');
  }

  /**
   * Send notification read event
   */
  async sendReadEvent(userId: string, notificationId: string): Promise<void> {
    const room = `user:${userId}`;
    this.server.to(room).emit('notification:read', { notificationId });
  }

  /**
   * Send notification deleted event
   */
  async sendDeletedEvent(userId: string, notificationId: string): Promise<void> {
    const room = `user:${userId}`;
    this.server.to(room).emit('notification:deleted', { notificationId });
  }

  /**
   * Handle notification acknowledgment from client
   */
  @SubscribeMessage('notification:ack')
  handleNotificationAck(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: { notificationId: string },
  ): void {
    this.logger.log(`Client ${client.id} acknowledged notification ${data.notificationId}`);
  }

  /**
   * Handle ping from client (keep-alive)
   */
  @SubscribeMessage('ping')
  handlePing(@ConnectedSocket() client: Socket): void {
    client.emit('pong', { timestamp: new Date().toISOString() });
  }

  /**
   * Get connected clients count
   */
  getConnectedClientsCount(): number {
    return this.server.sockets.sockets.size;
  }

  /**
   * Get connected users count
   */
  getConnectedUsersCount(): number {
    return this.connectedClients.size;
  }

  /**
   * Check if user is connected
   */
  isUserConnected(userId: string): boolean {
    return this.connectedClients.has(userId) && this.connectedClients.get(userId)!.size > 0;
  }
}

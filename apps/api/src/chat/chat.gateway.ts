import { HttpException, Logger } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import {
  ConnectedSocket,
  MessageBody,
  type OnGatewayConnection,
  SubscribeMessage,
  WebSocketGateway,
  WsException,
} from '@nestjs/websockets';
import type { Socket } from 'socket.io';
import type { JwtPayload } from '../auth/jwt.strategy.js';
import { ChatService, type ChatReply } from './chat.service.js';

export interface SendMessagePayload {
  conversationId: string;
  content: string;
}

@WebSocketGateway({ cors: true })
export class ChatGateway implements OnGatewayConnection {
  private readonly logger = new Logger(ChatGateway.name);

  constructor(
    private readonly jwtService: JwtService,
    private readonly chatService: ChatService,
  ) {}

  /**
   * Аутентификация по JWT из `socket.handshake.auth.token`.
   * Невалидный токен — сокет сразу отключается.
   */
  async handleConnection(client: Socket): Promise<void> {
    const token: unknown = client.handshake.auth?.token;

    if (typeof token !== 'string' || token.length === 0) {
      this.logger.warn('WebSocket connection rejected: token is missing');
      client.disconnect();
      return;
    }

    try {
      const payload = await this.jwtService.verifyAsync<JwtPayload>(token);
      (client.data as { userId?: string }).userId = payload.sub;
    } catch {
      this.logger.warn('WebSocket connection rejected: invalid token');
      client.disconnect();
    }
  }

  @SubscribeMessage('send_message')
  async handleSendMessage(
    @ConnectedSocket() client: Socket,
    @MessageBody() payload: SendMessagePayload,
  ): Promise<ChatReply> {
    const userId = (client.data as { userId?: string }).userId;

    if (!userId) {
      throw new WsException('Пользователь не аутентифицирован');
    }

    if (
      !payload ||
      typeof payload.conversationId !== 'string' ||
      typeof payload.content !== 'string' ||
      payload.content.trim() === ''
    ) {
      throw new WsException('Ожидается { conversationId, content }');
    }

    try {
      return await this.chatService.handleMessage(
        userId,
        payload.conversationId,
        payload.content,
      );
    } catch (error) {
      // HttpException (404/403) по умолчанию превращается в "Internal server error";
      // передаём клиенту осмысленный статус и сообщение.
      if (error instanceof HttpException) {
        throw new WsException({
          statusCode: error.getStatus(),
          message: error.message,
        });
      }

      throw error;
    }
  }
}

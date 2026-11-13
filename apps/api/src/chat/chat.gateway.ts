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
import {
  DEFAULT_OFFICE_AGENT_ID,
  OFFICE_TASKS,
  type OfficeEvent,
} from './office-events.js';

export interface SendMessagePayload {
  conversationId: string;
  content: string;
}

export interface ApproveActionPayload {
  conversationId: string;
  approved?: boolean;
}

/** Текст ошибки авторизации у LLM-провайдера: его распознаёт UI. */
export const LLM_AUTH_ERROR_MESSAGE = 'LLM Error: Unauthorized';

/** Ошибка 401 или незаданный ключ провайдера (OpenAI SDK, LangChain, axios). */
function isLlmAuthError(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) {
    return false;
  }

  const candidate = error as {
    status?: unknown;
    statusCode?: unknown;
    name?: unknown;
    code?: unknown;
    lc_error_code?: unknown;
    message?: unknown;
  };

  const message =
    typeof candidate.message === 'string'
      ? candidate.message.toLowerCase()
      : '';

  return (
    candidate.status === 401 ||
    candidate.statusCode === 401 ||
    candidate.name === 'AuthenticationError' ||
    candidate.code === 'MODEL_AUTHENTICATION' ||
    candidate.lc_error_code === 'MODEL_AUTHENTICATION' ||
    message.includes('unauthorized') ||
    message.includes('iam_token') ||
    message.includes('api key') ||
    message.includes('credential') ||
    message.includes('не настроен')
  );
}

/** Машиночитаемый `code` из тела HttpException (единый формат ошибок API). */
function errorCodeOf(error: HttpException): string | undefined {
  const response = error.getResponse();

  if (
    typeof response !== 'object' ||
    response === null ||
    !('code' in response)
  ) {
    return undefined;
  }

  const code = (response as { code?: unknown }).code;

  return typeof code === 'string' ? code : undefined;
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

  /**
   * Отправляет событие AI-Офису. Визуальный слой опционален: если клиент
   * его не слушает, событие просто игнорируется.
   */
  sendOfficeEvent(client: Socket, event: OfficeEvent): void {
    client.emit('office_event', event);
  }

  /**
   * Ручной статус ожидания одобрения. Нужен до появления approval-flow:
   * плагин и тесты могут выставить статус явно.
   */
  sendWaitingApproval(
    client: Socket,
    conversationId: string,
    task: string = OFFICE_TASKS.waitingApproval,
  ): void {
    this.sendOfficeEvent(client, {
      conversationId,
      agentId: DEFAULT_OFFICE_AGENT_ID,
      status: 'waiting_approval',
      task,
      reason: 'approval',
    });
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

    this.sendOfficeEvent(client, {
      conversationId: payload.conversationId,
      agentId: DEFAULT_OFFICE_AGENT_ID,
      status: 'working',
      task: OFFICE_TASKS.analyzing,
    });

    try {
      const reply = await this.chatService.streamMessage(
        userId,
        payload.conversationId,
        payload.content,
        (text) => {
          client.emit('stream_delta', {
            conversationId: payload.conversationId,
            text,
          });
        },
        (event) => this.sendOfficeEvent(client, event),
      );

      client.emit('stream_end', { conversationId: payload.conversationId });

      return reply;
    } catch (error) {
      // HttpException (404/403/429) по умолчанию превращается в "Internal server error";
      // передаём клиенту осмысленный статус, сообщение и код ошибки.
      if (error instanceof HttpException) {
        const code = errorCodeOf(error);

        throw new WsException({
          statusCode: error.getStatus(),
          message: error.message,
          ...(code === undefined ? {} : { code }),
        });
      }

      // LLM-провайдер ответил 401 (истёк IAM-токен, неверный ключ): UI
      // показывает подсказку «проверьте ключи в Пульте управления».
      if (isLlmAuthError(error)) {
        throw new WsException({
          statusCode: 401,
          message: LLM_AUTH_ERROR_MESSAGE,
        });
      }

      throw error;
    }
  }

  /**
   * Подтверждение действия, которое агент пометил как `waiting_approval`.
   * Пока это имитация: логируем решение и возвращаем агента в `working`.
   */
  @SubscribeMessage('approve_action')
  handleApproveAction(
    @ConnectedSocket() client: Socket,
    @MessageBody() payload: ApproveActionPayload,
  ): void {
    const userId = (client.data as { userId?: string }).userId;

    if (!userId) {
      throw new WsException('Пользователь не аутентифицирован');
    }

    if (
      !payload ||
      typeof payload.conversationId !== 'string' ||
      payload.conversationId.trim() === ''
    ) {
      throw new WsException('Ожидается { conversationId }');
    }

    const resumed = this.chatService.approveAction(
      payload.conversationId,
      userId,
    );

    this.logger.log(
      `Действие одобрено: conversationId=${payload.conversationId}, userId=${userId}, approved=${payload.approved !== false}, resumed=${resumed}`,
    );

    this.sendOfficeEvent(client, {
      conversationId: payload.conversationId,
      agentId: DEFAULT_OFFICE_AGENT_ID,
      status: 'working',
      task: OFFICE_TASKS.resumingAfterApproval,
    });
  }
}

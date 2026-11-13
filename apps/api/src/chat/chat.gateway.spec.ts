import { ForbiddenException, Logger } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { WsException } from '@nestjs/websockets';
import type { Socket } from 'socket.io';
import { ChatGateway } from './chat.gateway.js';
import { DailyTokenLimitException } from '../llm/daily-token-limit.exception.js';
import type { ChatService } from './chat.service.js';

type MockFn = ReturnType<typeof vi.fn>;

const CONVERSATION_ID = '11111111-1111-1111-1111-111111111111';
const USER_ID = '22222222-2222-2222-2222-222222222222';

interface JwtMock {
  verifyAsync: MockFn;
}

interface ChatServiceMock {
  streamMessage: MockFn;
  approveAction: MockFn;
}

interface SocketMock {
  handshake: { auth: Record<string, unknown> };
  data: Record<string, unknown>;
  disconnect: MockFn;
  emit: MockFn;
}

function createSocket(auth: Record<string, unknown> = {}): SocketMock {
  return {
    handshake: { auth },
    data: {},
    disconnect: vi.fn(),
    emit: vi.fn(),
  };
}

describe('ChatGateway', () => {
  let gateway: ChatGateway;
  let jwt: JwtMock;
  let chatService: ChatServiceMock;

  beforeEach(() => {
    jwt = { verifyAsync: vi.fn() };
    chatService = { streamMessage: vi.fn(), approveAction: vi.fn() };

    gateway = new ChatGateway(
      jwt as unknown as JwtService,
      chatService as unknown as ChatService,
    );
  });

  describe('handleConnection', () => {
    it('сохраняет userId из валидного токена', async () => {
      const socket = createSocket({ token: 'valid-token' });
      jwt.verifyAsync.mockResolvedValue({ sub: USER_ID });

      await gateway.handleConnection(socket as unknown as Socket);

      expect(jwt.verifyAsync).toHaveBeenCalledWith('valid-token');
      expect(socket.data.userId).toBe(USER_ID);
      expect(socket.disconnect).not.toHaveBeenCalled();
    });

    it('отключает сокет без токена', async () => {
      const socket = createSocket();

      await gateway.handleConnection(socket as unknown as Socket);

      expect(socket.disconnect).toHaveBeenCalledTimes(1);
      expect(socket.data.userId).toBeUndefined();
    });

    it('отключает сокет с невалидным токеном', async () => {
      const socket = createSocket({ token: 'broken-token' });
      jwt.verifyAsync.mockRejectedValue(new Error('invalid signature'));

      await gateway.handleConnection(socket as unknown as Socket);

      expect(socket.disconnect).toHaveBeenCalledTimes(1);
      expect(socket.data.userId).toBeUndefined();
    });
  });

  describe('handleSendMessage', () => {
    it('отправляет stream_delta на каждый чанк и stream_end в конце', async () => {
      const socket = createSocket();
      socket.data.userId = USER_ID;
      chatService.streamMessage.mockImplementation(
        async (
          _userId: string,
          conversationId: string,
          _content: string,
          onDelta: (text: string) => void,
        ) => {
          onDelta('При');
          onDelta('вет');

          return { conversationId, reply: 'Привет' };
        },
      );

      const result = await gateway.handleSendMessage(
        socket as unknown as Socket,
        { conversationId: CONVERSATION_ID, content: 'привет' },
      );

      expect(result).toEqual({
        conversationId: CONVERSATION_ID,
        reply: 'Привет',
      });
      expect(chatService.streamMessage).toHaveBeenCalledWith(
        USER_ID,
        CONVERSATION_ID,
        'привет',
        expect.any(Function),
        expect.any(Function),
      );
      expect(socket.emit).toHaveBeenNthCalledWith(1, 'office_event', {
        conversationId: CONVERSATION_ID,
        agentId: 'default',
        status: 'working',
        task: 'Анализ запроса',
      });
      expect(socket.emit).toHaveBeenNthCalledWith(2, 'stream_delta', {
        conversationId: CONVERSATION_ID,
        text: 'При',
      });
      expect(socket.emit).toHaveBeenNthCalledWith(3, 'stream_delta', {
        conversationId: CONVERSATION_ID,
        text: 'вет',
      });
      expect(socket.emit).toHaveBeenLastCalledWith('stream_end', {
        conversationId: CONVERSATION_ID,
      });
    });

    it('отправляет office_event при вызове инструмента', async () => {
      const socket = createSocket();
      socket.data.userId = USER_ID;
      chatService.streamMessage.mockImplementation(
        async (
          _userId: string,
          conversationId: string,
          _content: string,
          _onDelta: (text: string) => void,
          onOfficeEvent: (event: {
            conversationId: string;
            agentId: string;
            status: string;
            task: string;
          }) => void,
        ) => {
          onOfficeEvent({
            conversationId,
            agentId: 'default',
            status: 'working',
            task: 'Веб-поиск',
          });

          return { conversationId, reply: 'Готово' };
        },
      );

      await gateway.handleSendMessage(socket as unknown as Socket, {
        conversationId: CONVERSATION_ID,
        content: 'найди новости',
      });

      const officeEvents = socket.emit.mock.calls
        .filter(([event]) => event === 'office_event')
        .map(([, event]) => event);

      expect(officeEvents).toEqual([
        {
          conversationId: CONVERSATION_ID,
          agentId: 'default',
          status: 'working',
          task: 'Анализ запроса',
        },
        {
          conversationId: CONVERSATION_ID,
          agentId: 'default',
          status: 'working',
          task: 'Веб-поиск',
        },
      ]);
    });

    it('умеет отправлять статус waiting_approval вручную', () => {
      const socket = createSocket();

      gateway.sendWaitingApproval(socket as unknown as Socket, CONVERSATION_ID);

      expect(socket.emit).toHaveBeenCalledWith('office_event', {
        conversationId: CONVERSATION_ID,
        agentId: 'default',
        status: 'waiting_approval',
        task: 'Ожидание подтверждения',
        reason: 'approval',
      });
    });

    it('запрещает отправку без аутентификации', async () => {
      const socket = createSocket();

      await expect(
        gateway.handleSendMessage(socket as unknown as Socket, {
          conversationId: CONVERSATION_ID,
          content: 'привет',
        }),
      ).rejects.toBeInstanceOf(WsException);
      expect(chatService.streamMessage).not.toHaveBeenCalled();
    });

    it('отклоняет пустой payload', async () => {
      const socket = createSocket();
      socket.data.userId = USER_ID;

      await expect(
        gateway.handleSendMessage(socket as unknown as Socket, {
          conversationId: '',
          content: '   ',
        }),
      ).rejects.toBeInstanceOf(WsException);
    });

    it('передаёт клиенту осмысленную ошибку прав из сервиса', async () => {
      const socket = createSocket();
      socket.data.userId = USER_ID;
      chatService.streamMessage.mockRejectedValue(
        new ForbiddenException('Диалог принадлежит другому пользователю'),
      );

      await expect(
        gateway.handleSendMessage(socket as unknown as Socket, {
          conversationId: CONVERSATION_ID,
          content: 'привет',
        }),
      ).rejects.toMatchObject({
        error: {
          statusCode: 403,
          message: 'Диалог принадлежит другому пользователю',
        },
      });
    });

    it('передаёт code ошибки лимита токенов в WsException', async () => {
      const socket = createSocket();
      socket.data.userId = USER_ID;
      chatService.streamMessage.mockRejectedValue(
        new DailyTokenLimitException(),
      );

      await expect(
        gateway.handleSendMessage(socket as unknown as Socket, {
          conversationId: CONVERSATION_ID,
          content: 'привет',
        }),
      ).rejects.toMatchObject({
        error: {
          statusCode: 429,
          message: 'Дневной лимит токенов исчерпан. Попробуйте завтра',
          code: 'errors.daily_token_limit',
        },
      });
    });
  });

  describe('handleApproveAction', () => {
    it('возобновляет граф, стримит ответ и завершает поток', async () => {
      const socket = createSocket();
      socket.data.userId = USER_ID;
      const log = vi
        .spyOn(Logger.prototype, 'log')
        .mockImplementation(() => {});
      chatService.approveAction.mockImplementation(
        async (
          _userId: string,
          _conversationId: string,
          _approved: boolean,
          onDelta?: (text: string) => void,
          onOfficeEvent?: (event: unknown) => void,
        ) => {
          onOfficeEvent?.({
            conversationId: CONVERSATION_ID,
            agentId: 'default',
            status: 'working',
            task: 'Продолжение после одобрения',
          });
          onDelta?.('готово');

          return { conversationId: CONVERSATION_ID, reply: 'готово' };
        },
      );

      const result = await gateway.handleApproveAction(
        socket as unknown as Socket,
        {
          conversationId: CONVERSATION_ID,
          approved: true,
        },
      );

      expect(chatService.approveAction).toHaveBeenCalledWith(
        USER_ID,
        CONVERSATION_ID,
        true,
        expect.any(Function),
        expect.any(Function),
      );
      expect(log).toHaveBeenCalledWith(
        expect.stringContaining(CONVERSATION_ID),
      );
      expect(socket.emit).toHaveBeenCalledWith('stream_delta', {
        conversationId: CONVERSATION_ID,
        text: 'готово',
      });
      expect(socket.emit).toHaveBeenCalledWith('stream_end', {
        conversationId: CONVERSATION_ID,
      });
      expect(socket.emit).toHaveBeenCalledWith('office_event', {
        conversationId: CONVERSATION_ID,
        agentId: 'default',
        status: 'working',
        task: 'Продолжение после одобрения',
      });
      expect(result).toEqual({ conversationId: CONVERSATION_ID, reply: 'готово' });

      log.mockRestore();
    });

    it('передаёт отказ в approveAction', async () => {
      const socket = createSocket();
      socket.data.userId = USER_ID;
      chatService.approveAction.mockResolvedValue({
        conversationId: CONVERSATION_ID,
        reply: 'Действие отклонено',
      });

      await gateway.handleApproveAction(socket as unknown as Socket, {
        conversationId: CONVERSATION_ID,
        approved: false,
      });

      expect(chatService.approveAction).toHaveBeenCalledWith(
        USER_ID,
        CONVERSATION_ID,
        false,
        expect.any(Function),
        expect.any(Function),
      );
    });

    it('отдаёт ошибку, если ожидания нет', async () => {
      const socket = createSocket();
      socket.data.userId = USER_ID;
      chatService.approveAction.mockResolvedValue(null);

      await expect(
        gateway.handleApproveAction(socket as unknown as Socket, {
          conversationId: CONVERSATION_ID,
        }),
      ).rejects.toBeInstanceOf(WsException);
      expect(socket.emit).not.toHaveBeenCalled();
    });

    it('запрещает одобрение без аутентификации', async () => {
      const socket = createSocket();

      await expect(
        gateway.handleApproveAction(socket as unknown as Socket, {
          conversationId: CONVERSATION_ID,
        }),
      ).rejects.toBeInstanceOf(WsException);
      expect(chatService.approveAction).not.toHaveBeenCalled();
      expect(socket.emit).not.toHaveBeenCalled();
    });
  });
});

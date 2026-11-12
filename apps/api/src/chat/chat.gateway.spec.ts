import { ForbiddenException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { WsException } from '@nestjs/websockets';
import type { Socket } from 'socket.io';
import { ChatGateway } from './chat.gateway.js';
import type { ChatService } from './chat.service.js';

type MockFn = ReturnType<typeof vi.fn>;

const CONVERSATION_ID = '11111111-1111-1111-1111-111111111111';
const USER_ID = '22222222-2222-2222-2222-222222222222';

interface JwtMock {
  verifyAsync: MockFn;
}

interface ChatServiceMock {
  handleMessage: MockFn;
}

interface SocketMock {
  handshake: { auth: Record<string, unknown> };
  data: Record<string, unknown>;
  disconnect: MockFn;
}

function createSocket(auth: Record<string, unknown> = {}): SocketMock {
  return { handshake: { auth }, data: {}, disconnect: vi.fn() };
}

describe('ChatGateway', () => {
  let gateway: ChatGateway;
  let jwt: JwtMock;
  let chatService: ChatServiceMock;

  beforeEach(() => {
    jwt = { verifyAsync: vi.fn() };
    chatService = { handleMessage: vi.fn() };

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
    it('передаёт userId из сокета в сервис', async () => {
      const socket = createSocket();
      socket.data.userId = USER_ID;
      chatService.handleMessage.mockResolvedValue({
        conversationId: CONVERSATION_ID,
        reply: 'ответ',
      });

      const result = await gateway.handleSendMessage(
        socket as unknown as Socket,
        { conversationId: CONVERSATION_ID, content: 'привет' },
      );

      expect(result).toEqual({
        conversationId: CONVERSATION_ID,
        reply: 'ответ',
      });
      expect(chatService.handleMessage).toHaveBeenCalledWith(
        USER_ID,
        CONVERSATION_ID,
        'привет',
      );
    });

    it('запрещает отправку без аутентификации', async () => {
      const socket = createSocket();

      await expect(
        gateway.handleSendMessage(socket as unknown as Socket, {
          conversationId: CONVERSATION_ID,
          content: 'привет',
        }),
      ).rejects.toBeInstanceOf(WsException);
      expect(chatService.handleMessage).not.toHaveBeenCalled();
    });

    it('отклоняет пустой payload', async () => {
      const socket = createSocket();
      socket.data.userId = USER_ID;

      await expect(
        gateway.handleSendMessage(
          socket as unknown as Socket,
          { conversationId: '', content: '   ' },
        ),
      ).rejects.toBeInstanceOf(WsException);
    });

    it('передаёт клиенту осмысленную ошибку прав из сервиса', async () => {
      const socket = createSocket();
      socket.data.userId = USER_ID;
      chatService.handleMessage.mockRejectedValue(
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
  });
});

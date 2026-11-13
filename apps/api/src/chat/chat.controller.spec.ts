import { UnauthorizedException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { ChatController } from './chat.controller.js';
import { ChatService } from './chat.service.js';

const USER_ID = '22222222-2222-2222-2222-222222222222';

type MockFn = ReturnType<typeof vi.fn>;

interface ChatServiceMock {
  createConversation: MockFn;
  clearMemory: MockFn;
  listPendingApprovals: MockFn;
}

type ControllerRequest = Parameters<ChatController['clearMemory']>[0];

interface TestUser {
  userId: string;
  email: string;
  role: string;
}

function createRequest(user?: TestUser): ControllerRequest {
  return { user } as unknown as ControllerRequest;
}

describe('ChatController', () => {
  let controller: ChatController;
  let chat: ChatServiceMock;

  beforeEach(async () => {
    chat = {
      createConversation: vi.fn(),
      clearMemory: vi.fn(),
      listPendingApprovals: vi.fn(),
    };

    const moduleRef: TestingModule = await Test.createTestingModule({
      controllers: [ChatController],
      providers: [{ provide: ChatService, useValue: chat }],
    }).compile();

    controller = moduleRef.get(ChatController);
  });

  describe('clearMemory', () => {
    it('удаляет долговременную память текущего пользователя (GDPR)', async () => {
      chat.clearMemory.mockResolvedValue({ deleted: 4 });

      await expect(
        controller.clearMemory(
          createRequest({
            userId: USER_ID,
            email: 'user@example.com',
            role: 'user',
          }),
        ),
      ).resolves.toEqual({ deleted: 4 });

      expect(chat.clearMemory).toHaveBeenCalledWith(USER_ID);
    });

    it('требует аутентификации', async () => {
      await expect(
        controller.clearMemory(createRequest()),
      ).rejects.toBeInstanceOf(UnauthorizedException);
      expect(chat.clearMemory).not.toHaveBeenCalled();
    });
  });

  describe('listPendingApprovals', () => {
    it('возвращает ожидающие подтверждения текущего пользователя', async () => {
      chat.listPendingApprovals.mockResolvedValue([
        {
          conversationId: '11111111-1111-1111-1111-111111111111',
          reason: 'payment',
          tools: ['publish_to_dzen'],
          createdAt: '2026-11-13T12:00:00.000Z',
        },
      ]);

      await expect(
        controller.listPendingApprovals(
          createRequest({
            userId: USER_ID,
            email: 'user@example.com',
            role: 'user',
          }),
        ),
      ).resolves.toEqual({
        items: [
          {
            conversationId: '11111111-1111-1111-1111-111111111111',
            reason: 'payment',
            tools: ['publish_to_dzen'],
            createdAt: '2026-11-13T12:00:00.000Z',
          },
        ],
      });

      expect(chat.listPendingApprovals).toHaveBeenCalledWith(USER_ID);
    });

    it('валидирует контракт ответа Zod-схемой', async () => {
      chat.listPendingApprovals.mockResolvedValue([
        {
          // Нарушение контракта: reason вне enum.
          conversationId: '11111111-1111-1111-1111-111111111111',
          reason: 'unknown',
          tools: [],
          createdAt: 'not-a-date',
        },
      ]);

      await expect(
        controller.listPendingApprovals(
          createRequest({
            userId: USER_ID,
            email: 'user@example.com',
            role: 'user',
          }),
        ),
      ).rejects.toThrow();
    });

    it('требует аутентификации', async () => {
      await expect(
        controller.listPendingApprovals(createRequest()),
      ).rejects.toBeInstanceOf(UnauthorizedException);
      expect(chat.listPendingApprovals).not.toHaveBeenCalled();
    });
  });
});

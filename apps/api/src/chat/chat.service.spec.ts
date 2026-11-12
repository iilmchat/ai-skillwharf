import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { LlmService } from '../llm/llm.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { ChatService } from './chat.service.js';

const CONVERSATION_ID = '11111111-1111-1111-1111-111111111111';
const USER_ID = '22222222-2222-2222-2222-222222222222';
const OTHER_USER_ID = '33333333-3333-3333-3333-333333333333';

type MockFn = ReturnType<typeof vi.fn>;

interface PrismaMock {
  conversation: { findUnique: MockFn; update: MockFn; create: MockFn };
  message: { create: MockFn; findMany: MockFn };
}

interface LlmMock {
  chat: MockFn;
}

describe('ChatService', () => {
  let service: ChatService;
  let prisma: PrismaMock;
  let llm: LlmMock;

  beforeEach(async () => {
    prisma = {
      conversation: {
        findUnique: vi.fn(),
        update: vi.fn(),
        create: vi.fn(),
      },
      message: { create: vi.fn(), findMany: vi.fn() },
    };
    llm = { chat: vi.fn() };

    const moduleRef: TestingModule = await Test.createTestingModule({
      providers: [
        ChatService,
        { provide: PrismaService, useValue: prisma },
        { provide: LlmService, useValue: llm },
      ],
    }).compile();

    service = moduleRef.get(ChatService);
  });

  describe('createConversation', () => {
    it('создаёт диалог для пользователя с заголовком по умолчанию', async () => {
      prisma.conversation.create.mockResolvedValue({ id: CONVERSATION_ID });

      const result = await service.createConversation(USER_ID);

      expect(result).toEqual({ id: CONVERSATION_ID });
      expect(prisma.conversation.create).toHaveBeenCalledWith({
        data: { userId: USER_ID, title: 'Новый диалог' },
        select: { id: true },
      });
    });

    it('использует переданный заголовок', async () => {
      prisma.conversation.create.mockResolvedValue({ id: CONVERSATION_ID });

      await service.createConversation(USER_ID, '  Мой чат  ');

      expect(prisma.conversation.create).toHaveBeenCalledWith({
        data: { userId: USER_ID, title: 'Мой чат' },
        select: { id: true },
      });
    });
  });

  describe('handleMessage', () => {
    it('сохраняет сообщения пользователя и ассистента и возвращает ответ LLM', async () => {
      prisma.conversation.findUnique.mockResolvedValue({
        id: CONVERSATION_ID,
        userId: USER_ID,
      });
      prisma.message.create.mockResolvedValue({});
      prisma.conversation.update.mockResolvedValue({});
      prisma.message.findMany.mockResolvedValue([
        { role: 'assistant', content: 'предыдущий ответ' },
        { role: 'user', content: 'привет' },
      ]);
      llm.chat.mockResolvedValue('ответ ассистента');

      const result = await service.handleMessage(
        USER_ID,
        CONVERSATION_ID,
        'привет',
      );

      expect(result).toEqual({
        conversationId: CONVERSATION_ID,
        reply: 'ответ ассистента',
      });

      expect(prisma.message.create).toHaveBeenNthCalledWith(1, {
        data: {
          conversationId: CONVERSATION_ID,
          role: 'user',
          content: 'привет',
        },
      });
      expect(prisma.message.create).toHaveBeenNthCalledWith(2, {
        data: {
          conversationId: CONVERSATION_ID,
          role: 'assistant',
          content: 'ответ ассистента',
        },
      });

      expect(prisma.message.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { conversationId: CONVERSATION_ID },
          orderBy: { createdAt: 'desc' },
          take: 10,
        }),
      );
      // В LLM история уходит в хронологическом порядке (старые → новые).
      expect(llm.chat).toHaveBeenCalledWith([
        { role: 'user', content: 'привет' },
        { role: 'assistant', content: 'предыдущий ответ' },
      ]);
    });

    it('запрещает писать в чужой диалог', async () => {
      prisma.conversation.findUnique.mockResolvedValue({
        id: CONVERSATION_ID,
        userId: OTHER_USER_ID,
      });

      await expect(
        service.handleMessage(USER_ID, CONVERSATION_ID, 'привет'),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(prisma.message.create).not.toHaveBeenCalled();
      expect(llm.chat).not.toHaveBeenCalled();
    });

    it('отклоняет сообщение в несуществующий диалог', async () => {
      prisma.conversation.findUnique.mockResolvedValue(null);

      await expect(
        service.handleMessage(USER_ID, CONVERSATION_ID, 'привет'),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(prisma.message.create).not.toHaveBeenCalled();
      expect(llm.chat).not.toHaveBeenCalled();
    });
  });
});

import { NotFoundException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { LlmService } from '../llm/llm.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { ChatService } from './chat.service.js';

const CONVERSATION_ID = '11111111-1111-1111-1111-111111111111';

type MockFn = ReturnType<typeof vi.fn>;

interface PrismaMock {
  conversation: { findUnique: MockFn; update: MockFn };
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
      conversation: { findUnique: vi.fn(), update: vi.fn() },
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

  it('сохраняет сообщения пользователя и ассистента и возвращает ответ LLM', async () => {
    prisma.conversation.findUnique.mockResolvedValue({ id: CONVERSATION_ID });
    prisma.message.create.mockResolvedValue({});
    prisma.conversation.update.mockResolvedValue({});
    prisma.message.findMany.mockResolvedValue([
      { role: 'assistant', content: 'предыдущий ответ' },
      { role: 'user', content: 'привет' },
    ]);
    llm.chat.mockResolvedValue('ответ ассистента');

    const result = await service.handleMessage(CONVERSATION_ID, 'привет');

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

  it('отклоняет сообщение в несуществующий диалог', async () => {
    prisma.conversation.findUnique.mockResolvedValue(null);

    await expect(
      service.handleMessage(CONVERSATION_ID, 'привет'),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(prisma.message.create).not.toHaveBeenCalled();
    expect(llm.chat).not.toHaveBeenCalled();
  });
});

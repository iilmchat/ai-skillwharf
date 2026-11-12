import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import {
  AIMessage,
  type BaseMessage,
  HumanMessage,
  ToolMessage,
} from '@langchain/core/messages';
import { Test, TestingModule } from '@nestjs/testing';
import { BillingService } from '../billing/billing.service.js';
import {
  LlmService,
  SANDBOX_TOOL_NAME,
} from '../llm/llm.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import type { SandboxService } from '../sandbox/sandbox.service.js';
import {
  ChatService,
  INSUFFICIENT_FUNDS_REPLY,
  SANDBOX_CALL_DESCRIPTION,
  SANDBOX_CALL_PRICE,
} from './chat.service.js';

const CONVERSATION_ID = '11111111-1111-1111-1111-111111111111';
const USER_ID = '22222222-2222-2222-2222-222222222222';
const OTHER_USER_ID = '33333333-3333-3333-3333-333333333333';

type MockFn = ReturnType<typeof vi.fn>;

interface PrismaMock {
  conversation: { findUnique: MockFn; update: MockFn; create: MockFn };
  message: { create: MockFn; findMany: MockFn };
}

interface SandboxMock {
  runCommand: MockFn;
}

interface BillingMock {
  chargeForSkill: MockFn;
}

function toolCallMessage(code: string): AIMessage {
  return new AIMessage({
    content: '',
    tool_calls: [{ id: 'call-1', name: SANDBOX_TOOL_NAME, args: { code } }],
  });
}

describe('ChatService', () => {
  let service: ChatService;
  let prisma: PrismaMock;
  let sandbox: SandboxMock;
  let billing: BillingMock;
  let llm: LlmService;
  let chatWithTools: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    prisma = {
      conversation: {
        findUnique: vi.fn(),
        update: vi.fn(),
        create: vi.fn(),
      },
      message: { create: vi.fn(), findMany: vi.fn() },
    };
    sandbox = { runCommand: vi.fn() };
    billing = { chargeForSkill: vi.fn() };

    // Настоящий LlmService нужен, чтобы граф получил реальный инструмент
    // песочницы; сам вызов модели подменяем.
    llm = new LlmService(sandbox as unknown as SandboxService);
    chatWithTools = vi.spyOn(llm, 'chatWithTools');

    const moduleRef: TestingModule = await Test.createTestingModule({
      providers: [
        ChatService,
        { provide: PrismaService, useValue: prisma },
        { provide: LlmService, useValue: llm },
        { provide: BillingService, useValue: billing },
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
    beforeEach(() => {
      prisma.conversation.findUnique.mockResolvedValue({
        id: CONVERSATION_ID,
        userId: USER_ID,
      });
      prisma.message.create.mockResolvedValue({});
      prisma.conversation.update.mockResolvedValue({});
    });

    it('сохраняет сообщения и возвращает ответ LLM', async () => {
      prisma.message.findMany.mockResolvedValue([
        { role: 'assistant', content: 'предыдущий ответ' },
        { role: 'user', content: 'привет' },
      ]);
      chatWithTools.mockResolvedValue(new AIMessage('ответ ассистента'));

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

      const [messages, tools] = chatWithTools.mock.calls[0] as [
        BaseMessage[],
        { name: string }[],
      ];

      // История уходит в LLM в хронологическом порядке (старые → новые).
      expect(messages).toHaveLength(2);
      expect(messages[0]).toBeInstanceOf(HumanMessage);
      expect(messages[0]?.content).toBe('привет');
      expect(messages[1]).toBeInstanceOf(AIMessage);
      expect(messages[1]?.content).toBe('предыдущий ответ');

      // LLM получает инструмент песочницы.
      expect(tools.map((tool) => tool.name)).toEqual([SANDBOX_TOOL_NAME]);
      expect(billing.chargeForSkill).not.toHaveBeenCalled();
    });

    it('выполняет инструмент песочницы и списывает средства', async () => {
      prisma.message.findMany.mockResolvedValue([
        { role: 'user', content: 'запусти echo hi' },
      ]);
      chatWithTools
        .mockResolvedValueOnce(toolCallMessage('echo hi'))
        .mockResolvedValueOnce(new AIMessage('Готово: hi'));
      billing.chargeForSkill.mockResolvedValue({
        balance: '9.90',
        entryId: 'entry-1',
      });
      sandbox.runCommand.mockResolvedValue('hi\n');

      const result = await service.handleMessage(
        USER_ID,
        CONVERSATION_ID,
        'запусти echo hi',
      );

      expect(result.reply).toBe('Готово: hi');

      // Paywall: списание за конкретного пользователя и один вызов песочницы.
      expect(billing.chargeForSkill).toHaveBeenCalledWith(
        USER_ID,
        SANDBOX_CALL_PRICE,
        SANDBOX_CALL_DESCRIPTION,
        expect.any(String),
      );
      expect(sandbox.runCommand).toHaveBeenCalledWith('echo hi');

      // Сначала деньги, потом выполнение кода.
      expect(
        billing.chargeForSkill.mock.invocationCallOrder[0],
      ).toBeLessThan(sandbox.runCommand.mock.invocationCallOrder[0]);

      // Результат инструмента вернулся в LLM вторым вызовом.
      expect(chatWithTools).toHaveBeenCalledTimes(2);
      const [secondCallMessages] = chatWithTools.mock.calls[1] as [
        BaseMessage[],
        unknown[],
      ];
      const toolMessage = secondCallMessages[secondCallMessages.length - 1];

      expect(toolMessage).toBeInstanceOf(ToolMessage);
      expect(toolMessage?.content).toBe('hi\n');
    });

    it('прерывает выполнение при нехватке средств', async () => {
      prisma.message.findMany.mockResolvedValue([
        { role: 'user', content: 'запусти echo hi' },
      ]);
      chatWithTools.mockResolvedValueOnce(toolCallMessage('echo hi'));
      billing.chargeForSkill.mockRejectedValue(
        new BadRequestException('Insufficient funds or wallet not found'),
      );

      const result = await service.handleMessage(
        USER_ID,
        CONVERSATION_ID,
        'запусти echo hi',
      );

      expect(result).toEqual({
        conversationId: CONVERSATION_ID,
        reply: INSUFFICIENT_FUNDS_REPLY,
      });

      // Песочница не запускалась, второй вызов LLM не состоялся.
      expect(sandbox.runCommand).not.toHaveBeenCalled();
      expect(chatWithTools).toHaveBeenCalledTimes(1);

      expect(prisma.message.create).toHaveBeenNthCalledWith(2, {
        data: {
          conversationId: CONVERSATION_ID,
          role: 'assistant',
          content: INSUFFICIENT_FUNDS_REPLY,
        },
      });
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
      expect(chatWithTools).not.toHaveBeenCalled();
    });

    it('отклоняет сообщение в несуществующий диалог', async () => {
      prisma.conversation.findUnique.mockResolvedValue(null);

      await expect(
        service.handleMessage(USER_ID, CONVERSATION_ID, 'привет'),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(prisma.message.create).not.toHaveBeenCalled();
      expect(chatWithTools).not.toHaveBeenCalled();
    });
  });
});

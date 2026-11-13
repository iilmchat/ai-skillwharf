import { ForbiddenException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
import type {
  GraphEvent,
  ResumeGraphRequest,
  RunGraphRequest,
} from '../agent/contracts.js';
import { ApiException } from '../common/api-error.js';
import { ERROR_KEYS } from '../i18n/error-keys.js';
import { ChatService, type ChatReply } from './chat.service.js';
import type {
  PendingApprovalRecord,
} from './persistence/pending-approval.service.js';
import type { OfficeEvent } from './office-events.js';

type MockFn = ReturnType<typeof vi.fn>;

/** Валидный манифест навыка, требующего подтверждения и оплаты за результат. */
const APPROVAL_SKILL_MANIFEST = {
  name: 'ozon-seller',
  version: '1.0.0',
  description: 'Маркетплейс Ozon',
  author: { name: 'SkillWharf' },
  permissions: ['network'],
  dependencies: { tools: ['ozon_mcp_call'] },
  pricing: { model: 'Pay-per-Outcome', price: 5 },
  requiresApproval: true,
  mcp_endpoint: 'https://mcp.ozon.example.com',
  egress_allowlist: ['api.ozon.example.com'],
};

const MEMORY_CONTEXT = 'Клиент предпочитает краткие ответы';

interface Harness {
  service: ChatService;
  prisma: {
    conversation: { findUnique: MockFn; update: MockFn };
    message: { create: MockFn; findMany: MockFn };
    user: { findUnique: MockFn };
  };
  worker: { run: MockFn; resume: MockFn };
  billing: { getBalance: MockFn; cancelHold: MockFn };
  skills: { getEnabledSkills: MockFn };
  router: { selectRoutes: MockFn };
  memory: { buildContext: MockFn; remember: MockFn };
  prompts: { getActiveSystemPrompt: MockFn };
  checkpoints: { deleteThread: MockFn };
  pending: {
    findPending: MockFn;
    listPending: MockFn;
    resolvePending: MockFn;
  };
  tools: { buildDescriptors: MockFn };
}

function events(items: readonly GraphEvent[]): AsyncGenerator<GraphEvent> {
  return (async function* generate(): AsyncGenerator<GraphEvent> {
    for (const item of items) {
      yield item;
    }
  })();
}

function pendingRecord(
  overrides: Partial<PendingApprovalRecord> = {},
): PendingApprovalRecord {
  return {
    id: 'pending-1',
    conversationId: 'c1',
    userId: 'u1',
    reason: 'payment',
    tools: ['ozon_mcp_call'],
    holds: [{ callId: 'call-1', toolName: 'ozon_mcp_call', entryId: 'hold-1' }],
    status: 'pending',
    createdAt: new Date('2026-11-13T10:00:00Z'),
    resolvedAt: null,
    expiresAt: null,
    ...overrides,
  };
}

function createHarness(
  runEvents: readonly GraphEvent[] = [],
  resumeEvents: readonly GraphEvent[] = [],
): Harness {
  const prisma = {
    conversation: {
      findUnique: vi.fn(async () => ({ id: 'c1', userId: 'u1' })),
      update: vi.fn(async () => ({})),
    },
    message: {
      create: vi.fn(async () => ({})),
      findMany: vi.fn(async () => [
        { role: 'user', content: 'привет' },
        { role: 'assistant', content: 'здравствуйте' },
      ]),
    },
    user: { findUnique: vi.fn(async () => ({ role: 'user' })) },
  };
  const worker = {
    run: vi.fn(() => events(runEvents)),
    resume: vi.fn(() => events(resumeEvents)),
  };
  const billing = {
    getBalance: vi.fn(async () => ({ balance: '10.00', heldBalance: '0.00' })),
    cancelHold: vi.fn(async () => ({ balance: '10.00' })),
  };
  const skills = {
    getEnabledSkills: vi.fn(async () => [
      {
        id: 'skill-1',
        name: 'ozon-seller',
        manifest: APPROVAL_SKILL_MANIFEST,
        isEnabled: true,
      },
    ]),
  };
  const router = { selectRoutes: vi.fn(async () => []) };
  const memory = {
    buildContext: vi.fn(async () => MEMORY_CONTEXT),
    remember: vi.fn(async () => 1),
  };
  const prompts = {
    getActiveSystemPrompt: vi.fn(async () => 'Базовый системный промпт'),
  };
  const checkpoints = { deleteThread: vi.fn(async () => undefined) };
  const pending = {
    findPending: vi.fn(async () => null),
    listPending: vi.fn(async () => []),
    resolvePending: vi.fn(async () => 1),
  };
  const tools = {
    buildDescriptors: vi.fn(() => [
      {
        name: 'ozon_mcp_call',
        description: 'Вызов MCP Ozon',
        parameters: { type: 'object', properties: {} },
      },
    ]),
  };

  const service = new ChatService(
    prisma as unknown as ConstructorParameters<typeof ChatService>[0],
    worker as unknown as ConstructorParameters<typeof ChatService>[1],
    billing as unknown as ConstructorParameters<typeof ChatService>[2],
    skills as unknown as ConstructorParameters<typeof ChatService>[3],
    router as unknown as ConstructorParameters<typeof ChatService>[4],
    memory as unknown as ConstructorParameters<typeof ChatService>[5],
    prompts as unknown as ConstructorParameters<typeof ChatService>[6],
    checkpoints as unknown as ConstructorParameters<typeof ChatService>[7],
    pending as unknown as ConstructorParameters<typeof ChatService>[8],
    tools as unknown as ConstructorParameters<typeof ChatService>[9],
  );

  return {
    service,
    prisma,
    worker,
    billing,
    skills,
    router,
    memory,
    prompts,
    checkpoints,
    pending,
    tools,
  };
}

function doneEvent(reply: string, pendingApproval = false): GraphEvent {
  return { type: 'done', conversationId: 'c1', reply, pendingApproval };
}

describe('ChatService (llm-worker client)', () => {
  it('передаёт долговременную память в systemPrompt запуска графа', async () => {
    const harness = createHarness([
      { type: 'delta', text: 'Ответ' },
      doneEvent('Ответ'),
    ]);

    await harness.service.streamMessage('u1', 'c1', 'сколько стоит доставка?', () => {});

    const request = harness.worker.run.mock.calls[0]?.[0] as RunGraphRequest;

    expect(harness.memory.buildContext).toHaveBeenCalledWith(
      'u1',
      'сколько стоит доставка?',
    );
    expect(request.memoryContext).toBe(MEMORY_CONTEXT);
    expect(request.systemPrompt).toContain(MEMORY_CONTEXT);
    expect(request.systemPrompt).toContain('## Долговременная память');
  });

  it('передаёт worker схемы инструментов, HITL и цены из манифестов', async () => {
    const harness = createHarness([doneEvent('готово')]);

    await harness.service.streamMessage('u1', 'c1', 'заказ', () => {});

    const request = harness.worker.run.mock.calls[0]?.[0] as RunGraphRequest;

    expect(request.approvalRequiredTools).toEqual(['ozon_mcp_call']);
    expect(request.outcomePrices.ozon_mcp_call).toEqual({
      price: 5,
      skillName: 'ozon-seller',
    });
    expect(request.tools).toEqual([
      {
        name: 'ozon_mcp_call',
        description: 'Вызов MCP Ozon',
        parameters: { type: 'object', properties: {} },
      },
    ]);
    expect(request.conversationId).toBe('c1');
    expect(request.userId).toBe('u1');
    expect(request.messages).toEqual([
      { role: 'assistant', content: 'здравствуйте' },
      { role: 'user', content: 'привет' },
    ]);
  });

  it('стримит дельты worker и сохраняет финальный ответ', async () => {
    const harness = createHarness([
      { type: 'delta', text: 'При' },
      { type: 'delta', text: 'вет' },
      doneEvent('Привет'),
    ]);
    const deltas: string[] = [];

    const reply = await harness.service.streamMessage('u1', 'c1', 'привет', (text) =>
      deltas.push(text),
    );

    expect(deltas).toEqual(['При', 'вет']);
    expect(reply.reply).toBe('Привет');
    expect(harness.prisma.message.create).toHaveBeenCalledWith({
      data: { conversationId: 'c1', role: 'assistant', content: 'Привет' },
    });
    expect(harness.memory.remember).toHaveBeenCalledWith('u1', 'привет');
    expect(harness.memory.remember).toHaveBeenCalledWith('u1', 'Привет');
  });

  it('на паузе HITL отдаёт pendingApproval и waiting_approval, не сохраняя ответ', async () => {
    const harness = createHarness([
      {
        type: 'approval',
        conversationId: 'c1',
        userId: 'u1',
        reason: 'payment',
        tools: ['ozon_mcp_call'],
        task: 'Ожидание подтверждения',
      },
      doneEvent('', true),
    ]);
    const officeEvents: OfficeEvent[] = [];

    const reply = await harness.service.streamMessage(
      'u1',
      'c1',
      'заказ',
      () => {},
      (event) => officeEvents.push(event),
    );

    expect(reply.pendingApproval).toBe(true);
    expect(officeEvents.map((event) => event.status)).toContain(
      'waiting_approval',
    );
    expect(officeEvents.at(-1)?.reason).toBe('payment');
    expect(harness.prisma.message.create).toHaveBeenCalledTimes(1);
  });

  it('превращает ошибку worker в ключ ошибки нехватки средств', async () => {
    const harness = createHarness();
    const fundsError = new ApiException({
      statusCode: 400,
      error: 'Bad Request',
      code: ERROR_KEYS.insufficientFunds,
      message: ERROR_KEYS.insufficientFunds,
    });
    harness.worker.run.mockImplementation(() => ({
      [Symbol.asyncIterator]() {
        return {
          next: async (): Promise<IteratorResult<GraphEvent>> => {
            throw fundsError;
          },
        };
      },
    }));
    const deltas: string[] = [];

    const reply = await harness.service.streamMessage('u1', 'c1', 'привет', (text) =>
      deltas.push(text),
    );

    expect(reply.reply).toBe(ERROR_KEYS.insufficientFunds);
    expect(deltas).toEqual([ERROR_KEYS.insufficientFunds]);
  });

  it('отменяет устаревшее ожидание, hold и checkpoint при новом сообщении', async () => {
    const harness = createHarness([doneEvent('ответ')]);
    harness.pending.findPending.mockResolvedValue(pendingRecord());

    await harness.service.streamMessage('u1', 'c1', 'новое', () => {});

    expect(harness.pending.resolvePending).toHaveBeenCalledWith(
      'c1',
      'rejected',
    );
    expect(harness.billing.cancelHold).toHaveBeenCalledWith('hold-1');
    expect(harness.checkpoints.deleteThread).toHaveBeenCalledWith('c1');
  });

  it('не пускает в чужой диалог и не вызывает worker', async () => {
    const harness = createHarness([doneEvent('ответ')]);
    harness.prisma.conversation.findUnique.mockResolvedValue({
      id: 'c1',
      userId: 'другой',
    });

    await expect(
      harness.service.streamMessage('u1', 'c1', 'привет', () => {}),
    ).rejects.toBeInstanceOf(ForbiddenException);

    expect(harness.worker.run).not.toHaveBeenCalled();
  });

  it('возобновляет граф через resume и сохраняет ответ', async () => {
    const harness = createHarness([], [doneEvent('после подтверждения')]);
    harness.pending.findPending.mockResolvedValue(pendingRecord());

    const reply = await harness.service.approveAction('u1', 'c1', true);

    const request = harness.worker.resume.mock.calls[0]?.[0] as ResumeGraphRequest;

    expect(request.approved).toBe(true);
    expect(reply?.reply).toBe('после подтверждения');
    expect(harness.prisma.message.create).toHaveBeenCalledWith({
      data: {
        conversationId: 'c1',
        role: 'assistant',
        content: 'после подтверждения',
      },
    });
  });

  it('не возобновляет граф без ожидания или для чужого ожидания', async () => {
    const harness = createHarness();

    await expect(harness.service.approveAction('u1', 'c1', true)).resolves.toBeNull();

    harness.pending.findPending.mockResolvedValue(pendingRecord({ userId: 'другой' }));

    await expect(harness.service.approveAction('u1', 'c1', true)).resolves.toBeNull();
    expect(harness.worker.resume).not.toHaveBeenCalled();
  });

  it('отдаёт список ожиданий с дедлайном TTL', async () => {
    const harness = createHarness();
    harness.pending.listPending.mockResolvedValue([
      pendingRecord({
        expiresAt: new Date('2026-11-14T10:00:00Z'),
        createdAt: new Date('2026-11-13T10:00:00Z'),
      }),
      pendingRecord({ conversationId: 'c2', expiresAt: null }),
    ]);

    const items = await harness.service.listPendingApprovals('u1');

    expect(items[0]).toEqual({
      conversationId: 'c1',
      reason: 'payment',
      tools: ['ozon_mcp_call'],
      createdAt: '2026-11-13T10:00:00.000Z',
      expiresAt: '2026-11-14T10:00:00.000Z',
    });
    expect(items[1]).not.toHaveProperty('expiresAt');
  });

  it('не запускает граф при балансе ниже минимального', async () => {
    const harness = createHarness();
    harness.billing.getBalance.mockResolvedValue({
      balance: '0.10',
      heldBalance: '0.00',
    });

    await expect(
      harness.service.streamMessage('u1', 'c1', 'привет', () => {}),
    ).rejects.toThrow(ERROR_KEYS.insufficientFunds);

    expect(harness.worker.run).not.toHaveBeenCalled();
  });

  it('в handleMessage возвращает pendingApproval при паузе HITL', async () => {
    const harness = createHarness([
      {
        type: 'approval',
        conversationId: 'c1',
        userId: 'u1',
        reason: 'approval',
        tools: ['ozon_mcp_call'],
        task: 'Ожидание подтверждения',
      },
      doneEvent('', true),
    ]);

    const reply: ChatReply = await harness.service.handleMessage(
      'u1',
      'c1',
      'заказ',
    );

    expect(reply).toEqual({
      conversationId: 'c1',
      reply: '',
      pendingApproval: true,
    });
  });
});

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { ExecutionContext, INestApplication } from '@nestjs/common';
import { Test, type TestingModule } from '@nestjs/testing';
import { Prisma, type InstalledSkill } from '@prisma/client';
import { SkillManifestSchema } from '@skillwharf/shared';
import request from 'supertest';
import type { App } from 'supertest/types.js';
import { parse } from 'yaml';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AgentRuntimeService } from '../src/agent/agent-runtime.service.js';
import { AgentToolsService } from '../src/agent/agent-tools.service.js';
import {
  approvalPrepareResponseSchema,
  toolExecutionResponseSchema,
  type AgentToolCall,
  type GraphEvent,
  type ResumeGraphRequest,
  type RunGraphRequest,
} from '../src/agent/contracts.js';
import { BillingService } from '../src/billing/billing.service.js';
import { ChatController } from '../src/chat/chat.controller.js';
import { ChatService } from '../src/chat/chat.service.js';
import {
  pendingApprovalListSchema,
  type PendingApprovalList,
} from '../src/chat/dto/pending-approval.dto.js';
import {
  DEFAULT_OFFICE_AGENT_ID,
  type OfficeEvent,
} from '../src/chat/office-events.js';
import {
  PendingApprovalHoldsSchema,
  PendingApprovalService,
} from '../src/chat/persistence/pending-approval.service.js';
import { JwtAuthGuard } from '../src/auth/jwt-auth.guard.js';
import { CheckpointStoreService } from '../src/agent/checkpoint-store.service.js';
import { LlmRouterService } from '../src/llm-router/llm-router.service.js';
import { LlmWorkerClient } from '../src/agent/llm-worker.client.js';
import { MemoryService } from '../src/memory/memory.service.js';
import { PrismaService } from '../src/prisma/prisma.service.js';
import { PromptsService } from '../src/prompts/prompts.service.js';
import { AgentGatewayService } from '../src/security/agent-gateway.service.js';
import { SkillsService } from '../src/skills/skills.service.js';
import {
  createFakeAgentPrisma,
  type FakeAgentPrismaStore,
} from './support/fake-agent-prisma.js';

/**
 * Сквозной контрактный E2E цикла
 * `Chat → LLM tool_calls → HITL Pause → Approve/Reject → Ledger Capture`
 * (QA-24.4, KI-049).
 *
 * Контур: настоящие `ChatController`, `ChatService`, `AgentRuntimeService`,
 * `PendingApprovalService` и `BillingService`; in-memory Prisma с настоящими
 * escrow-операциями (`authorizeHold`/`captureHold`/`cancelHold`); LLM-worker
 * заменён фейком, который повторяет контракт worker'а: вызывает
 * `prepareApproval` перед паузой, затем `resolveApproval` + `executeTools`.
 * Внешние API (LLM, MCP, Sandbox) не нужны, поэтому тест идёт в общем
 * прогоне `pnpm test`.
 */

const USER_ID = '11111111-1111-1111-1111-111111111111';
const EMAIL = 'partner@example.com';
const CONVERSATION_ID = '22222222-2222-2222-2222-222222222222';
const TOOL_NAME = 'publish_to_dzen';
const TOOL_RESULT = 'Черновик статьи сохранён: ./dzen-output/article.md';
const REJECT_REPLY = 'Действие отклонено пользователем';

const SKILL_PATH = fileURLToPath(
  new URL(
    '../../../starter-skills/11-content/dzen-article/SKILL.md',
    import.meta.url,
  ),
);

/** YAML frontmatter реального манифеста `dzen-article` (Pay-per-Outcome). */
function readManifest(): unknown {
  const content = readFileSync(SKILL_PATH, 'utf8');
  const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(content);

  if (match?.[1] === undefined) {
    throw new Error('в SKILL.md не найден frontmatter');
  }

  return parse(match[1]);
}

function createSkill(): InstalledSkill {
  const manifest = SkillManifestSchema.parse(readManifest());

  return {
    id: 'skill-dzen',
    name: 'dzen-article',
    version: '1.0.0',
    author: 'SkillWharf',
    manifest: manifest as InstalledSkill['manifest'],
    isEnabled: true,
    installedAt: new Date('2026-11-18T10:00:00.000Z'),
  };
}

/** Tool call, который «вернула» mock-LLM. */
function dzenToolCall(): AgentToolCall {
  return {
    id: 'call-dzen-1',
    name: TOOL_NAME,
    args: { title: 'AI-Офис для опта', text: 'Текст статьи' },
  };
}

/** Mock LLM: на запрос «опубликуй статью» отвечает одним tool_call. */
function mockLlmToolCalls(): AgentToolCall[] {
  return [dzenToolCall()];
}

/**
 * Mock LLM-worker по контракту `apps/llm-worker/src/agent/graph.ts`:
 * run → prepareApproval + interrupt; resume → resolveApproval + executeTools.
 */
class FakeAgentWorker {
  private readonly prepared = new Map<
    string,
    { call: AgentToolCall; holds: Record<string, string> }
  >();

  constructor(private readonly runtime: AgentRuntimeService) {}

  async *run(graph: RunGraphRequest): AsyncIterable<GraphEvent> {
    const [call] = mockLlmToolCalls();

    if (call === undefined) {
      throw new Error('mock LLM не вернул tool_calls');
    }

    if (!graph.approvalRequiredTools.includes(call.name)) {
      throw new Error(`инструмент ${call.name} не помечен как HITL`);
    }

    const prepared = approvalPrepareResponseSchema.parse(
      await this.runtime.prepareApproval({
        conversationId: graph.conversationId,
        userId: graph.userId,
        userRole: graph.userRole,
        skills: graph.skills,
        toolSkills: graph.toolSkills,
        taintedSecrets: graph.taintedSecrets,
        outcomePrices: graph.outcomePrices,
        calls: [call],
      }),
    );

    this.prepared.set(graph.conversationId, {
      call,
      holds: prepared.holds,
    });

    yield {
      type: 'office',
      conversationId: graph.conversationId,
      agentId: DEFAULT_OFFICE_AGENT_ID,
      status: 'waiting_approval',
      task: `Ждёт подтверждения: ${prepared.tools.join(', ')}`,
      reason: prepared.reason,
    };
    yield {
      type: 'approval',
      conversationId: graph.conversationId,
      userId: graph.userId,
      reason: prepared.reason,
      tools: prepared.tools,
      task: 'Публикация статьи в Дзен',
    };
    yield {
      type: 'done',
      conversationId: graph.conversationId,
      reply: '',
      pendingApproval: true,
    };
  }

  async *resume(graph: ResumeGraphRequest): AsyncIterable<GraphEvent> {
    const saved = this.prepared.get(graph.conversationId);

    if (saved === undefined) {
      throw new Error('checkpoint с tool_call не найден');
    }

    if (!graph.approved) {
      const resolved = await this.runtime.resolveApproval(
        graph.conversationId,
        false,
      );

      if (!resolved) {
        throw new Error('ожидание одобрения уже закрыто');
      }

      yield { type: 'delta', text: REJECT_REPLY };
      yield {
        type: 'done',
        conversationId: graph.conversationId,
        reply: REJECT_REPLY,
        pendingApproval: false,
      };
      this.prepared.delete(graph.conversationId);

      return;
    }

    const resolved = await this.runtime.resolveApproval(
      graph.conversationId,
      true,
    );

    if (!resolved) {
      throw new Error('ожидание одобрения уже закрыто');
    }

    const execution = toolExecutionResponseSchema.parse(
      await this.runtime.executeTools({
        conversationId: graph.conversationId,
        skills: graph.skills,
        userId: graph.userId,
        userRole: graph.userRole,
        toolSkills: graph.toolSkills,
        taintedSecrets: graph.taintedSecrets,
        outcomePrices: graph.outcomePrices,
        calls: [saved.call],
        preAuthorizedHolds: saved.holds,
      }),
    );
    const reply =
      execution.messages.map((message) => message.content).join('\n') ||
      'Готово';

    yield { type: 'delta', text: reply };
    yield {
      type: 'done',
      conversationId: graph.conversationId,
      reply,
      pendingApproval: false,
    };
    this.prepared.delete(graph.conversationId);
  }
}

interface Harness {
  app: INestApplication<App>;
  moduleRef: TestingModule;
  chat: ChatService;
  store: FakeAgentPrismaStore;
  executeMock: ReturnType<typeof vi.fn>;
}

async function createHarness(): Promise<Harness> {
  const store = createFakeAgentPrisma();
  const executeMock = vi.fn(async () => TOOL_RESULT);

  store.state.users.push({ id: USER_ID, email: EMAIL, role: 'user' });
  store.state.conversations.push({
    id: CONVERSATION_ID,
    title: 'E2E HITL',
    createdAt: new Date(),
    updatedAt: new Date(),
    userId: USER_ID,
  });
  store.state.wallets.push({
    id: 'wallet-e2e',
    userId: USER_ID,
    balance: new Prisma.Decimal('500.00'),
    heldBalance: new Prisma.Decimal('0.00'),
    updatedAt: new Date(),
  });

  const skillsService = {
    getEnabledSkills: async () => [createSkill()],
  } as unknown as SkillsService;
  const toolsService = {
    has: (name: string) => name === TOOL_NAME,
    buildDescriptors: () => [],
    execute: executeMock,
  } as unknown as AgentToolsService;
  const gateway = {
    validateToolCall: (name: string, args: Record<string, unknown>) => ({
      toolName: name,
      args,
      egress: { requested: false, allowlist: [] },
      taint: { detected: false, masked: false },
    }),
  } as unknown as AgentGatewayService;
  const llmRouter = {
    selectRoutes: async () => [],
  } as unknown as LlmRouterService;
  const memory = {
    buildContext: async () => '',
    remember: async () => undefined,
  } as unknown as MemoryService;
  const prompts = {
    getActiveSystemPrompt: async () => 'Ты — AI-Офис SkillWharf.',
  } as unknown as PromptsService;
  const checkpoints = {
    deleteThread: async () => undefined,
  } as unknown as CheckpointStoreService;

  const authGuard = {
    canActivate: (context: ExecutionContext): boolean => {
      const httpRequest = context
        .switchToHttp()
        .getRequest<{
          user?: { userId: string; email: string; role: string };
        }>();
      httpRequest.user = { userId: USER_ID, email: EMAIL, role: 'user' };

      return true;
    },
  };

  const moduleRef = await Test.createTestingModule({
    controllers: [ChatController],
    providers: [
      ChatService,
      AgentRuntimeService,
      BillingService,
      PendingApprovalService,
      { provide: PrismaService, useValue: store.prisma },
      { provide: SkillsService, useValue: skillsService },
      { provide: AgentToolsService, useValue: toolsService },
      { provide: AgentGatewayService, useValue: gateway },
      { provide: LlmRouterService, useValue: llmRouter },
      { provide: MemoryService, useValue: memory },
      { provide: PromptsService, useValue: prompts },
      { provide: CheckpointStoreService, useValue: checkpoints },
      {
        provide: LlmWorkerClient,
        useFactory: (runtime: AgentRuntimeService) =>
          new FakeAgentWorker(runtime),
        inject: [AgentRuntimeService],
      },
    ],
  })
    .overrideGuard(JwtAuthGuard)
    .useValue(authGuard)
    .compile();

  const app = moduleRef.createNestApplication();
  app.setGlobalPrefix('api/v1');
  await app.init();

  return {
    app,
    moduleRef,
    chat: moduleRef.get(ChatService),
    store,
    executeMock,
  };
}

function requireWallet(store: FakeAgentPrismaStore) {
  const [wallet] = store.state.wallets;

  if (wallet === undefined) {
    throw new Error('в fake Prisma нет кошелька');
  }

  return wallet;
}

function requirePending(store: FakeAgentPrismaStore) {
  const [pending] = store.state.pendingApprovals;

  if (pending === undefined) {
    throw new Error('в fake Prisma нет PendingApproval');
  }

  return pending;
}

function requireLedger(store: FakeAgentPrismaStore) {
  const [entry] = store.state.ledgerEntries;

  if (entry === undefined) {
    throw new Error('в fake Prisma нет LedgerEntry');
  }

  return entry;
}

describe('E2E: Chat → tool_calls → HITL → Ledger (QA-24.4)', () => {
  let harness: Harness | null = null;

  beforeEach(async () => {
    harness = await createHarness();
  });

  afterEach(async () => {
    if (harness !== null) {
      await harness.app.close();
      harness.store.reset();
      harness = null;
    }
  });

  function getHarness(): Harness {
    if (harness === null) {
      throw new Error('E2E harness не инициализирован');
    }

    return harness;
  }

  it('успешное одобрение: hold → PENDING, approve → debit, финальный ответ', async () => {
    const { chat, app, store } = getHarness();
    const officeEvents: OfficeEvent[] = [];

    const paused = await chat.streamMessage(
      USER_ID,
      CONVERSATION_ID,
      'Опубликуй статью в Дзен',
      () => {},
      (event) => officeEvents.push(event),
    );

    expect(paused.pendingApproval).toBe(true);
    expect(paused.reply).toBe('');
    expect(
      officeEvents.some((event) => event.status === 'waiting_approval'),
    ).toBe(true);

    // Состояние до решения: деньги заморожены, ожидание сохранено.
    const walletAfterHold = requireWallet(store);
    expect(walletAfterHold.balance.toFixed(2)).toBe('400.00');
    expect(walletAfterHold.heldBalance.toFixed(2)).toBe('100.00');

    const pendingBefore = requirePending(store);
    expect(pendingBefore.status).toBe('pending');
    expect(pendingBefore.userId).toBe(USER_ID);
    expect(pendingBefore.reason).toBe('payment');
    expect(pendingBefore.expiresAt).toBeInstanceOf(Date);
    const holds = PendingApprovalHoldsSchema.parse(pendingBefore.holds);
    expect(holds).toHaveLength(1);
    expect(holds[0]?.toolName).toBe(TOOL_NAME);

    const heldEntry = requireLedger(store);
    expect(heldEntry.type).toBe('PENDING');
    expect(heldEntry.amount.toFixed(2)).toBe('100.00');
    expect(heldEntry.balanceAfter.toFixed(2)).toBe('400.00');

    // GET /api/v1/chat/pending отдаёт ожидание с expiresAt (контракт Zod).
    const response = await request(app.getHttpServer())
      .get('/api/v1/chat/pending')
      .expect(200);
    const body: unknown = response.body;
    const pendingList: PendingApprovalList =
      pendingApprovalListSchema.parse(body);

    expect(pendingList.items).toHaveLength(1);
    const item = pendingList.items[0];
    expect(item).toBeDefined();
    expect(item?.conversationId).toBe(CONVERSATION_ID);
    expect(item?.reason).toBe('payment');
    expect(item?.tools).toEqual([TOOL_NAME]);
    expect(item?.expiresAt).toBeDefined();

    if (item?.expiresAt !== undefined) {
      expect(Date.parse(item.expiresAt)).toBeGreaterThan(Date.now());
    }

    // Пользователь одобряет: hold фиксируется, ответ агента сохраняется.
    const finalReply = await chat.approveAction(USER_ID, CONVERSATION_ID, true);

    expect(finalReply).not.toBeNull();
    expect(finalReply?.pendingApproval).toBeUndefined();
    expect(finalReply?.reply).toContain('Черновик статьи сохранён');

    const walletAfterCapture = requireWallet(store);
    expect(walletAfterCapture.balance.toFixed(2)).toBe('400.00');
    expect(walletAfterCapture.heldBalance.toFixed(2)).toBe('0.00');

    const approved = requirePending(store);
    expect(approved.status).toBe('approved');
    expect(approved.resolvedAt).toBeInstanceOf(Date);

    // Append-only Ledger: одна запись PENDING, переведённая в debit.
    expect(store.state.ledgerEntries).toHaveLength(1);
    const captured = requireLedger(store);
    expect(captured.id).toBe(heldEntry.id);
    expect(captured.type).toBe('debit');
    expect(captured.balanceAfter.toFixed(2)).toBe('400.00');

    expect(
      store.state.messages.some(
        (message) =>
          message.role === 'assistant' &&
          message.content.includes('Черновик статьи сохранён'),
      ),
    ).toBe(true);
  });

  it('отклонение HITL: hold отменяется, баланс возвращается к 500 ₽', async () => {
    const { chat, store } = getHarness();

    const paused = await chat.handleMessage(
      USER_ID,
      CONVERSATION_ID,
      'Опубликуй статью в Дзен',
    );
    expect(paused.pendingApproval).toBe(true);
    expect(requireWallet(store).heldBalance.toFixed(2)).toBe('100.00');

    const finalReply = await chat.approveAction(
      USER_ID,
      CONVERSATION_ID,
      false,
    );

    expect(finalReply?.reply).toBe(REJECT_REPLY);

    const wallet = requireWallet(store);
    expect(wallet.balance.toFixed(2)).toBe('500.00');
    expect(wallet.heldBalance.toFixed(2)).toBe('0.00');

    expect(requirePending(store).status).toBe('rejected');
    expect(store.state.ledgerEntries).toHaveLength(1);
    const refunded = requireLedger(store);
    expect(refunded.type).toBe('credit');
    expect(refunded.amount.toFixed(2)).toBe('100.00');
    expect(refunded.balanceAfter.toFixed(2)).toBe('500.00');
  });

  it('ошибка инструмента после approve: hold отменяется, деньги не теряются', async () => {
    const { chat, store, executeMock } = getHarness();

    const paused = await chat.handleMessage(
      USER_ID,
      CONVERSATION_ID,
      'Опубликуй статью в Дзен',
    );
    expect(paused.pendingApproval).toBe(true);
    expect(requireWallet(store).heldBalance.toFixed(2)).toBe('100.00');

    executeMock.mockRejectedValueOnce(new Error('MCP недоступен'));

    await expect(
      chat.approveAction(USER_ID, CONVERSATION_ID, true),
    ).rejects.toThrow('MCP недоступен');

    const wallet = requireWallet(store);
    expect(wallet.balance.toFixed(2)).toBe('500.00');
    expect(wallet.heldBalance.toFixed(2)).toBe('0.00');

    const refunded = requireLedger(store);
    expect(refunded.type).toBe('credit');
    expect(refunded.amount.toFixed(2)).toBe('100.00');
    expect(refunded.balanceAfter.toFixed(2)).toBe('500.00');
  });

  it('не списывает дважды: повторный approve не меняет баланс', async () => {
    const { chat, store } = getHarness();

    await chat.handleMessage(USER_ID, CONVERSATION_ID, 'Опубликуй статью');
    await chat.approveAction(USER_ID, CONVERSATION_ID, true);

    await expect(
      chat.approveAction(USER_ID, CONVERSATION_ID, true),
    ).resolves.toBeNull();

    expect(requireWallet(store).balance.toFixed(2)).toBe('400.00');
    expect(requireWallet(store).heldBalance.toFixed(2)).toBe('0.00');
    expect(store.state.ledgerEntries).toHaveLength(1);
  });
});

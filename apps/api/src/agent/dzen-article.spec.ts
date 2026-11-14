import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SkillManifestSchema } from '@skillwharf/shared';
import { parse } from 'yaml';
import { describe, expect, it, vi } from 'vitest';
import type { BillingService } from '../billing/billing.service.js';
import type { PendingApprovalService } from '../chat/persistence/pending-approval.service.js';
import type { AgentGatewayService } from '../security/agent-gateway.service.js';
import { AgentRuntimeService } from './agent-runtime.service.js';
import type { AgentToolsService } from './agent-tools.service.js';
import type { ToolExecutionRequest } from './contracts.js';
import { resolveApprovalTools, resolveOutcomePrices } from '../chat/chat.service.js';

/**
 * HITL и Pay-per-Outcome для `dzen-article`.
 *
 * Проверка идёт по настоящему манифесту из `starter-skills`: именно он решает,
 * нужен ли человек-подтверждающий и сколько списать за результат. Тест ловит
 * регрессию, при которой навык останется бесплатным или потеряет одобрение.
 */

const SKILL_PATH = fileURLToPath(
  new URL(
    '../../../../starter-skills/11-content/dzen-article/SKILL.md',
    import.meta.url,
  ),
);

/** YAML frontmatter SKILL.md. */
function readManifest(): unknown {
  const content = readFileSync(SKILL_PATH, 'utf8');
  const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(content);

  if (match?.[1] === undefined) {
    throw new Error('в SKILL.md не найден frontmatter');
  }

  return parse(match[1]);
}

/** Снимок навыка для оркестратора. */
type SkillSnapshotLike = Parameters<typeof resolveApprovalTools>[0][number];

function dzenSkill(): SkillSnapshotLike {
  return {
    id: 'skill-dzen',
    name: 'dzen-article',
    manifest: readManifest() as SkillSnapshotLike['manifest'],
    isEnabled: true,
  };
}

/** Заглушки runtime-зависимостей. */
function createRuntime(): {
  runtime: AgentRuntimeService;
  tools: { has: ReturnType<typeof vi.fn>; execute: ReturnType<typeof vi.fn> };
  billing: Record<string, ReturnType<typeof vi.fn>>;
  pending: Record<string, ReturnType<typeof vi.fn>>;
} {
  const tools = {
    has: vi.fn(() => true),
    execute: vi.fn(async () => 'Черновик статьи сохранён: ./dzen-output/x.md'),
  };
  const billing = {
    authorizeHold: vi.fn(async () => ({ entryId: 'hold-dzen' })),
    captureHold: vi.fn(async () => ({})),
    cancelHold: vi.fn(async () => ({})),
    checkAndChargeSkill: vi.fn(async () => ({})),
  };
  const gateway = {
    validateToolCall: vi.fn((name: string, args: unknown) => ({
      toolName: name,
      args: args as Record<string, unknown>,
      egress: { requested: false, allowlist: [] },
      taint: { detected: false, masked: false },
    })),
  };
  const pending = {
    upsertPending: vi.fn(async () => ({})),
    resolvePending: vi.fn(async () => 1),
    findPending: vi.fn(async () => ({
      conversationId: 'c1',
      userId: 'user-1',
      reason: 'payment',
      tools: ['publish_to_dzen'],
      holds: [{ callId: 'call-1', toolName: 'publish_to_dzen', entryId: 'hold-dzen' }],
    })),
  };
  const runtime = new AgentRuntimeService(
    tools as unknown as AgentToolsService,
    billing as unknown as BillingService,
    gateway as unknown as AgentGatewayService,
    pending as unknown as PendingApprovalService,
  );

  return { runtime, tools, billing, pending };
}

/** Запрос выполнения инструмента dzen-article. */
function request(
  overrides: Partial<ToolExecutionRequest> = {},
): ToolExecutionRequest {
  const skill = dzenSkill();

  return {
    conversationId: 'c1',
    userId: 'user-1',
    userRole: 'user',
    skills: [skill],
    toolSkills: {
      publish_to_dzen: [
        { name: 'dzen-article', permissions: ['filesystem'], egressAllowlist: [] },
      ],
    },
    taintedSecrets: [],
    outcomePrices: resolveOutcomePrices([skill]),
    calls: [
      {
        id: 'call-1',
        name: 'publish_to_dzen',
        args: { title: 'Статья', text: 'Текст' },
      },
    ],
    preAuthorizedHolds: {},
    ...overrides,
  };
}

describe('dzen-article: манифест', () => {
  it('требует подтверждения человека и оплату за результат', () => {
    const manifest = SkillManifestSchema.parse(readManifest());

    expect(manifest.name).toBe('dzen-article');
    expect(manifest.requiresApproval).toBe(true);
    expect(manifest.pricing).toMatchObject({
      model: 'Pay-per-Outcome',
      price: 100,
      currency: 'RUB',
    });
    expect(manifest.dependencies?.tools).toEqual(['publish_to_dzen']);
  });

  it('одобрение и цена попадают в запрос воркера', () => {
    const skills = [dzenSkill()];

    expect(resolveApprovalTools(skills)).toEqual(['publish_to_dzen']);
    expect(resolveOutcomePrices(skills)).toEqual({
      publish_to_dzen: { price: 100, skillName: 'dzen-article' },
    });
  });
});

describe('dzen-article: HITL и Pay-per-Outcome в runtime', () => {
  it('prepareApproval резервирует 100 ₽ и создаёт ожидание', async () => {
    const { runtime, billing, pending } = createRuntime();

    const prepared = await runtime.prepareApproval({
      conversationId: 'c1',
      userId: 'user-1',
      userRole: 'user',
      skills: [dzenSkill()],
      toolSkills: {},
      taintedSecrets: [],
      outcomePrices: resolveOutcomePrices([dzenSkill()]),
      calls: [
        {
          id: 'call-1',
          name: 'publish_to_dzen',
          args: { title: 'Статья', text: 'Текст' },
        },
      ],
    });

    expect(billing.authorizeHold).toHaveBeenCalledWith(
      'user-1',
      100,
      'approval:c1:call-1',
    );
    expect(pending.upsertPending).toHaveBeenCalledWith(
      expect.objectContaining({
        reason: 'payment',
        tools: ['publish_to_dzen'],
        holds: [
          { callId: 'call-1', toolName: 'publish_to_dzen', entryId: 'hold-dzen' },
        ],
      }),
    );
    expect(prepared).toEqual({
      reason: 'payment',
      tools: ['publish_to_dzen'],
      holds: { 'call-1': 'hold-dzen' },
    });
  });

  it('после одобрения hold фиксируется только при успешной записи черновика', async () => {
    const { runtime, tools, billing } = createRuntime();

    await runtime.executeTools(
      request({ preAuthorizedHolds: { 'call-1': 'hold-dzen' } }),
    );

    expect(billing.authorizeHold).not.toHaveBeenCalled();
    expect(billing.captureHold).toHaveBeenCalledWith('hold-dzen');
    expect(tools.execute).toHaveBeenCalledWith(
      'publish_to_dzen',
      { title: 'Статья', text: 'Текст' },
      expect.objectContaining({ userId: 'user-1' }),
    );
  });

  it('ошибка записи отменяет hold: за неудачный черновик не платят', async () => {
    const { runtime, tools, billing } = createRuntime();

    tools.execute.mockRejectedValueOnce(new Error('disk full'));

    await expect(
      runtime.executeTools(
        request({ preAuthorizedHolds: { 'call-1': 'hold-dzen' } }),
      ),
    ).rejects.toThrow('disk full');

    expect(billing.cancelHold).toHaveBeenCalledWith('hold-dzen');
    expect(billing.captureHold).not.toHaveBeenCalled();
  });

  it('отказ пользователя возвращает hold', async () => {
    const { runtime, billing, pending } = createRuntime();

    await expect(runtime.resolveApproval('c1', false)).resolves.toBe(true);

    expect(billing.cancelHold).toHaveBeenCalledWith('hold-dzen');
    expect(pending.resolvePending).toHaveBeenCalledWith('c1', 'rejected');
    expect(billing.captureHold).not.toHaveBeenCalled();
  });

  it('без предварительного hold runtime резервирует сумму сам', async () => {
    const { runtime, billing } = createRuntime();

    await runtime.executeTools(request());

    expect(billing.authorizeHold).toHaveBeenCalledWith(
      'user-1',
      100,
      expect.any(String),
    );
    expect(billing.captureHold).toHaveBeenCalledWith('hold-dzen');
  });
});

/** Проверка, что путь к манифесту действительно существует. */
describe('dzen-article: расположение навыка', () => {
  it('манифест лежит в starter-skills/11-content', () => {
    expect(readFileSync(join(SKILL_PATH), 'utf8')).toContain('name: "dzen-article"');
  });
});

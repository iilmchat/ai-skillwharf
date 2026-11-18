import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { SkillManifestSchema } from '@skillwharf/shared';
import { parse } from 'yaml';
import { z } from 'zod';
import { describe, expect, it, vi } from 'vitest';
import type { BillingService } from '../billing/billing.service.js';
import type { PendingApprovalService } from '../chat/persistence/pending-approval.service.js';
import type { AgentGatewayService } from '../security/agent-gateway.service.js';
import type { AgentToolsService } from './agent-tools.service.js';
import {
  APPROVAL_REQUIRED_MESSAGE,
  AgentRuntimeService,
} from './agent-runtime.service.js';
import type { ToolExecutionRequest } from './contracts.js';
import {
  resolveApprovalTools,
  resolveOutcomePrices,
} from '../chat/chat.service.js';
import {
  BITRIX24_GET_DEAL_TOOL_NAME,
  BITRIX24_UPDATE_DEAL_TOOL_NAME,
  MOYSKLAD_CHECK_STOCK_TOOL_NAME,
  MOYSKLAD_CREATE_ORDER_TOOL_NAME,
  MOYSKLAD_GET_COST_TOOL_NAME,
  TOOL_REGISTRY,
  type ToolName,
} from './tools/tool-schemas.js';

/**
 * HITL и Pay-per-Call для Треков K/L.
 *
 * Проверяется настоящий манифест навыка (именно он решает, нужен ли
 * подтверждающий и сколько стоит вызов) и гейт Runtime: необратимый вызов
 * без свежего одобрения пользователя не выполняется.
 */

/** YAML frontmatter SKILL.md из `starter-skills`. */
function readManifest(relativePath: string): unknown {
  const path = fileURLToPath(
    new URL(`../../../../starter-skills/${relativePath}`, import.meta.url),
  );
  const content = readFileSync(path, 'utf8');
  const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(content);

  if (match?.[1] === undefined) {
    throw new Error(`в ${relativePath} не найден frontmatter`);
  }

  return parse(match[1]);
}

const bitrixManifest = (): unknown =>
  readManifest('17-crm/bitrix24-crm/SKILL.md');
const moyskladManifest = (): unknown =>
  readManifest('18-erp/moysklad-warehouse/SKILL.md');

type SkillSnapshotLike = Parameters<typeof resolveApprovalTools>[0][number];

function skill(id: string, name: string, manifest: unknown): SkillSnapshotLike {
  return { id, name, manifest, isEnabled: true };
}

const BITRIX_SKILL = (): SkillSnapshotLike =>
  skill('skill-bitrix', 'bitrix24-crm', bitrixManifest());
const MOYSKLAD_SKILL = (): SkillSnapshotLike =>
  skill('skill-moysklad', 'moysklad-warehouse', moyskladManifest());

/** Заглушки runtime-зависимостей. */
function createRuntime(granted = false): {
  runtime: AgentRuntimeService;
  tools: { has: ReturnType<typeof vi.fn>; execute: ReturnType<typeof vi.fn> };
  billing: Record<string, ReturnType<typeof vi.fn>>;
  pending: Record<string, ReturnType<typeof vi.fn>>;
} {
  const tools = {
    has: vi.fn(() => true),
    execute: vi.fn(
      async (
        _name: string,
        _args: unknown,
        options?: { beforeExecute?: () => Promise<void> },
      ) => {
        await options?.beforeExecute?.();

        return '{"ok":true}';
      },
    ),
  };
  const billing = {
    authorizeHold: vi.fn(async () => ({ entryId: 'hold-1' })),
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
    hasApprovedGrant: vi.fn(async () => granted),
    upsertPending: vi.fn(async () => ({})),
    resolvePending: vi.fn(async () => 1),
    findPending: vi.fn(async () => null),
  };
  const runtime = new AgentRuntimeService(
    tools as unknown as AgentToolsService,
    billing as unknown as BillingService,
    gateway as unknown as AgentGatewayService,
    pending as unknown as PendingApprovalService,
  );

  return { runtime, tools, billing, pending };
}

/** Запрос выполнения одного вызова. */
function request(
  toolName: string,
  args: Record<string, unknown>,
  skills: readonly SkillSnapshotLike[],
): ToolExecutionRequest {
  return {
    conversationId: 'c1',
    userId: 'user-1',
    userRole: 'user',
    skills: [...skills],
    toolSkills: {},
    taintedSecrets: [],
    outcomePrices: resolveOutcomePrices(skills),
    calls: [{ id: 'call-1', name: toolName, args }],
    preAuthorizedHolds: {},
  };
}

describe('ERP-навыки: манифесты Треков K/L', () => {
  it('bitrix24-crm: HITL, Pay-per-Call и инструменты сделок', () => {
    const manifest = SkillManifestSchema.parse(bitrixManifest());

    expect(manifest.name).toBe('bitrix24-crm');
    expect(manifest.requiresApproval).toBe(true);
    expect(manifest.pricing).toMatchObject({
      model: 'Pay-per-Call',
      price: 15,
      currency: 'RUB',
    });
    expect(manifest.dependencies?.tools).toEqual([
      'bitrix24_get_deal',
      'bitrix24_update_deal',
    ]);
    expect(manifest.mcp_endpoint).toBe('http://bitrix24-mcp:5003');
  });

  it('moysklad-warehouse: HITL, Pay-per-Call и инструменты склада', () => {
    const manifest = SkillManifestSchema.parse(moyskladManifest());

    expect(manifest.name).toBe('moysklad-warehouse');
    expect(manifest.requiresApproval).toBe(true);
    expect(manifest.pricing).toMatchObject({
      model: 'Pay-per-Call',
      price: 15,
      currency: 'RUB',
    });
    expect(manifest.dependencies?.tools).toEqual([
      'moysklad_check_stock',
      'moysklad_get_cost',
      'moysklad_create_order',
    ]);
    expect(manifest.mcp_endpoint).toBe('http://moysklad-mcp:5004');
  });

  it('в HITL попадают только пишущие инструменты, чтение не тормозит', () => {
    expect(resolveApprovalTools([BITRIX_SKILL()])).toEqual([
      'bitrix24_update_deal',
    ]);
    expect(resolveApprovalTools([MOYSKLAD_SKILL()])).toEqual([
      'moysklad_create_order',
    ]);
  });

  it('Pay-per-Call не создаёт Pay-per-Outcome escrow', () => {
    expect(resolveOutcomePrices([BITRIX_SKILL(), MOYSKLAD_SKILL()])).toEqual(
      {},
    );
  });

  it('схемы инструментов конвертируются в JSON Schema для LLM', () => {
    const names: ToolName[] = [
      BITRIX24_GET_DEAL_TOOL_NAME,
      BITRIX24_UPDATE_DEAL_TOOL_NAME,
      MOYSKLAD_CHECK_STOCK_TOOL_NAME,
      MOYSKLAD_GET_COST_TOOL_NAME,
      MOYSKLAD_CREATE_ORDER_TOOL_NAME,
    ];

    for (const name of names) {
      const entry = TOOL_REGISTRY[name];
      const json = z.toJSONSchema(entry.schema, { io: 'input' });

      expect(json).toMatchObject({ type: 'object' });
    }
  });
});

describe('ERP-навыки: HITL-гейт Runtime', () => {
  it('не выполняет финальную стадию без одобрения пользователя', async () => {
    const { runtime, tools, pending } = createRuntime(false);

    const response = await runtime.executeTools(
      request('bitrix24_update_deal', { dealId: '42', stageId: 'WON' }, [
        BITRIX_SKILL(),
      ]),
    );

    expect(pending.hasApprovedGrant).toHaveBeenCalledWith(
      'c1',
      'bitrix24_update_deal',
    );
    expect(tools.execute).not.toHaveBeenCalled();
    expect(response.messages[0]).toMatchObject({
      status: 'error',
      content: APPROVAL_REQUIRED_MESSAGE,
    });
  });

  it('выполняет финальную стадию после одобрения', async () => {
    const { runtime, tools } = createRuntime(true);

    await runtime.executeTools(
      request('bitrix24_update_deal', { dealId: '42', stageId: 'WON' }, [
        BITRIX_SKILL(),
      ]),
    );

    expect(tools.execute).toHaveBeenCalledWith(
      'bitrix24_update_deal',
      { dealId: '42', stageId: 'WON' },
      expect.objectContaining({ userId: 'user-1' }),
    );
  });

  it('промежуточная стадия проходит без HITL', async () => {
    const { runtime, tools, pending } = createRuntime(false);

    await runtime.executeTools(
      request('bitrix24_update_deal', { dealId: '42', stageId: 'EXECUTING' }, [
        BITRIX_SKILL(),
      ]),
    );

    expect(pending.hasApprovedGrant).not.toHaveBeenCalled();
    expect(tools.execute).toHaveBeenCalledTimes(1);
  });

  it('заказ покупателя без одобрения не создаётся', async () => {
    const { runtime, tools } = createRuntime(false);

    const response = await runtime.executeTools(
      request(
        'moysklad_create_order',
        { dealId: '42', items: [{ productId: 'product-1', quantity: 1 }] },
        [MOYSKLAD_SKILL()],
      ),
    );

    expect(tools.execute).not.toHaveBeenCalled();
    expect(response.messages[0]?.status).toBe('error');
  });

  it('заказ покупателя создаётся после одобрения', async () => {
    const { runtime, tools } = createRuntime(true);

    await runtime.executeTools(
      request(
        'moysklad_create_order',
        { dealId: '42', items: [{ productId: 'product-1', quantity: 1 }] },
        [MOYSKLAD_SKILL()],
      ),
    );

    expect(tools.execute).toHaveBeenCalledTimes(1);
  });

  it('чтение сделки не требует одобрения и делает Hold → Capture', async () => {
    const { runtime, tools, billing, pending } = createRuntime(false);

    await runtime.executeTools(
      request('bitrix24_get_deal', { dealId: '42' }, [BITRIX_SKILL()]),
    );

    expect(pending.hasApprovedGrant).not.toHaveBeenCalled();
    expect(tools.execute).toHaveBeenCalledTimes(1);
    expect(billing.authorizeHold).toHaveBeenCalledWith(
      'user-1',
      15,
      'paypercall:c1:call-1',
    );
    expect(billing.captureHold).toHaveBeenCalledWith('hold-1');
    expect(billing.checkAndChargeSkill).not.toHaveBeenCalled();
  });

  it('ошибка проверки одобрения трактуется как «нет одобрения»', async () => {
    const { runtime, tools, pending } = createRuntime(false);

    pending.hasApprovedGrant.mockRejectedValueOnce(new Error('db down'));

    const response = await runtime.executeTools(
      request('bitrix24_update_deal', { dealId: '42', stageId: 'WON' }, [
        BITRIX_SKILL(),
      ]),
    );

    expect(tools.execute).not.toHaveBeenCalled();
    expect(response.messages[0]?.status).toBe('error');
  });
});

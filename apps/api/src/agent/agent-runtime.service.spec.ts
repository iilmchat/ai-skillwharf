import { describe, expect, it, vi } from 'vitest';
import type { BillingService } from '../billing/billing.service.js';
import type { PendingApprovalService } from '../chat/persistence/pending-approval.service.js';
import type { AgentGatewayService } from '../security/agent-gateway.service.js';
import type { ToolExecutionRequest } from './contracts.js';
import { AgentRuntimeService } from './agent-runtime.service.js';
import type { AgentToolsService } from './agent-tools.service.js';

type MockFn = ReturnType<typeof vi.fn>;

interface Harness {
  runtime: AgentRuntimeService;
  tools: { has: MockFn; execute: MockFn };
  billing: {
    authorizeHold: MockFn;
    captureHold: MockFn;
    cancelHold: MockFn;
    checkAndChargeSkill: MockFn;
  };
  pending: { upsertPending: MockFn; resolvePending: MockFn; findPending: MockFn };
}

const FRAUD_MANIFEST = {
  name: 'fraud-shield-audit',
  version: '1.0.0',
  description: 'аудит',
  author: { name: 'SkillWharf' },
  permissions: [],
  dependencies: { tools: ['audit_fraud_risk'] },
  pricing: { model: 'Pay-per-Outcome', price: 500 },
  requiresApproval: true,
};

const PROFIT_MANIFEST = {
  name: 'profit-leak-detector',
  version: '1.0.0',
  description: 'утечки',
  author: { name: 'SkillWharf' },
  permissions: [],
  dependencies: { tools: ['detect_profit_leaks'] },
  pricing: { model: 'Pay-per-Call', price: 300 },
};

function createHarness(): Harness {
  const tools = {
    has: vi.fn(() => true),
    execute: vi.fn(
      async (
        _name: string,
        _args: unknown,
        options: { beforeExecute?: () => Promise<void> },
      ) => {
        await options.beforeExecute?.();

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
    validateToolCall: vi.fn((_name: string, args: unknown) => ({
      toolName: _name,
      args: args as Record<string, unknown>,
      egress: { requested: false, allowlist: [] },
      taint: { detected: false, masked: false },
    })),
  };
  const pending = {
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

function request(overrides: Partial<ToolExecutionRequest> = {}): ToolExecutionRequest {
  return {
    conversationId: 'c1',
    userId: 'user-1',
    skills: [],
    userRole: 'user',
    toolSkills: {},
    taintedSecrets: [],
    outcomePrices: {},
    calls: [{ id: 'call-1', name: 'detect_profit_leaks', args: { sellerId: 's1' } }],
    preAuthorizedHolds: {},
    ...overrides,
  };
}

describe('AgentRuntimeService: списания за реальные вызовы', () => {
  it('Pay-per-Outcome: hold → вызов → capture после успеха', async () => {
    const harness = createHarness();
    const order: string[] = [];

    harness.billing.authorizeHold.mockImplementationOnce(async () => {
      order.push('hold');

      return { entryId: 'hold-1' };
    });
    harness.tools.execute.mockImplementationOnce(async () => {
      order.push('tool');

      return '{"ok":true}';
    });
    harness.billing.captureHold.mockImplementationOnce(async () => {
      order.push('capture');

      return {};
    });

    await harness.runtime.executeTools(
      request({
        skills: [skill(FRAUD_MANIFEST)],
        outcomePrices: {
          audit_fraud_risk: { price: 500, skillName: 'fraud-shield-audit' },
        },
        calls: [
          { id: 'call-1', name: 'audit_fraud_risk', args: { campaignId: '1' } },
        ],
      }),
    );

    expect(order).toEqual(['hold', 'tool', 'capture']);
    expect(harness.billing.captureHold).toHaveBeenCalledWith('hold-1');
  });

  it('Pay-per-Outcome: ошибка инструмента отменяет hold', async () => {
    const harness = createHarness();

    harness.tools.execute.mockRejectedValueOnce(new Error('provider down'));

    await expect(
      harness.runtime.executeTools(
        request({
          skills: [skill(FRAUD_MANIFEST)],
          outcomePrices: {
            audit_fraud_risk: { price: 500, skillName: 'fraud-shield-audit' },
          },
          calls: [
            { id: 'call-1', name: 'audit_fraud_risk', args: { campaignId: '1' } },
          ],
        }),
      ),
    ).rejects.toThrow('provider down');

    expect(harness.billing.cancelHold).toHaveBeenCalledWith('hold-1');
    expect(harness.billing.captureHold).not.toHaveBeenCalled();
  });

  it('Pay-per-Call: списание BAL происходит в инструменте (beforeExecute)', async () => {
    const harness = createHarness();

    await harness.runtime.executeTools(
      request({
        skills: [skill(PROFIT_MANIFEST)],
        calls: [
          { id: 'call-1', name: 'detect_profit_leaks', args: { sellerId: 's1' } },
        ],
      }),
    );

    expect(harness.billing.checkAndChargeSkill).toHaveBeenCalledWith(
      'user-1',
      'profit-leak-detector',
      300,
      0,
    );
    // PPC не создаёт escrow-hold.
    expect(harness.billing.authorizeHold).not.toHaveBeenCalled();
  });

  it('prepareApproval создаёт hold и PendingApproval до interrupt', async () => {
    const harness = createHarness();

    const prepared = await harness.runtime.prepareApproval({
      conversationId: 'c1',
      userId: 'user-1',
      userRole: 'user',
      skills: [skill(FRAUD_MANIFEST)],
      toolSkills: {},
      taintedSecrets: [],
      outcomePrices: {
        audit_fraud_risk: { price: 500, skillName: 'fraud-shield-audit' },
      },
      calls: [
        { id: 'call-1', name: 'audit_fraud_risk', args: { campaignId: '1' } },
      ],
    });

    expect(harness.billing.authorizeHold).toHaveBeenCalledWith(
      'user-1',
      500,
      'approval:c1:call-1',
    );
    expect(harness.pending.upsertPending).toHaveBeenCalledWith(
      expect.objectContaining({
        conversationId: 'c1',
        userId: 'user-1',
        reason: 'payment',
        tools: ['audit_fraud_risk'],
        holds: [
          { callId: 'call-1', toolName: 'audit_fraud_risk', entryId: 'hold-1' },
        ],
      }),
    );
    expect(prepared).toEqual({
      reason: 'payment',
      tools: ['audit_fraud_risk'],
      holds: { 'call-1': 'hold-1' },
    });
  });
});

function skill(manifest: unknown): {
  id: string;
  name: string;
  manifest: unknown;
  isEnabled: boolean;
} {
  return {
    id: 'skill-1',
    name: typeof manifest === 'object' && manifest !== null && 'name' in manifest
      ? String((manifest as Record<string, unknown>).name)
      : 'skill',
    manifest,
    isEnabled: true,
  };
}

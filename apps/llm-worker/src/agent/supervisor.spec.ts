import { AIMessage } from '@langchain/core/messages';
import { describe, expect, it, vi } from 'vitest';
import type { AgentBridgeService } from './bridge.service.js';
import type { LlmInferenceService } from '../llm/inference.service.js';
import type { AgentRole, GraphEvent, RunGraphRequest } from '../contracts.js';
import { AgentRunnerService } from './runner.service.js';
import {
  DEFAULT_MAX_HANDOFFS,
  freshTraceId,
  handoffEvent,
  maxHandoffsFromEnv,
  selectNextRole,
} from './supervisor.js';

function context(overrides: Partial<RunGraphRequest> = {}): RunGraphRequest {
  return {
    messages: [],
    conversationId: 'conv-1',
    userId: 'user-1',
    skills: [],
    approvalRequiredTools: [],
    outcomePrices: {},
    llmRoutes: [],
    memoryContext: '',
    userRole: 'user',
    toolSkills: {},
    taintedSecrets: [],
    systemPrompt: 'Ты — ассистент',
    tools: [],
    ...overrides,
  };
}

function harness() {
  let calls = 0;
  const llm = {
    stream: vi.fn(async function* stream() {
      calls += 1;
      yield { type: 'delta', text: `ответ ${calls}` };
      yield { type: 'message', message: new AIMessage(`ответ ${calls}`) };
    }),
  };
  const bridge = {
    isConfigured: vi.fn(() => false),
    prepareApproval: vi.fn(),
    resolveApproval: vi.fn(),
    executeTools: vi.fn(),
  };

  return {
    runner: new AgentRunnerService(
      llm as unknown as LlmInferenceService,
      bridge as unknown as AgentBridgeService,
    ),
    llm,
  };
}

async function collect(stream: AsyncGenerator<GraphEvent>): Promise<GraphEvent[]> {
  const events: GraphEvent[] = [];

  for await (const event of stream) {
    events.push(event);
  }

  return events;
}

const handoffs = (events: GraphEvent[]) =>
  events.filter((event) => event.type === 'agent_handoff');

describe('supervisor: детерминированная маршрутизация (GRAPH-30.1)', () => {
  it('выбирает профильную роль по тексту запроса/инструмента', () => {
    const roles: AgentRole[] = ['researcher', 'drafter', 'reviewer', 'analyst', 'operator'];

    expect(selectNextRole(roles, new AIMessage('напиши статью'))).toBe('drafter');
    expect(selectNextRole(roles, new AIMessage('проверь отчёт'))).toBe('reviewer');
    expect(selectNextRole(roles, new AIMessage('создай отгрузку'))).toBe('operator');
    expect(selectNextRole([], undefined)).toBe('researcher');
  });

  it('публикует agent_handoff с единым traceId', async () => {
    const { runner } = harness();
    const events = await collect(
      runner.run(
        context({
          orchestrationMode: 'supervisor',
          agentRoles: ['researcher', 'drafter', 'reviewer'],
          traceId: 'trace-1',
        }),
      ),
    );
    const handoffEvents = handoffs(events);

    expect(handoffEvents.length).toBeGreaterThan(1);
    expect(handoffEvents.every((event) => event.traceId === 'trace-1')).toBe(true);
    expect(handoffEvents[0]).toMatchObject({
      type: 'agent_handoff',
      fromRole: 'supervisor',
      toRole: 'researcher',
    });
    expect(handoffEvents[1]?.fromRole).toBe('researcher');
    expect(handoffEvents.at(-1)).toMatchObject({ traceId: 'trace-1' });
    expect(events.at(-1)).toMatchObject({ type: 'done', traceId: 'trace-1' });
  });

  it('ограничивает число передач MULTI_AGENT_MAX_HANDOFFS', async () => {
    const previous = process.env.MULTI_AGENT_MAX_HANDOFFS;
    process.env.MULTI_AGENT_MAX_HANDOFFS = '2';

    try {
      const { runner } = harness();
      const events = await collect(
        runner.run(
          context({
            orchestrationMode: 'supervisor',
            agentRoles: ['researcher', 'drafter', 'reviewer'],
          }),
        ),
      );

      expect(handoffs(events)).toHaveLength(2);
      expect(events.at(-1)).toMatchObject({ type: 'done' });
      expect(maxHandoffsFromEnv()).toBe(2);
    } finally {
      if (previous === undefined) {
        delete process.env.MULTI_AGENT_MAX_HANDOFFS;
      } else {
        process.env.MULTI_AGENT_MAX_HANDOFFS = previous;
      }
    }
  });

  it('по умолчанию остаётся одиночным агентом без handoff-событий', async () => {
    const { runner } = harness();
    const events = await collect(runner.run(context()));

    expect(handoffs(events)).toHaveLength(0);
    expect(maxHandoffsFromEnv(undefined)).toBe(DEFAULT_MAX_HANDOFFS);
  });
});

describe('supervisor: утилиты', () => {
  it('событие handoff валидирует reason и генерирует traceId', () => {
    expect(handoffEvent({
      conversationId: 'c1',
      traceId: 't1',
      fromRole: 'supervisor',
      toRole: 'analyst',
      reason: 'старт',
    })).toMatchObject({ type: 'agent_handoff', toRole: 'analyst' });
    expect(() =>
      handoffEvent({
        conversationId: 'c1',
        traceId: 't1',
        fromRole: 'supervisor',
        toRole: 'analyst',
        reason: 'x'.repeat(300),
      }),
    ).toThrow();
    expect(freshTraceId(' custom ')).toBe('custom');
    expect(freshTraceId(undefined)).toMatch(/^[0-9a-f-]{36}$/);
  });
});

import { AIMessage } from '@langchain/core/messages';
import type { StructuredToolInterface } from '@langchain/core/tools';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentBridgeService } from './bridge.service.js';
import type { LlmInferenceService } from '../llm/inference.service.js';
import type { ApprovalRule, GraphContext, GraphEvent } from '../contracts.js';
import { AgentRunnerService } from './runner.service.js';

type MockFn = ReturnType<typeof vi.fn>;

interface LlmMock {
  stream: MockFn;
}

interface BridgeMock {
  isConfigured: MockFn;
  prepareApproval: MockFn;
  resolveApproval: MockFn;
  executeTools: MockFn;
}

function graphContext(): GraphContext {
  return {
    conversationId: 'conv-1',
    userId: 'user-1',
    skills: [],
    approvalRequiredTools: ['exec'],
    approvalRules: [],
    outcomePrices: {},
    llmRoutes: [],
    memoryContext: '',
    userRole: 'user',
    toolSkills: {},
    taintedSecrets: [],
    systemPrompt: 'Ты — ассистент',
    tools: [],
  };
}

function toolCallMessage(
  name = 'exec',
  args: Record<string, unknown> = { command: 'echo hi' },
): AIMessage {
  return new AIMessage({
    content: '',
    tool_calls: [{ name, args, id: 'call-1' }],
  });
}

function createRunner(options: {
  first: 'tool-call' | 'answer';
  second?: 'answer' | 'tool-call';
  /** Инструмент, который «вызывает» модель (по умолчанию `exec`). */
  toolName?: string;
  toolArgs?: Record<string, unknown>;
}): {
  runner: AgentRunnerService;
  llm: LlmMock;
  bridge: BridgeMock;
} {
  const toolName = options.toolName ?? 'exec';
  const toolArgs = options.toolArgs ?? { command: 'echo hi' };
  let call = 0;
  const llm: LlmMock = {
    stream: vi.fn(async function* stream() {
      call += 1;
      const kind = call === 1 ? options.first : (options.second ?? 'answer');

      if (kind === 'tool-call') {
        yield { type: 'message', message: toolCallMessage(toolName, toolArgs) };

        return;
      }

      yield { type: 'delta', text: 'готово' };
      yield { type: 'message', message: new AIMessage('готово') };
    }),
  };
  const bridge: BridgeMock = {
    isConfigured: vi.fn(() => false),
    prepareApproval: vi.fn(async () => ({
      reason: 'approval',
      tools: [toolName],
      holds: {},
    })),
    resolveApproval: vi.fn(async () => true),
    executeTools: vi.fn(async () => ({
      messages: [
        { toolCallId: 'call-1', name: toolName, content: 'ok' },
      ],
      taintedSecrets: [],
    })),
  };
  const runner = new AgentRunnerService(
    llm as unknown as LlmInferenceService,
    bridge as unknown as AgentBridgeService,
  );

  return { runner, llm, bridge };
}

async function collect(
  stream: AsyncGenerator<GraphEvent>,
): Promise<GraphEvent[]> {
  const events: GraphEvent[] = [];

  for await (const event of stream) {
    events.push(event);
  }

  return events;
}

describe('AgentRunnerService: HITL interrupt/resume', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('ставит граф на паузу и отдаёт approval + done(pendingApproval)', async () => {
    const { runner, bridge } = createRunner({ first: 'tool-call' });

    const events = await collect(
      runner.run({
        ...graphContext(),
        messages: [{ role: 'user', content: 'выполни команду' }],
      }),
    );

    expect(bridge.prepareApproval).toHaveBeenCalledWith(
      expect.objectContaining({
        conversationId: 'conv-1',
        userId: 'user-1',
        calls: [{ id: 'call-1', name: 'exec', args: { command: 'echo hi' } }],
      }),
    );
    expect(events).toContainEqual(
      expect.objectContaining({
        type: 'approval',
        conversationId: 'conv-1',
        reason: 'approval',
        tools: ['exec'],
      }),
    );
    expect(events.at(-1)).toEqual(
      expect.objectContaining({ type: 'done', pendingApproval: true }),
    );
    expect(bridge.executeTools).not.toHaveBeenCalled();
  });

  it('после approve выполняет инструменты и завершает ответ', async () => {
    const { runner, bridge, llm } = createRunner({
      first: 'tool-call',
      second: 'answer',
    });

    await collect(
      runner.run({
        ...graphContext(),
        messages: [{ role: 'user', content: 'выполни команду' }],
      }),
    );

    // Возобновление идёт по тому же checkpoint-треду (MemorySaver).
    const events = await collect(
      runner.resume({ ...graphContext(), approved: true }),
    );

    expect(bridge.resolveApproval).toHaveBeenCalledWith('conv-1', true);
    expect(bridge.executeTools).toHaveBeenCalledWith(
      expect.objectContaining({
        calls: [{ id: 'call-1', name: 'exec', args: { command: 'echo hi' } }],
      }),
    );
    expect(events).toContainEqual({ type: 'delta', text: 'готово' });
    expect(events.at(-1)).toEqual(
      expect.objectContaining({
        type: 'done',
        reply: 'готово',
        pendingApproval: false,
      }),
    );
    expect(llm.stream).toHaveBeenCalledTimes(2);
  });

  it('при отклонении не выполняет инструменты и отдаёт отказ в граф', async () => {
    const { runner, bridge, llm } = createRunner({
      first: 'tool-call',
      second: 'answer',
    });

    await collect(
      runner.run({
        ...graphContext(),
        messages: [{ role: 'user', content: 'выполни команду' }],
      }),
    );

    const events = await collect(
      runner.resume({ ...graphContext(), approved: false }),
    );

    expect(bridge.resolveApproval).toHaveBeenCalledWith('conv-1', false);
    expect(bridge.executeTools).not.toHaveBeenCalled();
    expect(llm.stream).toHaveBeenCalledTimes(2);
    expect(events.at(-1)).toEqual(
      expect.objectContaining({ type: 'done', pendingApproval: false }),
    );
  });

  it('условный HITL: промежуточная стадия сделки выполняется без паузы', async () => {
    const dealRule: ApprovalRule = {
      tool: 'bitrix24_update_deal',
      arg: 'stageId',
      values: ['WON'],
    };
    const { runner, bridge } = createRunner({
      first: 'tool-call',
      toolName: 'bitrix24_update_deal',
      toolArgs: { dealId: '42', stageId: 'EXECUTING' },
    });

    const events = await collect(
      runner.run({
        ...graphContext(),
        approvalRequiredTools: ['bitrix24_update_deal'],
        approvalRules: [dealRule],
        messages: [{ role: 'user', content: 'переведи сделку в работу' }],
      }),
    );

    expect(bridge.prepareApproval).not.toHaveBeenCalled();
    expect(bridge.executeTools).toHaveBeenCalledWith(
      expect.objectContaining({
        calls: [
          {
            id: 'call-1',
            name: 'bitrix24_update_deal',
            args: { dealId: '42', stageId: 'EXECUTING' },
          },
        ],
      }),
    );
    expect(events.at(-1)).toEqual(
      expect.objectContaining({ type: 'done', pendingApproval: false }),
    );
  });

  it('условный HITL: комментарий без stageId выполняется без паузы', async () => {
    const dealRule: ApprovalRule = {
      tool: 'bitrix24_update_deal',
      arg: 'stageId',
      values: ['WON'],
    };
    const { runner, bridge } = createRunner({
      first: 'tool-call',
      toolName: 'bitrix24_update_deal',
      toolArgs: { dealId: '42', comments: 'Клиент ждёт счёт' },
    });

    await collect(
      runner.run({
        ...graphContext(),
        approvalRequiredTools: ['bitrix24_update_deal'],
        approvalRules: [dealRule],
        messages: [{ role: 'user', content: 'добавь комментарий' }],
      }),
    );

    expect(bridge.prepareApproval).not.toHaveBeenCalled();
    expect(bridge.executeTools).toHaveBeenCalledTimes(1);
  });

  it('условный HITL: финальная стадия WON останавливает граф', async () => {
    const dealRule: ApprovalRule = {
      tool: 'bitrix24_update_deal',
      arg: 'stageId',
      values: ['WON'],
    };
    const { runner, bridge } = createRunner({
      first: 'tool-call',
      toolName: 'bitrix24_update_deal',
      toolArgs: { dealId: '42', stageId: 'C1:WON' },
    });

    const events = await collect(
      runner.run({
        ...graphContext(),
        approvalRequiredTools: ['bitrix24_update_deal'],
        approvalRules: [dealRule],
        messages: [{ role: 'user', content: 'закрой сделку' }],
      }),
    );

    expect(bridge.prepareApproval).toHaveBeenCalledWith(
      expect.objectContaining({
        calls: [
          {
            id: 'call-1',
            name: 'bitrix24_update_deal',
            args: { dealId: '42', stageId: 'C1:WON' },
          },
        ],
      }),
    );
    expect(bridge.executeTools).not.toHaveBeenCalled();
    expect(events.at(-1)).toEqual(
      expect.objectContaining({ type: 'done', pendingApproval: true }),
    );
  });

  it('передаёт systemPrompt и маршруты в inference для каждого раунда', async () => {
    const { runner, llm } = createRunner({ first: 'answer' });

    await collect(
      runner.run({
        ...graphContext(),
        messages: [{ role: 'user', content: 'привет' }],
      }),
    );

    expect(llm.stream).toHaveBeenCalledWith(
      expect.any(Array),
      [] as StructuredToolInterface[],
      [],
      'Ты — ассистент',
      expect.objectContaining({ userId: 'user-1', agentId: 'default' }),
    );
  });
});

describe('AgentRunnerService: executionTrace (UX-37.3)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('передаёт хронологию шагов в событие done', async () => {
    const { runner } = createRunner({ first: 'tool-call' });

    const events = await collect(
      runner.run({
        ...graphContext(),
        messages: [{ role: 'user', content: 'выполни команду' }],
      }),
    );
    const done = events.at(-1);

    expect(done?.type).toBe('done');
    expect(done?.type === 'done' && done.executionTrace?.length).toBeGreaterThan(0);
    if (done?.type === 'done') {
      expect(done.executionTrace?.[0]).toMatchObject({
        stepIndex: 0,
        name: expect.any(String),
        status: expect.any(String),
      });
    }
  });
});

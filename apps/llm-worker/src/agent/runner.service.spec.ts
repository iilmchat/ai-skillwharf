import { AIMessage } from '@langchain/core/messages';
import type { StructuredToolInterface } from '@langchain/core/tools';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentBridgeService } from './bridge.service.js';
import type { LlmInferenceService } from '../llm/inference.service.js';
import type { GraphContext, GraphEvent } from '../contracts.js';
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

function toolCallMessage(): AIMessage {
  return new AIMessage({
    content: '',
    tool_calls: [{ name: 'exec', args: { command: 'echo hi' }, id: 'call-1' }],
  });
}

function createRunner(options: {
  first: 'tool-call' | 'answer';
  second?: 'answer' | 'tool-call';
}): {
  runner: AgentRunnerService;
  llm: LlmMock;
  bridge: BridgeMock;
} {
  let call = 0;
  const llm: LlmMock = {
    stream: vi.fn(async function* stream() {
      call += 1;
      const kind = call === 1 ? options.first : (options.second ?? 'answer');

      if (kind === 'tool-call') {
        yield { type: 'message', message: toolCallMessage() };

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
      tools: ['exec'],
      holds: {},
    })),
    resolveApproval: vi.fn(async () => true),
    executeTools: vi.fn(async () => ({
      messages: [
        { toolCallId: 'call-1', name: 'exec', content: 'echo hi' },
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

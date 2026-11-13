import { AIMessageChunk, HumanMessage } from '@langchain/core/messages';
import type { StructuredToolInterface } from '@langchain/core/tools';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentBridgeService } from '../agent/bridge.service.js';
import type { LlmRouteSelection } from '../contracts.js';
import {
  LlmInferenceService,
  LlmUnavailableError,
  type InferenceChunk,
} from './inference.service.js';

const { streamMock } = vi.hoisted(() => ({ streamMock: vi.fn() }));

vi.mock('@langchain/openai', () => ({
  ChatOpenAI: class {
    bindTools(): this {
      return this;
    }

    stream(...args: unknown[]): unknown {
      return streamMock(...args);
    }
  },
}));

const ENV_KEYS = ['LLM_BASE_URL', 'LLM_MODEL', 'LLM_API_KEY'] as const;

function restoreEnv(): void {
  for (const key of ENV_KEYS) {
    delete process.env[key];
  }
}

function route(overrides: Partial<LlmRouteSelection> = {}): LlmRouteSelection {
  return {
    id: 'r1',
    name: 'primary',
    modelName: 'test-model',
    providerType: 'OpenAI',
    baseUrl: 'http://llm.test/v1',
    apiKeyEnvVar: null,
    taskType: 'chat',
    dailyCostLimit: null,
    ...overrides,
  };
}

function bridgeMock(): {
  reserveBudget: ReturnType<typeof vi.fn>;
  settleBudget: ReturnType<typeof vi.fn>;
  refundBudget: ReturnType<typeof vi.fn>;
} {
  return {
    reserveBudget: vi.fn(async () => ({ reserved: 0, tracked: false })),
    settleBudget: vi.fn(async () => undefined),
    refundBudget: vi.fn(async () => undefined),
  };
}

type BridgeMock = ReturnType<typeof bridgeMock>;

function serviceWith(bridge: BridgeMock): LlmInferenceService {
  return new LlmInferenceService(bridge as unknown as AgentBridgeService);
}

/** Провайдер падает ошибкой с HTTP-статусом. */
function failingStream(status: number, message = 'provider failed'): void {
  const error = Object.assign(new Error(message), { status });

  streamMock.mockImplementation(() => ({
    [Symbol.asyncIterator]() {
      return {
        next: async (): Promise<IteratorResult<never>> => {
          throw error;
        },
      };
    },
  }));
}

function succeedingStream(text = 'ответ'): void {
  streamMock.mockImplementation(async function* succeed() {
    yield new AIMessageChunk({
      content: text,
      usage_metadata: {
        input_tokens: 3,
        output_tokens: 2,
        total_tokens: 5,
      },
    });
  });
}

async function drain(
  stream: AsyncGenerator<InferenceChunk, unknown>,
): Promise<InferenceChunk[]> {
  const chunks: InferenceChunk[] = [];

  for await (const chunk of stream) {
    chunks.push(chunk);
  }

  return chunks;
}

const messages = [new HumanMessage('привет')];
const noTools: StructuredToolInterface[] = [];

describe('LlmInferenceService: 502 для одиночного маршрута (KI-041)', () => {
  beforeEach(() => {
    restoreEnv();
    vi.clearAllMocks();
  });

  afterEach(() => {
    restoreEnv();
    vi.restoreAllMocks();
  });

  it('одиночный маршрут на retriable-ошибке отдаёт 502 errors.llm_unavailable', async () => {
    const bridge = bridgeMock();
    const service = serviceWith(bridge);
    failingStream(503);

    await expect(
      drain(service.stream(messages, noTools, [route()], 'system', { userId: 'u1' })),
    ).rejects.toBeInstanceOf(LlmUnavailableError);

    expect(bridge.refundBudget).toHaveBeenCalledTimes(1);
  });

  it('env-fallback без маршрутов на retriable-ошибке отдаёт 502', async () => {
    process.env.LLM_BASE_URL = 'http://llm.test/v1';
    process.env.LLM_MODEL = 'env-model';
    const bridge = bridgeMock();
    const service = serviceWith(bridge);
    failingStream(429, 'Too Many Requests');

    await expect(
      drain(service.stream(messages, noTools, [], 'system', { userId: 'u1' })),
    ).rejects.toBeInstanceOf(LlmUnavailableError);
  });

  it('ошибка 400 не маскируется: пробрасывается исходная ошибка', async () => {
    const bridge = bridgeMock();
    const service = serviceWith(bridge);
    failingStream(400, 'bad request');

    const error = await drain(
      service.stream(messages, noTools, [route()], 'system', { userId: 'u1' }),
    ).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(LlmUnavailableError);
    expect((error as Error).message).toBe('bad request');
  });

  it('при падении всей цепочки возвращает резерв ровно один раз', async () => {
    const bridge = bridgeMock();
    const service = serviceWith(bridge);
    failingStream(503);

    await expect(
      drain(
        service.stream(
          messages,
          noTools,
          [route(), route({ id: 'r2', name: 'secondary' })],
          'system',
          { userId: 'u1' },
        ),
      ),
    ).rejects.toBeInstanceOf(LlmUnavailableError);

    expect(bridge.refundBudget).toHaveBeenCalledTimes(1);
  });

  it('без LLM_BASE_URL работает эхо-заглушка без вызова провайдера', async () => {
    const bridge = bridgeMock();
    const service = serviceWith(bridge);

    const chunks = await drain(
      service.stream(messages, noTools, [], 'system', { userId: 'u1' }),
    );

    expect(chunks).toEqual([
      { type: 'delta', text: 'LLM not configured: привет' },
      expect.objectContaining({ type: 'message' }),
    ]);
    expect(streamMock).not.toHaveBeenCalled();
    expect(bridge.reserveBudget).not.toHaveBeenCalled();
  });

  it('успешный стрим отдаёт дельту и сверяет бюджет с usage', async () => {
    const bridge = bridgeMock();
    const service = serviceWith(bridge);
    succeedingStream('готово');

    const chunks = await drain(
      service.stream(messages, noTools, [route()], 'system', { userId: 'u1' }),
    );

    expect(chunks[0]).toEqual({ type: 'delta', text: 'готово' });
    expect(bridge.reserveBudget).toHaveBeenCalledTimes(1);
    expect(bridge.settleBudget).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 'u1',
        reserved: 0,
        estimated: false,
        usage: { input_tokens: 3, output_tokens: 2, total_tokens: 5 },
        route: expect.objectContaining({ name: 'primary' }),
      }),
    );
    expect(bridge.refundBudget).not.toHaveBeenCalled();
  });
});

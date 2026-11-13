import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiException } from '../common/api-error.js';
import { LlmWorkerClient } from './llm-worker.client.js';

function ndjson(...events: unknown[]): Response {
  const body = events.map((event) => `${JSON.stringify(event)}\n`).join('');

  return new Response(body, {
    status: 200,
    headers: { 'content-type': 'application/x-ndjson' },
  });
}

const baseRequest = {
  conversationId: 'c1',
  userId: 'u1',
  messages: [{ role: 'user' as const, content: 'привет' }],
  skills: [],
  approvalRequiredTools: [],
  outcomePrices: {},
  llmRoutes: [],
  memoryContext: '',
  userRole: 'user' as const,
  toolSkills: {},
  taintedSecrets: [],
  systemPrompt: 'system',
  tools: [],
};

describe('LlmWorkerClient', () => {
  beforeEach(() => {
    process.env.LLM_WORKER_URL = 'http://llm-worker:4100';
    process.env.INTERNAL_API_TOKEN = 'test-token';
  });

  afterEach(() => {
    vi.restoreAllMocks();
    delete process.env.LLM_WORKER_URL;
    delete process.env.INTERNAL_API_TOKEN;
  });

  it('читает NDJSON-события и отдаёт done с reply', async () => {
    const fetchMock = vi.fn(async () => {
      return ndjson(
        { type: 'delta', text: 'Здрав' },
        { type: 'delta', text: 'ствуйте' },
        {
          type: 'done',
          conversationId: 'c1',
          reply: 'Здравствуйте',
          pendingApproval: false,
        },
      );
    });
    vi.stubGlobal('fetch', fetchMock);

    const client = new LlmWorkerClient();
    const events = [];

    for await (const event of client.run(baseRequest)) {
      events.push(event);
    }

    expect(events).toEqual([
      { type: 'delta', text: 'Здрав' },
      { type: 'delta', text: 'ствуйте' },
      {
        type: 'done',
        conversationId: 'c1',
        reply: 'Здравствуйте',
        pendingApproval: false,
      },
    ]);
    expect(fetchMock).toHaveBeenCalledWith(
      'http://llm-worker:4100/v1/graphs/run',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          'x-internal-token': 'test-token',
        }),
      }),
    );
  });

  it('превращает error-событие worker\'а в ApiException', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        ndjson({
          type: 'error',
          statusCode: 429,
          code: 'errors.daily_token_limit',
          message: 'Лимит',
        }),
      ),
    );

    const client = new LlmWorkerClient();
    const iterate = async (): Promise<void> => {
      for await (const _ of client.run(baseRequest)) {
        // События до ошибки не ожидаются.
      }
    };
    const error: unknown = await iterate().catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ApiException);
    expect((error as ApiException).getStatus()).toBe(429);
  });
});

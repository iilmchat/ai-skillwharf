import { describe, expect, it, vi } from 'vitest';
import { QdrantVectorStore, createVectorMemoryStore } from './vector-store.js';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('QdrantVectorStore (INFRA-28.3)', () => {
  it('создаёт коллекцию, пишет point с userId в payload и ищет с фильтром', async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fetchMock = vi.fn(async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      const method = init.method ?? 'GET';

      if (method === 'PUT' && url.endsWith('/collections/skillwharf_memory')) {
        return jsonResponse({ result: true });
      }
      if (url.includes('/points/search')) {
        return jsonResponse({
          result: {
            points: [
              { payload: { userId: 'u1', content: 'самвывоз', kind: 'fact' } },
              { payload: { userId: 'u1', content: 'скидка' } },
              { payload: { userId: 'u2', content: 'чужой' } },
            ],
          },
        });
      }

      return jsonResponse({ result: true });
    });
    const store = new QdrantVectorStore({
      url: 'http://qdrant:6333',
      fetch: fetchMock as unknown as typeof fetch,
    });

    await store.upsert({
      id: 'chunk-1',
      userId: 'u1',
      content: 'самовывоз',
      embedding: [0.1, 0.2],
      source: 'chat',
      kind: 'preference',
    });
    const found = await store.search('u1', [0.1, 0.2], 3);

    expect(found).toEqual(['самвывоз', 'скидка', 'чужой']);
    expect(calls[0]?.url).toBe('http://qdrant:6333/collections/skillwharf_memory');
    const body = JSON.parse(String(calls[1]?.init.body)) as {
      points: Array<{ id: string; payload: Record<string, unknown> }>;
    };

    expect(body.points[0]).toMatchObject({
      id: 'chunk-1',
      payload: { userId: 'u1', source: 'chat', kind: 'preference' },
    });
    const searchBody = JSON.parse(
      String(calls.find((call) => call.url.includes('/points/search'))?.init.body),
    ) as { filter: { must: Array<{ key: string }> } };

    expect(searchBody.filter.must[0]?.key).toBe('userId');
  });

  it('fail closed: невалидный ответ поиска отклоняется', async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url.endsWith('/collections/skillwharf_memory')) {
        return jsonResponse({ result: true });
      }

      return jsonResponse({ unexpected: true });
    });
    const store = new QdrantVectorStore({
      url: 'http://qdrant:6333',
      fetch: fetchMock as unknown as typeof fetch,
    });

    await expect(store.search('u1', [0.1], 3)).rejects.toThrow(
      /некорректный ответ/,
    );
  });

  it('фабрика выбирает провайдера по VECTOR_STORE_PROVIDER', () => {
    const prisma = {} as never;

    expect(createVectorMemoryStore(prisma, {}).provider).toBe('pgvector');
    expect(
      createVectorMemoryStore(prisma, {
        VECTOR_STORE_PROVIDER: 'qdrant',
        QDRANT_URL: 'http://qdrant:6333',
      }).provider,
    ).toBe('qdrant');
    expect(() =>
      createVectorMemoryStore(prisma, { VECTOR_STORE_PROVIDER: 'qdrant' }),
    ).toThrow(/QDRANT_URL/);
    expect(() =>
      createVectorMemoryStore(prisma, { VECTOR_STORE_PROVIDER: 'weaviate' }),
    ).toThrow();
  });
});

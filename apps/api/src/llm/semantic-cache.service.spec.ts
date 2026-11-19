import { describe, expect, it, vi } from 'vitest';
import type { EmbeddingsService } from '../memory/embeddings.service.js';
import type { MetricsService } from '../metrics/metrics.service.js';
import {
  cosineSimilarity,
  SemanticCacheService,
  type SemanticCacheQuery,
} from './semantic-cache.service.js';

/** Детерминированный эмбеддинг: первая координата кодирует смысл запроса. */
function embeddings(value: number) {
  return {
    isConfigured: vi.fn(() => true),
    embed: vi.fn(async () => [value, 1 - value]),
  };
}

function harness(env: NodeJS.ProcessEnv = {}, value = 1) {
  const embed = embeddings(value);
  const metrics = {
    countSemanticCacheResult: vi.fn(),
  };
  const service = new SemanticCacheService(
    embed as unknown as EmbeddingsService,
    metrics as unknown as MetricsService,
    '',
    env,
  );

  return { service, embed, metrics };
}

const query = (overrides: Partial<SemanticCacheQuery> = {}): SemanticCacheQuery => ({
  userId: 'user-a',
  promptVersionId: 'v1',
  model: 'gpt-4o',
  query: 'Каковы остатки SKU-1001?',
  ...overrides,
});

describe('SemanticCacheService (CACHE-30.2)', () => {
  it('изолирует кеш по userId / promptVersionId / model', async () => {
    const { service } = harness();
    const original = query();

    await service.store(original, 'Ответ для user-a');

    expect(await service.lookup(original)).toMatchObject({
      hit: true,
      reply: 'Ответ для user-a',
    });
    expect(await service.lookup(query({ userId: 'user-b' }))).toEqual({ hit: false });
    expect(await service.lookup(query({ promptVersionId: 'v2' }))).toEqual({
      hit: false,
    });
    expect(await service.lookup(query({ model: 'gpt-4o-mini' }))).toEqual({
      hit: false,
    });
  });

  it('применяет порог 0.95: близкий, но не совпадающий запрос — промах', async () => {
    const { service, embed, metrics } = harness(
      { SEMANTIC_CACHE_THRESHOLD: '0.95' },
      0.94,
    );

    await service.store(query(), 'Ответ');
    embed.embed.mockResolvedValueOnce([0.7, 0.3]); // близкий, но ниже порога
    const result = await service.lookup(query());

    expect(service.threshold).toBe(0.95);
    expect(result).toEqual({ hit: false });
    expect(metrics.countSemanticCacheResult).toHaveBeenLastCalledWith(
      'gpt-4o',
      false,
    );

    embed.embed.mockResolvedValueOnce([1, 0]);
    expect(await service.lookup(query())).toMatchObject({ hit: true });
    expect(metrics.countSemanticCacheResult).toHaveBeenLastCalledWith(
      'gpt-4o',
      true,
    );
  });

  it('не кеширует запросы с инструментами', async () => {
    const { service } = harness();

    const toolQuery = query({ toolCalls: ['moysklad_check_stock'] });

    expect(service.isCacheable(toolQuery)).toBe(false);
    await service.store(toolQuery, 'Устаревшие остатки');
    expect(await service.lookup(toolQuery)).toEqual({ hit: false });
    expect(service.isCacheable(query({ toolsEnabled: true }))).toBe(false);
  });

  it('cosineSimilarity устойчив к нулевым векторам', () => {
    expect(cosineSimilarity([1, 0], [1, 0])).toBe(1);
    expect(cosineSimilarity([1, 0], [0, 1])).toBe(0);
    expect(cosineSimilarity([], [])).toBe(0);
  });

  it('уважает TTL из env и не валится без Redis', async () => {
    const { service } = harness({ SEMANTIC_CACHE_TTL_SECONDS: '30' });

    await expect(service.store(query(), 'Ответ')).resolves.toBeUndefined();
    expect(await service.lookup(query())).toMatchObject({ hit: true });
  });
});

import type { AxiosInstance } from 'axios';
import { describe, expect, it, vi } from 'vitest';
import {
  EMBEDDINGS_TIMEOUT_MS,
  EmbeddingsService,
  MEMORY_EMBEDDING_DIMENSIONS,
  normalizeEmbedding,
} from './embeddings.service.js';

type PostMock = ReturnType<typeof vi.fn>;

function httpWith(post: PostMock): AxiosInstance {
  return { post } as unknown as AxiosInstance;
}

describe('normalizeEmbedding', () => {
  it('дополняет короткий вектор нулями до размерности колонки', () => {
    const vector = normalizeEmbedding([0.1, 0.2, 0.3]);

    expect(vector).toHaveLength(MEMORY_EMBEDDING_DIMENSIONS);
    expect(vector.slice(0, 3)).toEqual([0.1, 0.2, 0.3]);
    expect(vector[3]).toBe(0);
  });

  it('отбрасывает лишние значения и нечисловые элементы', () => {
    const vector = normalizeEmbedding([1, Number.NaN, 3], 3);

    expect(vector).toEqual([1, 0, 3]);
    expect(normalizeEmbedding([1, 2, 3, 4], 2)).toEqual([1, 2]);
  });
});

describe('EmbeddingsService', () => {
  it('без baseUrl и модели не делает запросов', async () => {
    const post = vi.fn();
    const service = new EmbeddingsService({
      baseUrl: '',
      apiKey: '',
      model: '',
      http: httpWith(post),
    });

    expect(service.isConfigured()).toBe(false);
    await expect(service.embed('привет')).resolves.toBeNull();
    expect(post).not.toHaveBeenCalled();
  });

  it('запрашивает OpenAI-совместимый /embeddings и нормализует вектор', async () => {
    const post = vi.fn().mockResolvedValue({
      data: { data: [{ embedding: [0.5, 0.25] }] },
    });
    const service = new EmbeddingsService({
      baseUrl: 'http://localhost:1234/v1/',
      apiKey: 'secret',
      model: 'nomic-embed-text',
      http: httpWith(post),
    });

    const vector = await service.embed('  доставка  ');

    expect(post).toHaveBeenCalledWith(
      'http://localhost:1234/v1/embeddings',
      { model: 'nomic-embed-text', input: 'доставка' },
      { headers: { Authorization: 'Bearer secret' } },
    );
    expect(vector).toHaveLength(MEMORY_EMBEDDING_DIMENSIONS);
    expect(vector?.slice(0, 2)).toEqual([0.5, 0.25]);
  });

  it('не отправляет Authorization без apiKey', async () => {
    const post = vi
      .fn()
      .mockResolvedValue({ data: { data: [{ embedding: [1] }] } });
    const service = new EmbeddingsService({
      baseUrl: 'http://localhost:1234/v1',
      apiKey: '',
      model: 'local',
      http: httpWith(post),
    });

    await service.embed('текст');

    expect(post.mock.calls[0]?.[2]).toEqual({ headers: {} });
    expect(EMBEDDINGS_TIMEOUT_MS).toBeGreaterThan(0);
  });

  it('возвращает null, если провайдер вернул ошибку', async () => {
    const post = vi.fn().mockRejectedValue(new Error('HTTP 500'));
    const service = new EmbeddingsService({
      baseUrl: 'http://localhost:1234/v1',
      apiKey: '',
      model: 'local',
      http: httpWith(post),
    });

    await expect(service.embed('текст')).resolves.toBeNull();
  });

  it('возвращает null на пустой вектор в ответе', async () => {
    const post = vi.fn().mockResolvedValue({ data: { data: [] } });
    const service = new EmbeddingsService({
      baseUrl: 'http://localhost:1234/v1',
      apiKey: '',
      model: 'local',
      http: httpWith(post),
    });

    await expect(service.embed('текст')).resolves.toBeNull();
  });
});

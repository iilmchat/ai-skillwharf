import { afterEach, describe, expect, it, vi } from 'vitest';
import type { LlmRouterService } from '../llm-router/llm-router.service.js';
import { ArtifactRefineService } from './artifact-refine.service.js';

const ROUTE = {
  id: 'route-1',
  name: 'chat',
  modelName: 'gpt-test',
  providerType: 'openai',
  baseUrl: 'https://llm.example.com/v1',
  apiKeyEnvVar: 'TEST_LLM_KEY',
  taskType: 'chat',
  dailyCostLimit: null,
};

const REQUEST = {
  artifactType: 'document',
  title: 'Договор',
  fullContent: 'Пункт 1\nПункт 2\nПункт 3',
  selectedText: 'Пункт 2',
  instruction: 'Переформулируй второй пункт',
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('ArtifactRefineService (UX-37.1)', () => {
  it('отправляет точечный запрос и возвращает { updatedContent, summary }', async () => {
    const router = {
      selectRoutes: vi.fn(async () => [ROUTE]),
    };
    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        choices: [
          {
            message: {
              content: JSON.stringify({
                updatedContent: 'Пункт 1\nВторой пункт обновлён\nПункт 3',
                summary: 'Переформулирован пункт 2',
              }),
            },
          },
        ],
      }),
    }));
    vi.stubGlobal('fetch', fetchMock);
    const service = new ArtifactRefineService(
      router as unknown as LlmRouterService,
    );

    const result = await service.refine(REQUEST);

    expect(result).toEqual({
      updatedContent: 'Пункт 1\nВторой пункт обновлён\nПункт 3',
      summary: 'Переформулирован пункт 2',
    });
    const [url, init] = fetchMock.mock.calls[0] as unknown as [
      string,
      RequestInit,
    ];

    expect(url).toBe('https://llm.example.com/v1/chat/completions');
    const body = JSON.parse(init.body as string) as {
      messages: Array<{ content: string }>;
    };
    const userPrompt = body.messages[1]?.content ?? '';

    expect(userPrompt).toContain('ВЫДЕЛЕННЫЙ ФРАГМЕНТ');
    expect(userPrompt).toContain('Пункт 1\nПункт 2\nПункт 3');
  });

  it('отвергает selectedText вне fullContent через Zod', async () => {
    const router = { selectRoutes: vi.fn(async () => [ROUTE]) };
    const service = new ArtifactRefineService(
      router as unknown as LlmRouterService,
    );

    await expect(
      service.refine({ ...REQUEST, selectedText: 'нет в документе' }),
    ).rejects.toThrow();
  });

  it('Возвращает ApiException, если LLM недоступна', async () => {
    const router = { selectRoutes: vi.fn(async () => [ROUTE]) };
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: false, status: 503, json: async () => ({}) })),
    );
    const service = new ArtifactRefineService(
      router as unknown as LlmRouterService,
    );

    await expect(service.refine(REQUEST)).rejects.toMatchObject({
      message: expect.stringContaining('503'),
    });
  });
});

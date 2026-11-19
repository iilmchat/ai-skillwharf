import { AxiosError, type AxiosResponse } from 'axios';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createPromptExperiment,
  createPromptExperimentSchema,
  fetchPromptExperiments,
  getAdminErrorMessage,
  isPromptExperimentActive,
  promptExperimentListSchema,
  promptExperimentSchema,
  stopPromptExperiment,
} from './admin';

const { getMock, postMock } = vi.hoisted(() => ({
  getMock: vi.fn(),
  postMock: vi.fn(),
}));

vi.mock('./api', () => ({
  api: { get: getMock, post: postMock },
}));

vi.mock('../i18n', () => ({
  default: {
    t: (key: string) => key,
    exists: () => false,
  },
}));

const VALID_EXPERIMENT = {
  id: 'exp-1',
  name: 'Сравнение системных промптов',
  status: 'running',
  variantAVersionId: 'ver-1',
  variantBVersionId: 'ver-2',
  trafficSplitB: 30,
  createdAt: '2026-11-19T10:00:00.000Z',
  metrics: {
    A: { calls: 120, avgLatencyMs: 850, avgCost: 1.5 },
    B: { calls: 90, avgLatencyMs: 700, avgCost: 1.2 },
  },
};

function httpError(status: number): AxiosError {
  const response = {
    status,
    statusText: '',
    headers: {},
    config: {},
    data: { message: 'ошибка' },
  } as unknown as AxiosResponse;

  return new AxiosError('запрос отклонён', undefined, undefined, undefined, response);
}

describe('Zod-контракт A/B-экспериментов', () => {
  it('принимает канонический эксперимент и приводит метрики к числам', () => {
    const parsed = promptExperimentSchema.parse({
      ...VALID_EXPERIMENT,
      metrics: {
        A: { calls: '120', avgLatencyMs: '850.5', avgCost: '1.50' },
      },
    });

    expect(parsed.metrics?.A).toEqual({
      calls: 120,
      avgLatencyMs: 850.5,
      avgCost: 1.5,
    });
    expect(isPromptExperimentActive(parsed)).toBe(true);
  });

  it('понимает вложенные версии и альтернативные имена метрик', () => {
    const parsed = promptExperimentSchema.parse({
      id: 'exp-2',
      name: 'Fallback-формат',
      createdAt: '2026-11-19T11:00:00.000Z',
      variantA: { versionId: 'ver-3' },
      variantB: { versionId: 'ver-4' },
      trafficSplit: '50',
      variantAMetrics: { requests: 10, avgLatency: 200, avgCostRub: 0.4 },
      variantBMetrics: { requests: 12, avgLatency: 180, avgCostRub: 0.3 },
    });

    expect(parsed.status).toBe('running');
    expect(parsed.variantAVersionId).toBe('ver-3');
    expect(parsed.variantBVersionId).toBe('ver-4');
    expect(parsed.trafficSplitB).toBe(50);
    expect(parsed.metrics?.A).toEqual({
      calls: 10,
      avgLatencyMs: 200,
      avgCost: 0.4,
    });
  });

  it('принимает список в массиве и в обёртке', () => {
    expect(promptExperimentListSchema.parse([VALID_EXPERIMENT])).toHaveLength(1);
    expect(
      promptExperimentListSchema.parse({ items: [VALID_EXPERIMENT] }),
    ).toHaveLength(1);
    expect(
      promptExperimentListSchema.parse({ experiments: [VALID_EXPERIMENT] }),
    ).toHaveLength(1);
  });

  it('ответ API принимает долю 0–100 и nullable stoppedAt', () => {
    expect(
      promptExperimentSchema.parse({
        ...VALID_EXPERIMENT,
        trafficSplitB: 100,
        stoppedAt: null,
        winnerVersionId: null,
        metrics: {
          A: { requests: 1, avgLatencyMs: 100, avgCost: 0.1 },
          B: { requests: 2, avgLatencyMs: 90, avgCost: 0.2 },
        },
      }).trafficSplitB,
    ).toBe(100);
    expect(
      promptExperimentSchema.safeParse({
        ...VALID_EXPERIMENT,
        trafficSplitB: 101,
      }).success,
    ).toBe(false);
  });

  it('отвергает невалидные метрики', () => {
    expect(
      promptExperimentSchema.safeParse({
        ...VALID_EXPERIMENT,
        metrics: { A: { calls: -1, avgLatencyMs: 1, avgCost: 1 } },
      }).success,
    ).toBe(false);
  });

  it('валидирует форму запуска и запрещает одинаковые версии', () => {
    const input = {
      name: '  Тест  ',
      variantAVersionId: 'ver-1',
      variantBVersionId: 'ver-2',
      trafficSplitB: 50,
    };

    expect(createPromptExperimentSchema.parse(input).name).toBe('Тест');
    expect(
      createPromptExperimentSchema.safeParse({
        ...input,
        variantBVersionId: 'ver-1',
      }).success,
    ).toBe(false);
    expect(
      createPromptExperimentSchema.safeParse({ ...input, trafficSplitB: 95 })
        .success,
    ).toBe(false);
    expect(
      createPromptExperimentSchema.safeParse({ ...input, trafficSplitB: 9 })
        .success,
    ).toBe(false);
  });
});

describe('клиент A/B-экспериментов', () => {
  beforeEach(() => {
    getMock.mockReset();
    postMock.mockReset();
  });

  it('загружает эксперименты шаблона по id', async () => {
    getMock.mockResolvedValueOnce({ data: { items: [VALID_EXPERIMENT] } });

    const result = await fetchPromptExperiments('prompt/1');

    expect(getMock).toHaveBeenCalledWith(
      '/prompts/prompt%2F1/experiments',
    );
    expect(result[0]?.name).toBe('Сравнение системных промптов');
  });

  it('создаёт эксперимент и валидирует ответ', async () => {
    postMock.mockResolvedValueOnce({ data: VALID_EXPERIMENT });

    const result = await createPromptExperiment('prompt-1', {
      name: 'Тест',
      variantAVersionId: 'ver-1',
      variantBVersionId: 'ver-2',
      trafficSplitB: 50,
    });

    expect(postMock).toHaveBeenCalledWith('/prompts/prompt-1/experiments', {
      name: 'Тест',
      variantAVersionId: 'ver-1',
      variantBVersionId: 'ver-2',
      trafficSplitB: 50,
    });
    expect(result.id).toBe('exp-1');
  });

  it('останавливает эксперимент с повышением версии B', async () => {
    postMock.mockResolvedValueOnce({
      data: { id: 'exp-1', status: 'stopped', promotedVersionId: 'ver-2' },
    });

    const result = await stopPromptExperiment('exp-1', 'ver-2');

    expect(postMock).toHaveBeenCalledWith(
      '/prompts/experiments/exp-1/stop',
      { promoteVersionId: 'ver-2' },
    );
    expect(result.promotedVersionId).toBe('ver-2');
  });

  it('принимает пустой ответ остановки и остановку без повышения', async () => {
    postMock.mockResolvedValueOnce({ data: '' });
    postMock.mockResolvedValueOnce({ data: { ok: true } });

    await expect(stopPromptExperiment('exp-1')).resolves.toEqual({});
    expect(postMock).toHaveBeenLastCalledWith(
      '/prompts/experiments/exp-1/stop',
      {},
    );
    await expect(stopPromptExperiment('exp-2')).resolves.toEqual({});
  });

  it('отвергает невалидный ответ списка', async () => {
    getMock.mockResolvedValueOnce({ data: { items: [{ id: 'exp' }] } });

    await expect(fetchPromptExperiments('prompt-1')).rejects.toThrow();
  });

  it('501 считается недоступностью API пульта', () => {
    expect(getAdminErrorMessage(httpError(501), 'admin.errors.fallback')).toBe(
      'admin.errors.notAvailable',
    );
  });
});

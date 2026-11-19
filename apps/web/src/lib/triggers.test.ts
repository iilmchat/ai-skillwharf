import { AxiosError, type AxiosResponse } from 'axios';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ZodError } from 'zod';
import {
  createTrigger,
  createTriggerInputSchema,
  createdTriggerSchema,
  deleteTrigger,
  fetchTriggers,
  getTriggerErrorKind,
  getTriggerWebhookUrl,
  triggerListSchema,
  triggerSchema,
  triggersQueryKeyFor,
  type Trigger,
} from './triggers';

const { getMock, postMock, deleteMock } = vi.hoisted(() => ({
  getMock: vi.fn(),
  postMock: vi.fn(),
  deleteMock: vi.fn(),
}));

vi.mock('./api', () => ({
  api: {
    get: getMock,
    post: postMock,
    delete: deleteMock,
  },
}));

function axiosErrorWith(data: unknown, status: number): AxiosError {
  const response = {
    data,
    status,
    statusText: 'Error',
    headers: {},
    config: {},
  } as unknown as AxiosResponse;

  return new AxiosError(
    'Request failed',
    undefined,
    undefined,
    undefined,
    response,
  );
}

const TRIGGER: Trigger = {
  id: 'tr-1',
  name: 'Новая заявка из 1С',
  source: '1c',
  promptTemplate: 'Обработай новое событие из 1С: {{payload}}',
  slug: 'new-order-1c',
  triggerCount: 7,
  status: 'active',
  createdAt: '2026-11-19T10:00:00.000Z',
};

describe('triggerSchema', () => {
  it('принимает полный ответ API без изменений', () => {
    expect(triggerSchema.parse(TRIGGER)).toEqual(TRIGGER);
  });

  it('подставляет значения по умолчанию для старого API', () => {
    expect(
      triggerSchema.parse({
        id: 'tr-2',
        name: 'Свой вебхук',
        source: 'custom',
        promptTemplate: 'Проверь {{payload}}',
        slug: 'custom-hook',
      }),
    ).toEqual({
      id: 'tr-2',
      name: 'Свой вебхук',
      source: 'custom',
      promptTemplate: 'Проверь {{payload}}',
      slug: 'custom-hook',
      triggerCount: 0,
      status: 'active',
      createdAt: undefined,
    });
  });

  it('нормализует строковый счётчик и альтернативные поля', () => {
    const parsed = triggerSchema.parse({
      ...TRIGGER,
      triggerCount: '12',
      source: 'bitrix24',
    });

    expect(parsed.triggerCount).toBe(12);
    expect(
      triggerSchema.safeParse({ ...TRIGGER, triggerCount: -1 }).success,
    ).toBe(false);
    expect(
      triggerSchema.safeParse({ ...TRIGGER, source: 'unknown' }).success,
    ).toBe(false);
  });

  it('отклоняет пустые имя,slug и шаблон, а также неизвестный статус', () => {
    expect(triggerSchema.safeParse({ ...TRIGGER, name: '' }).success).toBe(
      false,
    );
    expect(triggerSchema.safeParse({ ...TRIGGER, slug: '' }).success).toBe(
      false,
    );
    expect(
      triggerSchema.safeParse({ ...TRIGGER, promptTemplate: '  ' }).success,
    ).toBe(false);
    expect(
      triggerSchema.safeParse({ ...TRIGGER, status: 'deleted' }).success,
    ).toBe(false);
  });
});

describe('triggerListSchema', () => {
  it('принимает массив и обёртку { items }', () => {
    expect(triggerListSchema.parse([TRIGGER])).toEqual([TRIGGER]);
    expect(triggerListSchema.parse({ items: [TRIGGER] })).toEqual([TRIGGER]);
    expect(triggerListSchema.safeParse({ data: [TRIGGER] }).success).toBe(false);
  });
});

describe('createTriggerInputSchema / createdTriggerSchema', () => {
  it('требует название, источник и непустой шаблон', () => {
    const input = {
      name: 'Заявка из 1С',
      source: '1c' as const,
      promptTemplate: 'Обработай {{payload}}',
    };

    expect(createTriggerInputSchema.parse(input)).toEqual(input);
    expect(
      createTriggerInputSchema.safeParse({ ...input, name: '' }).success,
    ).toBe(false);
    expect(
      createTriggerInputSchema.safeParse({ ...input, source: 'sms' }).success,
    ).toBe(false);
    expect(
      createTriggerInputSchema.safeParse({ ...input, promptTemplate: '' })
        .success,
    ).toBe(false);
  });

  it('секрет обязателен в ответе создания', () => {
    expect(
      createdTriggerSchema.safeParse({ ...TRIGGER, secret: 'shh' }).success,
    ).toBe(true);
    expect(createdTriggerSchema.safeParse(TRIGGER).success).toBe(false);
  });
});

describe('getTriggerWebhookUrl', () => {
  it('строит путь /api/v1/webhooks/triggers/:slug и кодирует slug', () => {
    expect(getTriggerWebhookUrl('new-order-1c')).toBe(
      '/api/v1/webhooks/triggers/new-order-1c',
    );
    expect(
      getTriggerWebhookUrl('a b', 'https://app.skillwharf.ru'),
    ).toBe('https://app.skillwharf.ru/api/v1/webhooks/triggers/a%20b');
  });
});

describe('triggersQueryKeyFor', () => {
  it('разделяет кэш по пользователю', () => {
    expect(triggersQueryKeyFor(null)).toEqual(['triggers', null]);
    expect(triggersQueryKeyFor('u-1')).toEqual(['triggers', 'u-1']);
  });
});

describe('trigger API', () => {
  beforeEach(() => {
    getMock.mockReset();
    postMock.mockReset();
    deleteMock.mockReset();
  });

  it('читает список через GET /triggers и валидирует ответ', async () => {
    getMock.mockResolvedValueOnce({ data: { items: [TRIGGER] } });

    await expect(fetchTriggers()).resolves.toEqual([TRIGGER]);
    expect(getMock).toHaveBeenCalledWith('/triggers');
  });

  it('не пропускает невалидный ответ списка', async () => {
    getMock.mockResolvedValueOnce({ data: [{ ...TRIGGER, id: '' }] });

    await expect(fetchTriggers()).rejects.toBeInstanceOf(ZodError);
  });

  it('создаёт триггер через POST /triggers и возвращает секрет', async () => {
    const created = { ...TRIGGER, secret: 'shh-123' };
    postMock.mockResolvedValueOnce({ data: created });

    await expect(
      createTrigger({
        name: TRIGGER.name,
        source: '1c',
        promptTemplate: TRIGGER.promptTemplate,
      }),
    ).resolves.toEqual(created);
    expect(postMock).toHaveBeenCalledWith('/triggers', {
      name: TRIGGER.name,
      source: '1c',
      promptTemplate: TRIGGER.promptTemplate,
    });
  });

  it('поддерживает ответ создания с вложенным trigger', async () => {
    postMock.mockResolvedValueOnce({
      data: { trigger: TRIGGER, secret: 'shh-456' },
    });

    await expect(
      createTrigger({
        name: TRIGGER.name,
        source: '1c',
        promptTemplate: TRIGGER.promptTemplate,
      }),
    ).resolves.toEqual({ ...TRIGGER, secret: 'shh-456' });
  });

  it('проверяет тело формы до запроса', async () => {
    await expect(
      createTrigger({
        name: '',
        source: '1c',
        promptTemplate: 'x',
      }),
    ).rejects.toBeInstanceOf(ZodError);
    expect(postMock).not.toHaveBeenCalled();
  });

  it('удаляет триггер через DELETE /triggers/:id', async () => {
    await deleteTrigger('tr-1');

    expect(deleteMock).toHaveBeenCalledWith('/triggers/tr-1');
  });
});

describe('getTriggerErrorKind', () => {
  it('распознаёт ZodError как invalidResponse', () => {
    expect(getTriggerErrorKind(new ZodError([]))).toBe('invalidResponse');
  });

  it('маппит статусы и код конфликта', () => {
    expect(getTriggerErrorKind(new AxiosError('Network'))).toBe('network');
    expect(getTriggerErrorKind(axiosErrorWith({}, 401))).toBe('sessionExpired');
    expect(getTriggerErrorKind(axiosErrorWith({}, 403))).toBe('forbidden');
    expect(getTriggerErrorKind(axiosErrorWith({}, 404))).toBe('notFound');
    expect(getTriggerErrorKind(axiosErrorWith({}, 409))).toBe('slugConflict');
    expect(getTriggerErrorKind(axiosErrorWith({}, 422))).toBe('slugConflict');
    expect(getTriggerErrorKind(axiosErrorWith({}, 503))).toBe('unavailable');
    expect(getTriggerErrorKind(axiosErrorWith({}, 400))).toBe('requestFailed');
    expect(getTriggerErrorKind(axiosErrorWith({}, 500))).toBe('unknown');
    expect(
      getTriggerErrorKind(
        axiosErrorWith({ code: 'errors.trigger_slug_exists' }, 400),
      ),
    ).toBe('slugConflict');
  });
});

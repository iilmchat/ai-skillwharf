import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ZodError } from 'zod';
import {
  fetchMemoryEntries,
  getRagMemoryErrorKind,
  memoryListSchema,
} from './rag-memory';

const { getMock } = vi.hoisted(() => ({ getMock: vi.fn() }));

vi.mock('./api', () => ({
  api: { get: getMock },
}));

const VALID_PAYLOAD = {
  items: [
    {
      id: '11111111-1111-1111-1111-111111111111',
      content: 'Клиент предпочитает самовывоз',
      createdAt: '2026-11-13T10:00:00.000Z',
    },
  ],
  total: 1,
};

describe('memoryListSchema (контракт Sprint 14)', () => {
  it('принимает корректный ответ API', () => {
    const parsed = memoryListSchema.parse(VALID_PAYLOAD);

    expect(parsed.items).toHaveLength(1);
    expect(parsed.total).toBe(1);
  });

  it('принимает ответ без необязательного total', () => {
    expect(
      memoryListSchema.parse({ items: VALID_PAYLOAD.items }).total,
    ).toBeUndefined();
  });

  it('отклоняет запись без содержания', () => {
    const result = memoryListSchema.safeParse({
      items: [{ ...VALID_PAYLOAD.items[0], content: '' }],
    });

    expect(result.success).toBe(false);
  });

  it('отклоняет запись с некорректной датой', () => {
    const result = memoryListSchema.safeParse({
      items: [{ ...VALID_PAYLOAD.items[0], createdAt: 'вчера' }],
    });

    expect(result.success).toBe(false);
  });

  it('отклоняет ответ без массива items', () => {
    expect(memoryListSchema.safeParse({ total: 0 }).success).toBe(false);
    expect(memoryListSchema.safeParse({ items: null }).success).toBe(false);
  });

  it('отклоняет отрицательный или дробный total', () => {
    expect(memoryListSchema.safeParse({ items: [], total: -1 }).success).toBe(
      false,
    );
    expect(memoryListSchema.safeParse({ items: [], total: 1.5 }).success).toBe(
      false,
    );
  });

  it('отбрасывает неизвестные поля, не ломая разбор', () => {
    const parsed = memoryListSchema.parse({
      ...VALID_PAYLOAD,
      items: [{ ...VALID_PAYLOAD.items[0], embedding: [0.1, 0.2] }],
      page: 1,
    });

    expect(parsed.items[0]).toEqual(VALID_PAYLOAD.items[0]);
  });
});

describe('fetchMemoryEntries', () => {
  beforeEach(() => {
    getMock.mockReset();
  });

  it('делает GET /chat/memory и возвращает провалидированные данные', async () => {
    getMock.mockResolvedValueOnce({ data: VALID_PAYLOAD });

    await expect(fetchMemoryEntries()).resolves.toEqual(VALID_PAYLOAD);
    expect(getMock).toHaveBeenCalledWith('/chat/memory');
  });

  it('бросает ZodError, если API нарушил контракт', async () => {
    getMock.mockResolvedValueOnce({
      data: { items: [{ id: '1', content: 'без даты' }] },
    });

    await expect(fetchMemoryEntries()).rejects.toBeInstanceOf(ZodError);
  });
});

describe('getRagMemoryErrorKind', () => {
  it('относит ZodError к невалидному ответу', () => {
    const result = memoryListSchema.safeParse({});

    expect(getRagMemoryErrorKind(result.error)).toBe('invalid');
  });

  it('различает сетевую ошибку, 401 и 404', () => {
    expect(getRagMemoryErrorKind({ isAxiosError: true })).toBe('network');
    expect(
      getRagMemoryErrorKind({
        isAxiosError: true,
        response: { status: 401 },
      }),
    ).toBe('unauthorized');
    expect(
      getRagMemoryErrorKind({
        isAxiosError: true,
        response: { status: 404 },
      }),
    ).toBe('unavailable');
  });

  it('прочие ошибки считает неизвестными', () => {
    expect(getRagMemoryErrorKind(new Error('boom'))).toBe('unknown');
    expect(
      getRagMemoryErrorKind({ isAxiosError: true, response: { status: 500 } }),
    ).toBe('unknown');
  });
});

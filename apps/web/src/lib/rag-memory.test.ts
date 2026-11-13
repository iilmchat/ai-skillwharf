import { describe, expect, it } from 'vitest';
import { getRagMemoryErrorKind, memoryListSchema } from './rag-memory';

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

describe('memoryListSchema', () => {
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
    const result = memoryListSchema.safeParse({ total: 0 });

    expect(result.success).toBe(false);
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
  });
});

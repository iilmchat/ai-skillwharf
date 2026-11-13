import { describe, expect, it } from 'vitest';
import {
  decodeLedgerCursor,
  encodeLedgerCursor,
  LEDGER_CURSOR_MAX_LENGTH,
  LedgerQuerySchema,
  type LedgerCursor,
} from './ledger-query.dto.js';

const CREATED_AT = '2026-11-13T10:00:00.000Z';
const CURSOR: LedgerCursor = {
  createdAt: CREATED_AT,
  id: '11111111-1111-1111-1111-111111111111',
};

/** Кодирует произвольный JSON как base64url — для битых курсоров в тестах. */
function encodeRaw(payload: unknown): string {
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
}

describe('LedgerQuerySchema', () => {
  it('подставляет limit=20 и offset=0 по умолчанию', () => {
    expect(LedgerQuerySchema.parse({})).toEqual({ limit: 20, offset: 0 });
  });

  it('приводит строковые limit/offset к числам', () => {
    expect(LedgerQuerySchema.parse({ limit: '5', offset: '10' })).toEqual({
      limit: 5,
      offset: 10,
    });
  });

  it('декодирует cursor в позицию и не требует offset', () => {
    const parsed = LedgerQuerySchema.parse({
      limit: '5',
      cursor: encodeLedgerCursor(CURSOR),
    });

    expect(parsed).toEqual({ limit: 5, offset: 0, cursor: CURSOR });
  });

  it.each<[string, Record<string, string>]>([
    ['limit=0', { limit: '0' }],
    ['limit=101', { limit: '101' }],
    ['limit не число', { limit: 'abc' }],
    ['дробный limit', { limit: '1.5' }],
    ['offset=-1', { offset: '-1' }],
    ['offset больше 10000', { offset: '10001' }],
    ['offset не число', { offset: 'abc' }],
    ['лишний параметр', { limit: '10', userId: CURSOR.id }],
  ])('отклоняет некорректный query: %s', (_name, query) => {
    expect(LedgerQuerySchema.safeParse(query).success).toBe(false);
  });

  it('отклоняет cursor и offset одновременно', () => {
    const result = LedgerQuerySchema.safeParse({
      cursor: encodeLedgerCursor(CURSOR),
      offset: '5',
    });

    expect(result.success).toBe(false);

    if (!result.success) {
      expect(
        result.error.issues.some((issue) =>
          issue.message.includes('cursor и offset'),
        ),
      ).toBe(true);
    }
  });

  it('не считает конфликтом cursor вместе с offset=0', () => {
    expect(
      LedgerQuerySchema.safeParse({
        cursor: encodeLedgerCursor(CURSOR),
        offset: '0',
      }).success,
    ).toBe(true);
  });

  it.each<[string, string]>([
    ['не base64url/JSON', 'не-курсор'],
    ['слишком длинный', 'A'.repeat(LEDGER_CURSOR_MAX_LENGTH + 1)],
    ['пустой', ''],
    ['нет id', encodeRaw({ createdAt: CREATED_AT })],
    ['пустой id', encodeRaw({ createdAt: CREATED_AT, id: '' })],
    ['не ISO дата', encodeRaw({ createdAt: 'вчера', id: 'entry-1' })],
    ['лишнее поле', encodeRaw({ ...CURSOR, offset: 10 })],
    ['не объект', encodeRaw([CREATED_AT, 'entry-1'])],
  ])('отклоняет битый cursor: %s', (_name, cursor) => {
    expect(LedgerQuerySchema.safeParse({ cursor }).success).toBe(false);
  });
});

describe('LedgerCursor codec', () => {
  it('кодирует и декодирует позицию без потерь', () => {
    expect(decodeLedgerCursor(encodeLedgerCursor(CURSOR))).toEqual(CURSOR);
  });

  it('возвращает null для мусора вместо исключения', () => {
    expect(decodeLedgerCursor('не-курсор')).toBeNull();
    expect(decodeLedgerCursor('')).toBeNull();
  });

  it('возвращает null для base64url с невалидным JSON', () => {
    expect(
      decodeLedgerCursor(Buffer.from('{не json', 'utf8').toString('base64url')),
    ).toBeNull();
  });
});

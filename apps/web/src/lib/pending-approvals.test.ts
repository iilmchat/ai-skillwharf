import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ZodError } from 'zod';
import {
  fetchPendingApprovals,
  getPendingTtl,
  pendingApprovalListSchema,
} from './pending-approvals';

const { getMock } = vi.hoisted(() => ({ getMock: vi.fn() }));

vi.mock('./api', () => ({
  api: { get: getMock },
}));

const ITEM = {
  conversationId: 'conv-1',
  reason: 'approval',
  tools: ['execute_sandbox_code'],
  createdAt: '2026-11-13T10:00:00.000Z',
};

function at(iso: string): number {
  return Date.parse(iso);
}

describe('pendingApprovalListSchema (контракт GET /chat/pending)', () => {
  it('принимает ответ старого API без expiresAt', () => {
    const parsed = pendingApprovalListSchema.parse({ items: [ITEM] });

    expect(parsed.items[0]?.expiresAt).toBeUndefined();
  });

  it('принимает TTL в expiresAt', () => {
    const parsed = pendingApprovalListSchema.parse({
      items: [{ ...ITEM, expiresAt: '2026-11-14T10:00:00.000Z' }],
    });

    expect(parsed.items[0]?.expiresAt).toBe('2026-11-14T10:00:00.000Z');
  });

  it('отклоняет битую дату, неизвестную причину и пустой conversationId', () => {
    expect(
      pendingApprovalListSchema.safeParse({
        items: [{ ...ITEM, expiresAt: 'вчера' }],
      }).success,
    ).toBe(false);
    expect(
      pendingApprovalListSchema.safeParse({
        items: [{ ...ITEM, reason: 'other' }],
      }).success,
    ).toBe(false);
    expect(
      pendingApprovalListSchema.safeParse({
        items: [{ ...ITEM, conversationId: '' }],
      }).success,
    ).toBe(false);
  });
});

describe('fetchPendingApprovals', () => {
  beforeEach(() => {
    getMock.mockReset();
  });

  it('запрашивает GET /chat/pending и валидирует ответ', async () => {
    getMock.mockResolvedValueOnce({ data: { items: [ITEM] } });

    await expect(fetchPendingApprovals()).resolves.toEqual({ items: [ITEM] });
    expect(getMock).toHaveBeenCalledWith('/chat/pending');
  });

  it('бросает ZodError, если ответ не соответствует контракту', async () => {
    getMock.mockResolvedValueOnce({
      data: { items: [{ ...ITEM, tools: null }] },
    });

    await expect(fetchPendingApprovals()).rejects.toBeInstanceOf(ZodError);
  });
});

describe('getPendingTtl', () => {
  const now = at('2026-11-13T11:00:00.000Z');

  it('без expiresAt таймера нет', () => {
    expect(getPendingTtl(undefined, now)).toBeNull();
  });

  it('некорректную дату игнорирует', () => {
    expect(getPendingTtl('вчера', now)).toBeNull();
  });

  it('показывает полные часы до истечения', () => {
    expect(getPendingTtl('2026-11-14T10:00:00.000Z', now)).toEqual({
      kind: 'hours',
      value: 23,
    });
    expect(getPendingTtl('2026-11-13T12:30:00.000Z', now)).toEqual({
      kind: 'hours',
      value: 1,
    });
  });

  it('меньше часа — минуты, минимум одна', () => {
    expect(getPendingTtl('2026-11-13T11:30:00.000Z', now)).toEqual({
      kind: 'minutes',
      value: 30,
    });
    expect(getPendingTtl('2026-11-13T11:00:30.000Z', now)).toEqual({
      kind: 'minutes',
      value: 1,
    });
  });

  it('истёкшее ожидание помечает expired', () => {
    expect(getPendingTtl('2026-11-13T10:59:00.000Z', now)).toEqual({
      kind: 'expired',
    });
    expect(getPendingTtl('2026-11-13T11:00:00.000Z', now)).toEqual({
      kind: 'expired',
    });
  });
});

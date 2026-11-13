import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ZodError } from 'zod';
import {
  collectLedgerEntries,
  fetchLedgerPage,
  ledgerPageSchema,
  type LedgerPage,
} from './ledger';

const { getMock } = vi.hoisted(() => ({ getMock: vi.fn() }));

vi.mock('./api', () => ({
  api: { get: getMock },
}));

const ENTRY = {
  id: 'entry-1',
  amount: '100.00',
  balanceAfter: '100.00',
  type: 'credit',
  description: 'Пополнение',
  createdAt: '2026-11-13T10:00:00.000Z',
};

const PAGE: LedgerPage = {
  items: [ENTRY],
  total: 2,
  nextCursor: 'cursor-2',
};

describe('ledgerPageSchema (контракт keyset-пагинации)', () => {
  it('принимает страницу с курсором и без него', () => {
    expect(ledgerPageSchema.parse(PAGE).nextCursor).toBe('cursor-2');
    expect(
      ledgerPageSchema.parse({ ...PAGE, nextCursor: null }).nextCursor,
    ).toBeNull();
  });

  it('отклоняет записи с отрицательным total и битой датой', () => {
    expect(ledgerPageSchema.safeParse({ ...PAGE, total: -1 }).success).toBe(
      false,
    );
    expect(
      ledgerPageSchema.safeParse({
        ...PAGE,
        items: [{ ...ENTRY, createdAt: 'вчера' }],
      }).success,
    ).toBe(false);
  });

  it('отклоняет пустой nextCursor и отсутствие поля', () => {
    expect(
      ledgerPageSchema.safeParse({ ...PAGE, nextCursor: '' }).success,
    ).toBe(false);
    expect(ledgerPageSchema.safeParse({ items: [], total: 0 }).success).toBe(
      false,
    );
  });
});

describe('collectLedgerEntries', () => {
  it('склеивает страницы по порядку', () => {
    const secondEntry = { ...ENTRY, id: 'entry-2' };
    const pages: LedgerPage[] = [
      { items: [ENTRY], total: 2, nextCursor: 'cursor-2' },
      { items: [secondEntry], total: 2, nextCursor: null },
    ];

    expect(collectLedgerEntries(pages).map((entry) => entry.id)).toEqual([
      'entry-1',
      'entry-2',
    ]);
  });

  it('не дублирует запись при повторно загруженной странице', () => {
    const pages: LedgerPage[] = [
      PAGE,
      {
        items: [{ ...ENTRY, id: 'entry-2' }, ENTRY],
        total: 2,
        nextCursor: null,
      },
    ];

    expect(collectLedgerEntries(pages).map((entry) => entry.id)).toEqual([
      'entry-1',
      'entry-2',
    ]);
  });
});

describe('fetchLedgerPage', () => {
  beforeEach(() => {
    getMock.mockReset();
  });

  it('запрашивает первую страницу без курсора', async () => {
    getMock.mockResolvedValueOnce({ data: PAGE });

    await expect(fetchLedgerPage(null)).resolves.toEqual(PAGE);
    expect(getMock).toHaveBeenCalledWith('/billing/ledger', {
      params: undefined,
    });
  });

  it('передаёт opaque-курсор следующей страницы', async () => {
    getMock.mockResolvedValueOnce({ data: { ...PAGE, nextCursor: null } });

    await fetchLedgerPage('cursor-2');
    expect(getMock).toHaveBeenCalledWith('/billing/ledger', {
      params: { cursor: 'cursor-2' },
    });
  });

  it('бросает ZodError, если API нарушил контракт', async () => {
    getMock.mockResolvedValueOnce({ data: { items: [ENTRY], total: 2 } });

    await expect(fetchLedgerPage(null)).rejects.toBeInstanceOf(ZodError);
  });
});

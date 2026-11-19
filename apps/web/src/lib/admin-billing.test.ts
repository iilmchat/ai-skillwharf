import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ZodError } from 'zod';
import {
  billingOutboxItemSchema,
  fetchBillingReconciliation,
  fetchTreasurySummary,
  reconciliationReportSchema,
  retryOutboxItem,
  treasurySummarySchema,
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
    t: (key: string) => `перевод:${key}`,
    exists: (key: string) => key.startsWith('errors.'),
  },
}));

const OUTBOX_ITEM = {
  id: 'outbox-1',
  eventType: 'revenue_share',
  idempotencyKey: 'payperoutcome:order-1:author-1',
  status: 'failed_dead',
  attempts: 5,
  maxAttempts: 5,
  lastError: 'ЮKassa: 502',
  createdAt: '2026-11-19T10:00:00.000Z',
  sentAt: null,
};

const TREASURY = {
  treasuryBalanceRub: '1234.56',
  counts: { pending: 2, sent: 10, failed_dead: 1 },
  recentOutbox: [OUTBOX_ITEM],
};

const RECONCILIATION = {
  balanced: true,
  discrepancyRub: 0,
  ledgerNetRub: '5000.00',
  walletsTotalRub: 5000,
};

describe('billingOutboxItemSchema', () => {
  it('принимает полную запись Outbox', () => {
    expect(billingOutboxItemSchema.parse(OUTBOX_ITEM)).toEqual(OUTBOX_ITEM);
  });

  it('поддерживает необязательные lastError и sentAt', () => {
    expect(
      billingOutboxItemSchema.parse({
        ...OUTBOX_ITEM,
        status: 'sent',
        lastError: undefined,
        sentAt: '2026-11-19T10:05:00.000Z',
      }),
    ).toMatchObject({ status: 'sent', sentAt: '2026-11-19T10:05:00.000Z' });
  });

  it('отклоняет неизвестный статус и отрицательные попытки', () => {
    expect(
      billingOutboxItemSchema.safeParse({ ...OUTBOX_ITEM, status: 'failed' })
        .success,
    ).toBe(false);
    expect(
      billingOutboxItemSchema.safeParse({ ...OUTBOX_ITEM, attempts: -1 })
        .success,
    ).toBe(false);
    expect(
      billingOutboxItemSchema.safeParse({ ...OUTBOX_ITEM, maxAttempts: 0 })
        .success,
    ).toBe(false);
  });
});

describe('treasurySummarySchema', () => {
  it('приводит Decimal-строку баланса к числу', () => {
    const parsed = treasurySummarySchema.parse(TREASURY);

    expect(parsed.treasuryBalanceRub).toBe(1234.56);
    expect(parsed.counts).toEqual({ pending: 2, sent: 10, failed_dead: 1 });
    expect(parsed.recentOutbox).toEqual([OUTBOX_ITEM]);
  });

  it('принимает число и алиас failedDead', () => {
    const parsed = treasurySummarySchema.parse({
      treasuryBalanceRub: 100,
      counts: { pending: 0, sent: 0, failedDead: 3 },
      recentOutbox: [],
    });

    expect(parsed.treasuryBalanceRub).toBe(100);
    expect(parsed.counts.failed_dead).toBe(3);
  });

  it('принимает форму ответа бэкенда { balance, outbox, recent }', () => {
    const parsed = treasurySummarySchema.parse({
      balance: { balance: '99.90', heldBalance: '0.00' },
      outbox: { pending: 1, sent: 2, failedDead: 3 },
      recent: [
        {
          id: 'outbox-2',
          eventType: 'yookassa_author_transfer',
          status: 'pending',
          attempts: 0,
          maxAttempts: 5,
          nextRetryAt: '2026-11-19T11:00:00.000Z',
          lastError: null,
          createdAt: '2026-11-19T10:00:00.000Z',
          sentAt: null,
        },
      ],
    });

    expect(parsed.treasuryBalanceRub).toBe(99.9);
    expect(parsed.heldBalanceRub).toBe(0);
    expect(parsed.counts.failed_dead).toBe(3);
    expect(parsed.recentOutbox[0]?.idempotencyKey).toBeUndefined();
  });

  it('отклоняет нечисловой баланс и неверную структуру счётчиков', () => {
    expect(
      treasurySummarySchema.safeParse({
        ...TREASURY,
        treasuryBalanceRub: 'много',
      }).success,
    ).toBe(false);
    expect(
      treasurySummarySchema.safeParse({
        ...TREASURY,
        counts: { pending: -1, sent: 0, failed_dead: 0 },
      }).success,
    ).toBe(false);
    expect(
      treasurySummarySchema.safeParse({ ...TREASURY, recentOutbox: 'нет' })
        .success,
    ).toBe(false);
  });
});

describe('reconciliationReportSchema', () => {
  it('приводит строковое расхождение к числу', () => {
    const parsed = reconciliationReportSchema.parse({
      balanced: false,
      discrepancyRub: '-12.50',
    });

    expect(parsed).toEqual({
      balanced: false,
      discrepancyRub: -12.5,
      ledgerNetRub: undefined,
      walletsTotalRub: undefined,
    });
  });

  it('понимает поля бэкенда ledgerRub и walletsRub', () => {
    expect(
      reconciliationReportSchema.parse({
        ledgerRub: '5000.00',
        walletsRub: '4999.50',
        balanced: false,
        discrepancyRub: '0.50',
      }),
    ).toEqual({
      balanced: false,
      discrepancyRub: 0.5,
      ledgerNetRub: 5000,
      walletsTotalRub: 4999.5,
    });
  });

  it('принимает полный отчёт и отклоняет неверный тип balanced', () => {
    expect(reconciliationReportSchema.parse(RECONCILIATION)).toEqual({
      balanced: true,
      discrepancyRub: 0,
      ledgerNetRub: 5000,
      walletsTotalRub: 5000,
    });
    expect(
      reconciliationReportSchema.safeParse({
        balanced: 'true',
        discrepancyRub: 0,
      }).success,
    ).toBe(false);
  });
});

describe('billing API', () => {
  beforeEach(() => {
    getMock.mockReset();
    postMock.mockReset();
  });

  it('загружает сводку кошелька через GET /admin/billing/treasury', async () => {
    getMock.mockResolvedValueOnce({ data: TREASURY });

    await expect(fetchTreasurySummary()).resolves.toEqual({
      treasuryBalanceRub: 1234.56,
      counts: TREASURY.counts,
      recentOutbox: [OUTBOX_ITEM],
    });
    expect(getMock).toHaveBeenCalledWith('/admin/billing/treasury');
  });

  it('отклоняет невалидную сводку кошелька', async () => {
    getMock.mockResolvedValueOnce({
      data: { ...TREASURY, recentOutbox: [{ id: '' }] },
    });

    await expect(fetchTreasurySummary()).rejects.toBeInstanceOf(ZodError);
  });

  it('загружает отчёт сверки через GET /admin/billing/reconciliation', async () => {
    getMock.mockResolvedValueOnce({ data: RECONCILIATION });

    await expect(fetchBillingReconciliation()).resolves.toEqual({
      balanced: true,
      discrepancyRub: 0,
      ledgerNetRub: 5000,
      walletsTotalRub: 5000,
    });
    expect(getMock).toHaveBeenCalledWith('/admin/billing/reconciliation');
  });

  it('отклоняет невалидный отчёт сверки', async () => {
    getMock.mockResolvedValueOnce({ data: { balanced: true } });

    await expect(fetchBillingReconciliation()).rejects.toBeInstanceOf(ZodError);
  });

  it('перезапускает выплату через POST .../retry и разбирает обновлённую запись', async () => {
    postMock.mockResolvedValueOnce({
      data: { ...OUTBOX_ITEM, status: 'processing' },
    });

    await expect(retryOutboxItem('outbox-1')).resolves.toMatchObject({
      status: 'processing',
    });
    expect(postMock).toHaveBeenCalledWith(
      '/admin/billing/outbox/outbox-1/retry',
    );
  });

  it('разбирает подтверждение бэкенда { retried: true, id }', async () => {
    postMock.mockResolvedValueOnce({ data: { retried: true, id: 'outbox-1' } });

    await expect(retryOutboxItem('outbox-1')).resolves.toEqual({
      retried: true,
      id: 'outbox-1',
    });
  });

  it('кодирует id и принимает пустой ответ 204', async () => {
    postMock.mockResolvedValueOnce({ data: undefined });

    await expect(retryOutboxItem('id with space')).resolves.toBeNull();
    expect(postMock).toHaveBeenCalledWith(
      '/admin/billing/outbox/id%20with%20space/retry',
    );
  });

  it('поддерживает ответ с вложенной записью item', async () => {
    postMock.mockResolvedValueOnce({ data: { item: OUTBOX_ITEM } });

    await expect(retryOutboxItem('outbox-1')).resolves.toEqual(OUTBOX_ITEM);
  });
});

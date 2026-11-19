import { describe, expect, it, vi } from 'vitest';
import type { PrismaService } from '../prisma/prisma.service.js';
import {
  backoffMs,
  BillingOutboxService,
} from './billing-outbox.service.js';
import type { YooKassaProvider } from './providers/yookassa.provider.js';

const PAYLOAD = {
  payoutAccountId: 'yoo-account-1',
  amountRub: 85,
  skillName: 'seo-audit',
};

function harness(options: {
  attempts?: number;
  maxAttempts?: number;
  transferError?: Error;
  status?: string;
} = {}) {
  const row = {
    id: 'outbox-1',
    eventType: 'yookassa_author_transfer',
    idempotencyKey: 'revenue-share:charge-1',
    payloadJson: PAYLOAD,
    status: options.status ?? 'pending',
    attempts: options.attempts ?? 0,
    maxAttempts: options.maxAttempts ?? 5,
    nextRetryAt: new Date(Date.now() - 1_000),
    lastError: null,
    createdAt: new Date(),
    sentAt: null,
  };
  const prisma = {
    billingOutbox: {
      findMany: vi.fn(async () => [row]),
      updateMany: vi.fn(async () => ({ count: 1 })),
      update: vi.fn(async ({ data }: { data: Record<string, unknown> }) => ({
        ...row,
        ...data,
      })),
      findUnique: vi.fn(async () => row),
      count: vi.fn(async () => 1),
    },
  };
  const yookassa = {
    createTransfer: options.transferError
      ? vi.fn(async () => {
          throw options.transferError;
        })
      : vi.fn(async () => 'transfer-1'),
  };

  return {
    service: new BillingOutboxService(
      prisma as unknown as PrismaService,
      yookassa as unknown as YooKassaProvider,
      { BILLING_OUTBOX_POLL_MS: '0' },
    ),
    prisma,
    yookassa,
    row,
  };
}

describe('BillingOutboxService (OUTBOX-33.1)', () => {
  it('отправляет перевод и помечает задачу sent', async () => {
    const { service, prisma, yookassa } = harness();
    const result = await service.processPendingBatch();

    expect(result).toEqual({ processed: 1, sent: 1, retried: 0, dead: 0 });
    expect(yookassa.createTransfer).toHaveBeenCalledWith(
      'yoo-account-1',
      85,
      'revenue-share:charge-1',
      'seo-audit',
    );
    expect(prisma.billingOutbox.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: 'sent' }),
      }),
    );
    service.onModuleDestroy();
  });

  it('ошибка → pending с экспоненциальным backoff (2^attempts * 30s)', async () => {
    const { service, prisma } = harness({ transferError: new Error('HTTP 503') });

    await service.processPendingBatch();

    expect(backoffMs(1)).toBe(60_000);
    expect(backoffMs(2)).toBe(120_000);
    expect(prisma.billingOutbox.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: 'pending',
          attempts: 1,
          lastError: 'HTTP 503',
        }),
      }),
    );
    service.onModuleDestroy();
  });

  it('после maxAttempts задача уходит в failed_dead', async () => {
    const { service, prisma } = harness({
      attempts: 4,
      maxAttempts: 5,
      transferError: new Error('permanent'),
    });

    const result = await service.processPendingBatch();

    expect(result.dead).toBe(1);
    expect(prisma.billingOutbox.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: 'failed_dead', attempts: 5 }),
      }),
    );
    service.onModuleDestroy();
  });

  it('retryDeadLetter сбрасывает откаты и переводит в pending', async () => {
    const { service, prisma } = harness({ status: 'failed_dead' });

    await service.retryDeadLetter('outbox-1');

    expect(prisma.billingOutbox.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: 'pending',
          attempts: 0,
          lastError: null,
        }),
      }),
    );
    service.onModuleDestroy();
  });

  it('Zod отклоняет невалидный payload выплаты', async () => {
    const { service, prisma, yookassa } = harness();
    const broken = {
      id: 'outbox-bad',
      idempotencyKey: 'revenue-share:bad',
      payloadJson: { payoutAccountId: '' },
      status: 'pending',
      attempts: 0,
      maxAttempts: 5,
      nextRetryAt: new Date(Date.now() - 1_000),
    };

    prisma.billingOutbox.findMany.mockResolvedValueOnce([broken] as never);

    const result = await service.processPendingBatch();

    expect(result.sent).toBe(0);
    expect(yookassa.createTransfer).not.toHaveBeenCalled();
    service.onModuleDestroy();
  });
});

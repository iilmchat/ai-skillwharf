import { describe, expect, it, vi } from 'vitest';
import type { PrismaService } from '../prisma/prisma.service.js';
import { BillingOutboxService } from './billing-outbox.service.js';
import type { IOutboxLock } from './outbox-lock.js';
import type { YooKassaProvider } from './providers/yookassa.provider.js';

/** Общий mock Redis-lock для симуляции трёх реплик API. */
class SharedRedisLock implements IOutboxLock {
  private held = false;
  readonly ownerToken = 'owner';

  async acquire(): Promise<boolean> {
    if (this.held) {
      return false;
    }

    this.held = true;

    return true;
  }

  async release(): Promise<void> {
    this.held = false;
  }
}

describe('Распределённая блокировка Outbox (HA-34.2)', () => {
  it('3 параллельные реплики отправляют каждый перевод ровно 1 раз', async () => {
    const task = {
      id: 'outbox-1',
      idempotencyKey: 'revenue-share:charge-1',
      payloadJson: {
        payoutAccountId: 'yoo-account',
        amountRub: 85,
        skillName: 'seo-audit',
      },
      status: 'pending',
      attempts: 0,
      maxAttempts: 5,
      nextRetryAt: new Date(Date.now() - 1_000),
    };
    const prisma = {
      billingOutbox: {
        findMany: vi.fn(async () => [task]),
        updateMany: vi.fn(async () => ({ count: 1 })),
        update: vi.fn(async ({ data }: { data: Record<string, unknown> }) => ({
          ...task,
          ...data,
        })),
      },
    };
    const transfer = vi.fn(async () => 'transfer-1');
    const lock = new SharedRedisLock();
    const replicas = Array.from(
      { length: 3 },
      () =>
        new BillingOutboxService(
          prisma as unknown as PrismaService,
          { createTransfer: transfer } as unknown as YooKassaProvider,
          { BILLING_OUTBOX_POLL_MS: '0' },
          lock,
        ),
    );

    const results = await Promise.all(
      replicas.map((replica) => replica.processPendingBatch()),
    );

    expect(results.filter((result) => result.sent === 1)).toHaveLength(1);
    expect(results.filter((result) => result.processed === 0)).toHaveLength(2);
    expect(transfer).toHaveBeenCalledTimes(1);
    replicas.forEach((replica) => replica.onModuleDestroy());
  });

  it('без Redis-блокировки (Noop) работает локальный воркер', async () => {
    const prisma = {
      billingOutbox: {
        findMany: vi.fn(async () => []),
        updateMany: vi.fn(),
        update: vi.fn(),
      },
    };
    const service = new BillingOutboxService(
      prisma as unknown as PrismaService,
      { createTransfer: vi.fn() } as unknown as YooKassaProvider,
      { BILLING_OUTBOX_POLL_MS: '0', REDIS_URL: '' },
    );

    await expect(service.processPendingBatch()).resolves.toEqual({
      processed: 0,
      sent: 0,
      retried: 0,
      dead: 0,
    });
    expect(prisma.billingOutbox.findMany).toHaveBeenCalledTimes(1);
    service.onModuleDestroy();
  });
});

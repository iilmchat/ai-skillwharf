import { BadRequestException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { describe, expect, it, vi } from 'vitest';
import { BillingService, splitRevenueShare } from './billing.service.js';
import { PrismaService } from '../prisma/prisma.service.js';

const BUYER = 'buyer-1';
const AUTHOR = 'author-1';

describe('splitRevenueShare: точный сплит 85/15 без потери копеек', () => {
  it.each([
    [100, 85, 15],
    [5, 4.25, 0.75],
    [5.55, 4.72, 0.83],
    [0.03, 0.03, 0],
    [0.01, 0.01, 0],
    // 10.1 * 0.85 даёт 8.584999… → по формуле Math.round(...*100)/100 = 8.58.
    [10.1, 8.58, 1.52],
  ])('цена %s → автор %s, платформа %s', (price, author, platform) => {
    const result = splitRevenueShare(price);

    expect(result.author).toBe(author);
    expect(result.platform).toBe(platform);
    expect(Math.round((result.author + result.platform) * 100)).toBe(
      Math.round(price * 100),
    );
  });

  it('отвергает отрицательную цену', () => {
    expect(() => splitRevenueShare(-1)).toThrow(BadRequestException);
  });
});

describe('BillingService.chargeForMarketplaceSkill', () => {
  function harness() {
    const tx = {
      wallet: {
        updateMany: vi.fn(async () => ({ count: 1 })),
        findUniqueOrThrow: vi.fn(async () => ({
          id: 'wallet-buyer',
          balance: new Prisma.Decimal('95.00'),
        })),
        upsert: vi.fn(async () => ({
          id: 'wallet-author',
          balance: new Prisma.Decimal('85.00'),
        })),
      },
      ledgerEntry: {
        create: vi.fn(async ({ data }: { data: { idempotencyKey: string } }) => ({
          id: `entry-${data.idempotencyKey}`,
        })),
      },
      user: {
        upsert: vi.fn(async () => ({ id: 'treasury-user' })),
      },
      billingOutbox: {
        create: vi.fn(async () => ({ id: 'outbox-1' })),
      },
    };
    const prisma = {
      ledgerEntry: { findUnique: vi.fn(async () => null) },
      $transaction: vi.fn(async (cb: (client: unknown) => Promise<unknown>) => cb(tx)),
    };

    return {
      service: new BillingService(prisma as unknown as PrismaService),
      tx,
      prisma,
    };
  }

  it('пишет debit, author_revenue_share и platform_fee в одной транзакции', async () => {
    const { service, tx, prisma } = harness();

    const result = await service.chargeForMarketplaceSkill({
      userId: BUYER,
      authorId: AUTHOR,
      skillName: 'seo-audit',
      price: 5.55,
      idempotencyKey: 'charge-1',
    });

    expect(result.total).toBe('5.55');
    expect(result.authorAmount).toBe('4.72');
    expect(result.platformAmount).toBe('0.83');
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(tx.ledgerEntry.create).toHaveBeenCalledTimes(3);

    const types = tx.ledgerEntry.create.mock.calls.map(
      (call: [{ data: { type: string } }]) => call[0].data.type,
    );

    expect(types).toEqual(['debit', 'author_revenue_share', 'platform_fee']);
    expect(tx.wallet.updateMany).toHaveBeenCalledWith({
      where: { userId: BUYER, balance: { gte: new Prisma.Decimal('5.55') } },
      data: { balance: { decrement: new Prisma.Decimal('5.55') } },
    });
    expect(tx.wallet.upsert).toHaveBeenCalledWith(
      expect.objectContaining({ where: { userId: AUTHOR } }),
    );
  });

  it('в одной транзакции создаёт Outbox и зачисляет 15% на Platform Treasury', async () => {
    const { service, tx, prisma } = harness();

    await service.chargeForMarketplaceSkill({
      userId: BUYER,
      authorId: AUTHOR,
      skillName: 'seo-audit',
      price: 100,
      idempotencyKey: 'charge-outbox',
      payoutAccountId: 'yoo-account-1',
    });

    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(tx.user.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { email: 'treasury@system.skillwharf.local' },
      }),
    );
    expect(tx.billingOutbox.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          idempotencyKey: 'revenue-share:charge-outbox',
          status: 'pending',
          eventType: 'yookassa_author_transfer',
        }),
      }),
    );
    const platformEntry = tx.ledgerEntry.create.mock.calls
      .map((call: [{ data: { type: string; walletId: string; amount: Prisma.Decimal } }]) => call[0].data)
      .find((entry) => entry.type === 'platform_fee');

    expect(platformEntry).toMatchObject({
      walletId: 'wallet-author',
      amount: new Prisma.Decimal('15.00'),
    });
  });

  it('без payoutAccountId не создаёт Outbox', async () => {
    const { service, tx } = harness();

    await service.chargeForMarketplaceSkill({
      userId: BUYER,
      authorId: AUTHOR,
      skillName: 'seo-audit',
      price: 100,
      idempotencyKey: 'charge-no-payout',
    });

    expect(tx.billingOutbox.create).not.toHaveBeenCalled();
  });

  it('запрещает автору покупать собственный навык', async () => {
    const { service, prisma } = harness();

    await expect(
      service.chargeForMarketplaceSkill({
        userId: BUYER,
        authorId: BUYER,
        skillName: 'seo-audit',
        price: 5,
        idempotencyKey: 'self',
      }),
    ).rejects.toThrow(BadRequestException);
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('не списывает при недостаточных средствах', async () => {
    const { service, tx } = harness();
    tx.wallet.updateMany.mockResolvedValueOnce({ count: 0 });

    await expect(
      service.chargeForMarketplaceSkill({
        userId: BUYER,
        authorId: AUTHOR,
        skillName: 'seo-audit',
        price: 5,
        idempotencyKey: 'poor',
      }),
    ).rejects.toThrow(BadRequestException);
    expect(tx.ledgerEntry.create).not.toHaveBeenCalled();
  });
});

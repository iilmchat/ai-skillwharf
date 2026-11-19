import { Prisma } from '@prisma/client';
import { describe, expect, it, vi } from 'vitest';
import { BillingService } from './billing.service.js';
import type { PrismaService } from '../prisma/prisma.service.js';

function harness(input: {
  credit: string;
  debit: string;
  balance: string;
  held: string;
}) {
  const prisma = {
    ledgerEntry: {
      aggregate: vi.fn(async ({ where }: { where?: { type?: string } } = {}) => ({
        _sum: {
          amount: new Prisma.Decimal(
            where?.type === 'credit' ? input.credit : input.debit,
          ),
        },
      })),
    },
    wallet: {
      aggregate: vi.fn(async () => ({
        _sum: {
          balance: new Prisma.Decimal(input.balance),
          heldBalance: new Prisma.Decimal(input.held),
        },
      })),
      upsert: vi.fn(async () => ({
        id: 'treasury-wallet',
        balance: new Prisma.Decimal(input.balance),
        heldBalance: new Prisma.Decimal(input.held),
      })),
    },
    user: {
      upsert: vi.fn(async () => ({ id: 'treasury-user' })),
    },
  };

  return { service: new BillingService(prisma as unknown as PrismaService), prisma };
}

describe('Сверка биллинга (TREASURY-33.2)', () => {
  it('сбалансированный Ledger и кошельки', async () => {
    const { service } = harness({
      credit: '200.00',
      debit: '120.00',
      balance: '75.00',
      held: '5.00',
    });

    await expect(service.reconciliation()).resolves.toEqual({
      ledgerRub: '80.00',
      walletsRub: '80.00',
      balanced: true,
      discrepancyRub: '0.00',
    });
  });

  it('расхождение показывает signed discrepancy', async () => {
    const { service } = harness({
      credit: '100.00',
      debit: '40.00',
      balance: '55.00',
      held: '0.00',
    });

    await expect(service.reconciliation()).resolves.toEqual({
      ledgerRub: '60.00',
      walletsRub: '55.00',
      balanced: false,
      discrepancyRub: '5.00',
    });
  });

  it('treasuryBalance лениво создаёт системного пользователя', async () => {
    const { service, prisma } = harness({
      credit: '0',
      debit: '0',
      balance: '15.00',
      held: '0.00',
    });

    await expect(service.treasuryBalance()).resolves.toEqual({
      balance: '15.00',
      heldBalance: '0.00',
    });
    expect(prisma.user.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { email: 'treasury@system.skillwharf.local' },
      }),
    );
  });
});

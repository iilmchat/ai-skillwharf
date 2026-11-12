import { BadRequestException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { Test, TestingModule } from '@nestjs/testing';
import { PrismaService } from '../prisma/prisma.service.js';
import { BillingService } from './billing.service.js';

type MockFn = ReturnType<typeof vi.fn>;

interface TxMock {
  wallet: { upsert: MockFn };
  ledgerEntry: { create: MockFn };
}

interface PrismaMock {
  wallet: { upsert: MockFn };
  $transaction: MockFn;
}

describe('BillingService', () => {
  let service: BillingService;
  let prisma: PrismaMock;

  beforeEach(async () => {
    prisma = {
      wallet: { upsert: vi.fn() },
      $transaction: vi.fn(),
    };

    const moduleRef: TestingModule = await Test.createTestingModule({
      providers: [
        BillingService,
        { provide: PrismaService, useValue: prisma },
      ],
    }).compile();

    service = moduleRef.get(BillingService);
  });

  describe('getBalance', () => {
    it('возвращает баланс существующего кошелька', async () => {
      prisma.wallet.upsert.mockResolvedValue({
        id: 'wallet-1',
        balance: new Prisma.Decimal('125.5'),
      });

      await expect(service.getBalance('user-1')).resolves.toEqual({
        balance: '125.50',
      });
      expect(prisma.wallet.upsert).toHaveBeenCalledWith({
        where: { userId: 'user-1' },
        create: { userId: 'user-1' },
        update: {},
      });
    });

    it('создаёт кошелёк с нулевым балансом, если его нет', async () => {
      prisma.wallet.upsert.mockResolvedValue({
        id: 'wallet-1',
        balance: new Prisma.Decimal(0),
      });

      await expect(service.getBalance('new-user')).resolves.toEqual({
        balance: '0.00',
      });
    });
  });

  describe('addFunds', () => {
    it('атомарно начисляет средства и пишет credit в ledger', async () => {
      const tx: TxMock = {
        wallet: {
          upsert: vi.fn().mockResolvedValue({
            id: 'wallet-1',
            balance: new Prisma.Decimal('150.25'),
          }),
        },
        ledgerEntry: {
          create: vi.fn().mockResolvedValue({ id: 'entry-1' }),
        },
      };
      prisma.$transaction.mockImplementation(
        async (callback: (client: TxMock) => unknown) => callback(tx),
      );

      const result = await service.addFunds(
        'user-1',
        100,
        'Тестовое пополнение',
      );

      expect(result).toEqual({ balance: '150.25', entryId: 'entry-1' });
      expect(prisma.$transaction).toHaveBeenCalledTimes(1);
      expect(tx.wallet.upsert).toHaveBeenCalledWith({
        where: { userId: 'user-1' },
        create: {
          userId: 'user-1',
          balance: expect.any(Prisma.Decimal) as Prisma.Decimal,
        },
        update: {
          balance: {
            increment: expect.any(Prisma.Decimal) as Prisma.Decimal,
          },
        },
      });
      expect(tx.ledgerEntry.create).toHaveBeenCalledTimes(1);

      const [entryArgs] = tx.ledgerEntry.create.mock.calls[0] as [
        {
          data: {
            walletId: string;
            amount: Prisma.Decimal;
            type: string;
            description: string;
          };
        },
      ];
      expect(entryArgs.data.walletId).toBe('wallet-1');
      expect(entryArgs.data.type).toBe('credit');
      expect(entryArgs.data.description).toBe('Тестовое пополнение');
      expect(entryArgs.data.amount.toFixed(2)).toBe('100.00');
    });

    it.each([0, -10, Number.NaN])(
      'отклоняет некорректную сумму (%s)',
      async (amount) => {
        await expect(
          service.addFunds('user-1', amount, 'Пополнение'),
        ).rejects.toBeInstanceOf(BadRequestException);
        expect(prisma.$transaction).not.toHaveBeenCalled();
      },
    );
  });
});

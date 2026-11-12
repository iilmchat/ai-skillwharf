import { BadRequestException, ConflictException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { Test, TestingModule } from '@nestjs/testing';
import { PrismaService } from '../prisma/prisma.service.js';
import { ERROR_KEYS } from '../i18n/error-keys.js';
import { BillingService } from './billing.service.js';

type MockFn = ReturnType<typeof vi.fn>;

interface TxMock {
  wallet: {
    upsert: MockFn;
    updateMany: MockFn;
    findUniqueOrThrow: MockFn;
    update: MockFn;
  };
  ledgerEntry: { create: MockFn };
}

interface PrismaMock {
  wallet: { upsert: MockFn };
  ledgerEntry: { findUnique: MockFn };
  $transaction: MockFn;
}

const USER_ID = '11111111-1111-1111-1111-111111111111';

function createTx(): TxMock {
  return {
    wallet: {
      upsert: vi.fn(),
      updateMany: vi.fn(),
      findUniqueOrThrow: vi.fn(),
      update: vi.fn(),
    },
    ledgerEntry: { create: vi.fn() },
  };
}

function asTransactionCallback(
  callback: (client: unknown) => unknown,
  tx: TxMock,
): unknown {
  return callback(tx);
}

describe('BillingService', () => {
  let service: BillingService;
  let prisma: PrismaMock;

  beforeEach(async () => {
    prisma = {
      wallet: { upsert: vi.fn() },
      ledgerEntry: { findUnique: vi.fn() },
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

  function useTx(tx: TxMock): void {
    prisma.$transaction.mockImplementation((callback: (client: unknown) => unknown) =>
      asTransactionCallback(callback, tx),
    );
  }

  describe('getBalance', () => {
    it('возвращает баланс существующего кошелька', async () => {
      prisma.wallet.upsert.mockResolvedValue({
        id: 'wallet-1',
        balance: new Prisma.Decimal('125.5'),
      });

      await expect(service.getBalance(USER_ID)).resolves.toEqual({
        balance: '125.50',
      });
      expect(prisma.wallet.upsert).toHaveBeenCalledWith({
        where: { userId: USER_ID },
        create: { userId: USER_ID },
        update: {},
      });
    });

    it('создаёт кошелёк с нулевым балансом, если его нет', async () => {
      prisma.wallet.upsert.mockResolvedValue({
        id: 'wallet-1',
        balance: new Prisma.Decimal(0),
      });

      await expect(service.getBalance(USER_ID)).resolves.toEqual({
        balance: '0.00',
      });
    });
  });

  describe('addFunds', () => {
    it('атомарно начисляет средства и пишет credit с balanceAfter', async () => {
      const tx = createTx();
      tx.wallet.upsert.mockResolvedValue({
        id: 'wallet-1',
        balance: new Prisma.Decimal('150.25'),
      });
      tx.ledgerEntry.create.mockResolvedValue({ id: 'entry-1' });
      prisma.ledgerEntry.findUnique.mockResolvedValue(null);
      useTx(tx);

      const result = await service.addFunds(
        USER_ID,
        100.5,
        'Тестовое пополнение',
        'topup-key-1',
      );

      expect(result).toEqual({ balance: '150.25', entryId: 'entry-1' });
      expect(prisma.$transaction).toHaveBeenCalledTimes(1);

      const [createArgs] = tx.ledgerEntry.create.mock.calls[0] as [
        {
          data: {
            walletId: string;
            amount: Prisma.Decimal;
            balanceAfter: Prisma.Decimal;
            type: string;
            description: string;
            idempotencyKey: string;
          };
        },
      ];
      expect(createArgs.data).toMatchObject({
        walletId: 'wallet-1',
        type: 'credit',
        description: 'Тестовое пополнение',
        idempotencyKey: 'topup-key-1',
      });
      expect(createArgs.data.amount.toFixed(2)).toBe('100.50');
      expect(createArgs.data.balanceAfter.toFixed(2)).toBe('150.25');
    });

    it('не создаёт дубль при повторном idempotencyKey', async () => {
      prisma.ledgerEntry.findUnique.mockResolvedValue({
        id: 'entry-1',
        wallet: { userId: USER_ID, balance: new Prisma.Decimal('100.50') },
      });

      const result = await service.addFunds(
        USER_ID,
        100,
        'Повтор',
        'topup-key-1',
      );

      expect(result).toEqual({ balance: '100.50', entryId: 'entry-1' });
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    it('запрещает использовать чужой idempotencyKey', async () => {
      prisma.ledgerEntry.findUnique.mockResolvedValue({
        id: 'entry-1',
        wallet: {
          userId: '22222222-2222-2222-2222-222222222222',
          balance: new Prisma.Decimal('10.00'),
        },
      });

      await expect(
        service.addFunds(USER_ID, 10, 'Чужой ключ', 'foreign-key'),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    it('возвращает существующую операцию при гонке уникального ключа', async () => {
      prisma.ledgerEntry.findUnique
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce({
          id: 'entry-1',
          wallet: { userId: USER_ID, balance: new Prisma.Decimal('100.00') },
        });
      prisma.$transaction.mockRejectedValue(
        new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
          code: 'P2002',
          clientVersion: '5.22.0',
          meta: { target: ['idempotencyKey'] },
        }),
      );

      await expect(
        service.addFunds(USER_ID, 100, 'Гонка', 'race-key'),
      ).resolves.toEqual({ balance: '100.00', entryId: 'entry-1' });
    });

    it.each([0, -10, Number.NaN])(
      'отклоняет некорректную сумму (%s)',
      async (amount) => {
        await expect(
          service.addFunds(USER_ID, amount, 'Пополнение', 'key'),
        ).rejects.toBeInstanceOf(BadRequestException);
        expect(prisma.$transaction).not.toHaveBeenCalled();
      },
    );
  });

  describe('chargeForSkill', () => {
    it('атомарно списывает средства и пишет debit с balanceAfter', async () => {
      const tx = createTx();
      tx.wallet.updateMany.mockResolvedValue({ count: 1 });
      tx.wallet.findUniqueOrThrow.mockResolvedValue({
        id: 'wallet-1',
        balance: new Prisma.Decimal('150.00'),
      });
      tx.ledgerEntry.create.mockResolvedValue({ id: 'entry-debit-1' });
      prisma.ledgerEntry.findUnique.mockResolvedValue(null);
      useTx(tx);

      const result = await service.chargeForSkill(
        USER_ID,
        50,
        'Вызов навыка',
        'charge-key-1',
      );

      expect(result).toEqual({
        balance: '150.00',
        entryId: 'entry-debit-1',
      });
      expect(prisma.$transaction).toHaveBeenCalledTimes(1);

      const [updateArgs] = tx.wallet.updateMany.mock.calls[0] as [
        {
          where: { userId: string; balance: { gte: Prisma.Decimal } };
          data: { balance: { decrement: Prisma.Decimal } };
        },
      ];
      expect(updateArgs.where.userId).toBe(USER_ID);
      expect(updateArgs.where.balance.gte.toFixed(2)).toBe('50.00');
      expect(updateArgs.data.balance.decrement.toFixed(2)).toBe('50.00');

      const [createArgs] = tx.ledgerEntry.create.mock.calls[0] as [
        {
          data: {
            walletId: string;
            amount: Prisma.Decimal;
            balanceAfter: Prisma.Decimal;
            type: string;
            description: string;
            idempotencyKey: string;
          };
        },
      ];
      expect(createArgs.data).toMatchObject({
        walletId: 'wallet-1',
        type: 'debit',
        description: 'Вызов навыка',
        idempotencyKey: 'charge-key-1',
      });
      expect(createArgs.data.amount.toFixed(2)).toBe('50.00');
      expect(createArgs.data.balanceAfter.toFixed(2)).toBe('150.00');
    });

    it('выбрасывает Insufficient funds при нехватке средств', async () => {
      const tx = createTx();
      tx.wallet.updateMany.mockResolvedValue({ count: 0 });
      prisma.ledgerEntry.findUnique.mockResolvedValue(null);
      useTx(tx);

      await expect(
        service.chargeForSkill(USER_ID, 50, 'Дорогой Skill', 'charge-key-2'),
      ).rejects.toThrow(ERROR_KEYS.insufficientFunds);
      expect(tx.wallet.findUniqueOrThrow).not.toHaveBeenCalled();
      expect(tx.ledgerEntry.create).not.toHaveBeenCalled();
    });

    it('не списывает повторно при том же idempotencyKey', async () => {
      prisma.ledgerEntry.findUnique.mockResolvedValue({
        id: 'entry-debit-1',
        wallet: { userId: USER_ID, balance: new Prisma.Decimal('150.00') },
      });

      const result = await service.chargeForSkill(
        USER_ID,
        50,
        'Повтор списания',
        'charge-key-1',
      );

      expect(result).toEqual({
        balance: '150.00',
        entryId: 'entry-debit-1',
      });
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    it('не допускает отрицательный баланс при параллельных списаниях', async () => {
      let balance = new Prisma.Decimal('100.00');
      const tx = createTx();

      tx.wallet.updateMany.mockImplementation(
        async (args: {
          where: { userId: string; balance: { gte: Prisma.Decimal } };
          data: { balance: { decrement: Prisma.Decimal } };
        }) => {
          if (balance.gte(args.where.balance.gte)) {
            balance = balance.minus(args.data.balance.decrement);

            return { count: 1 };
          }

          return { count: 0 };
        },
      );
      tx.wallet.findUniqueOrThrow.mockImplementation(async () => ({
        id: 'wallet-1',
        balance,
      }));
      tx.ledgerEntry.create.mockImplementation(async () => ({ id: 'entry' }));
      prisma.ledgerEntry.findUnique.mockResolvedValue(null);
      useTx(tx);

      const results = await Promise.allSettled([
        service.chargeForSkill(USER_ID, 60, 'Параллельно #1', 'parallel-key-1'),
        service.chargeForSkill(USER_ID, 60, 'Параллельно #2', 'parallel-key-2'),
      ]);

      const fulfilled = results.filter((result) => result.status === 'fulfilled');
      const rejected = results.filter((result) => result.status === 'rejected');

      expect(fulfilled).toHaveLength(1);
      expect(rejected).toHaveLength(1);
      expect((rejected[0] as PromiseRejectedResult).reason).toBeInstanceOf(
        BadRequestException,
      );
      expect(balance.toFixed(2)).toBe('40.00');
      expect(tx.ledgerEntry.create).toHaveBeenCalledTimes(1);
    });
  });
});

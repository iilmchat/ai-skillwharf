import { BadRequestException, ConflictException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { Test, TestingModule } from '@nestjs/testing';
import { PrismaService } from '../prisma/prisma.service.js';
import { BillingService } from './billing.service.js';

type MockFn = ReturnType<typeof vi.fn>;

interface TxMock {
  wallet: { upsert: MockFn; findUnique: MockFn; update: MockFn };
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
    wallet: { upsert: vi.fn(), findUnique: vi.fn(), update: vi.fn() },
    ledgerEntry: { create: vi.fn() },
  };
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
    it('атомарно начисляет средства и пишет credit с idempotencyKey', async () => {
      const tx = createTx();
      tx.wallet.upsert.mockResolvedValue({
        id: 'wallet-1',
        balance: new Prisma.Decimal('150.25'),
      });
      tx.ledgerEntry.create.mockResolvedValue({ id: 'entry-1' });
      prisma.ledgerEntry.findUnique.mockResolvedValue(null);
      prisma.$transaction.mockImplementation(
        async (callback: (client: TxMock) => unknown) => callback(tx),
      );

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
    it('списывает средства и пишет debit в Ledger', async () => {
      const tx = createTx();
      tx.wallet.findUnique.mockResolvedValue({
        id: 'wallet-1',
        balance: new Prisma.Decimal('200.00'),
      });
      tx.wallet.update.mockResolvedValue({
        balance: new Prisma.Decimal('150.00'),
      });
      tx.ledgerEntry.create.mockResolvedValue({ id: 'entry-debit-1' });
      prisma.ledgerEntry.findUnique.mockResolvedValue(null);
      prisma.$transaction.mockImplementation(
        async (callback: (client: TxMock) => unknown) => callback(tx),
      );

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

      const [updateArgs] = tx.wallet.update.mock.calls[0] as [
        { where: { userId: string }; data: { balance: { decrement: Prisma.Decimal } } },
      ];
      expect(updateArgs.where).toEqual({ userId: USER_ID });
      expect(updateArgs.data.balance.decrement.toFixed(2)).toBe('50.00');

      const [createArgs] = tx.ledgerEntry.create.mock.calls[0] as [
        {
          data: {
            walletId: string;
            amount: Prisma.Decimal;
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
    });

    it('выбрасывает Insufficient funds при нехватке средств', async () => {
      const tx = createTx();
      tx.wallet.findUnique.mockResolvedValue({
        id: 'wallet-1',
        balance: new Prisma.Decimal('10.00'),
      });
      prisma.ledgerEntry.findUnique.mockResolvedValue(null);
      prisma.$transaction.mockImplementation(
        async (callback: (client: TxMock) => unknown) => callback(tx),
      );

      await expect(
        service.chargeForSkill(USER_ID, 50, 'Дорогой Skill', 'charge-key-2'),
      ).rejects.toThrow('Insufficient funds');
      expect(tx.wallet.update).not.toHaveBeenCalled();
      expect(tx.ledgerEntry.create).not.toHaveBeenCalled();
    });

    it('считает отсутствующий кошелёк нулевым балансом', async () => {
      const tx = createTx();
      tx.wallet.findUnique.mockResolvedValue(null);
      prisma.ledgerEntry.findUnique.mockResolvedValue(null);
      prisma.$transaction.mockImplementation(
        async (callback: (client: TxMock) => unknown) => callback(tx),
      );

      await expect(
        service.chargeForSkill(USER_ID, 1, 'Skill', 'charge-key-3'),
      ).rejects.toThrow('Insufficient funds');
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
  });
});

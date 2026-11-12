import {
  BadRequestException,
  ConflictException,
  Injectable,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service.js';

export interface WalletBalance {
  balance: string;
}

export interface LedgerOperationResult extends WalletBalance {
  entryId: string;
}

interface ExistingLedgerEntry {
  id: string;
  wallet: { userId: string; balance: Prisma.Decimal };
}

@Injectable()
export class BillingService {
  constructor(private readonly prisma: PrismaService) {}

  /** Баланс кошелька; если кошелька нет — создаёт его с нулевым балансом. */
  async getBalance(userId: string): Promise<WalletBalance> {
    const wallet = await this.prisma.wallet.upsert({
      where: { userId },
      create: { userId },
      update: {},
    });

    return { balance: formatBalance(wallet.balance) };
  }

  /**
   * Пополнение (credit): запись в append-only Ledger и обновление баланса
   * выполняются атомарно. `idempotencyKey` защищает от повторных начислений.
   */
  async addFunds(
    userId: string,
    amount: number,
    description: string,
    idempotencyKey: string,
  ): Promise<LedgerOperationResult> {
    this.assertPositiveAmount(amount);
    this.assertIdempotencyKey(idempotencyKey);

    const existing = await this.findExistingEntry(idempotencyKey);

    if (existing) {
      return this.replayExisting(existing, userId);
    }

    const decimalAmount = new Prisma.Decimal(amount);

    try {
      return await this.prisma.$transaction(async (tx) => {
        const wallet = await tx.wallet.upsert({
          where: { userId },
          create: { userId, balance: decimalAmount },
          update: { balance: { increment: decimalAmount } },
        });

        const entry = await tx.ledgerEntry.create({
          data: {
            walletId: wallet.id,
            amount: decimalAmount,
            balanceAfter: wallet.balance,
            type: 'credit',
            description,
            idempotencyKey,
          },
        });

        return { balance: formatBalance(wallet.balance), entryId: entry.id };
      });
    } catch (error) {
      // Параллельный запрос с тем же ключом мог успеть первым.
      const raced = await this.replayAfterUniqueViolation(error, idempotencyKey, userId);

      if (raced) {
        return raced;
      }

      throw error;
    }
  }

  /**
   * Paywall: списание средств за вызов Skill.
   *
   * Списание атомарное: условный `updateMany` с `balance >= amount` исключает
   * гонку между проверкой баланса и вычитанием (баланс не уйдёт в минус).
   * `idempotencyKey` защищает от повторных списаний.
   */
  async chargeForSkill(
    userId: string,
    amount: number,
    description: string,
    idempotencyKey: string,
  ): Promise<LedgerOperationResult> {
    this.assertPositiveAmount(amount);
    this.assertIdempotencyKey(idempotencyKey);

    const existing = await this.findExistingEntry(idempotencyKey);

    if (existing) {
      return this.replayExisting(existing, userId);
    }

    const decimalAmount = new Prisma.Decimal(amount);

    try {
      return await this.prisma.$transaction(async (tx) => {
        const updateResult = await tx.wallet.updateMany({
          where: {
            userId,
            balance: { gte: decimalAmount },
          },
          data: {
            balance: { decrement: decimalAmount },
          },
        });

        if (updateResult.count === 0) {
          throw new BadRequestException(
            'Insufficient funds or wallet not found',
          );
        }

        // После атомарного списания баланс уже уменьшен.
        const wallet = await tx.wallet.findUniqueOrThrow({
          where: { userId },
        });

        const entry = await tx.ledgerEntry.create({
          data: {
            walletId: wallet.id,
            amount: decimalAmount,
            balanceAfter: wallet.balance,
            type: 'debit',
            description,
            idempotencyKey,
          },
        });

        return { balance: formatBalance(wallet.balance), entryId: entry.id };
      });
    } catch (error) {
      const raced = await this.replayAfterUniqueViolation(error, idempotencyKey, userId);

      if (raced) {
        return raced;
      }

      throw error;
    }
  }

  private assertPositiveAmount(amount: number): void {
    if (!Number.isFinite(amount) || amount <= 0) {
      throw new BadRequestException(
        'Сумма операции должна быть положительным числом',
      );
    }
  }

  private assertIdempotencyKey(idempotencyKey: string): void {
    if (typeof idempotencyKey !== 'string' || idempotencyKey.trim() === '') {
      throw new BadRequestException('idempotencyKey обязателен');
    }
  }

  private findExistingEntry(
    idempotencyKey: string,
  ): Promise<ExistingLedgerEntry | null> {
    return this.prisma.ledgerEntry.findUnique({
      where: { idempotencyKey },
      select: {
        id: true,
        wallet: { select: { userId: true, balance: true } },
      },
    });
  }

  /** Повторный запрос с уже обработанным ключом: возвращаем текущий баланс. */
  private replayExisting(
    entry: ExistingLedgerEntry,
    userId: string,
  ): LedgerOperationResult {
    if (entry.wallet.userId !== userId) {
      throw new ConflictException(
        'idempotencyKey уже использован другим пользователем',
      );
    }

    return {
      balance: formatBalance(entry.wallet.balance),
      entryId: entry.id,
    };
  }

  private async replayAfterUniqueViolation(
    error: unknown,
    idempotencyKey: string,
    userId: string,
  ): Promise<LedgerOperationResult | null> {
    if (!isUniqueViolation(error)) {
      return null;
    }

    const entry = await this.findExistingEntry(idempotencyKey);

    return entry ? this.replayExisting(entry, userId) : null;
  }
}

function formatBalance(balance: Prisma.Decimal): string {
  return balance.toFixed(2);
}

function isUniqueViolation(error: unknown): boolean {
  return (
    error instanceof Prisma.PrismaClientKnownRequestError &&
    error.code === 'P2002'
  );
}

import {
  BadRequestException,
  ConflictException,
  Injectable,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { ERROR_KEYS } from '../i18n/error-keys.js';
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
          throw new BadRequestException(ERROR_KEYS.insufficientFunds);
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

  /**
   * Freemium: первые `freeCallsLimit` вызовов навыка бесплатны, дальше
   * списывается `price`. Счётчик занимается атомарно, поэтому лимит не
   * превышается при параллельных вызовах.
   *
   * Возвращает `null`, если вызов попал в бесплатный лимит.
   */
  async checkAndChargeSkill(
    userId: string,
    skillName: string,
    price: number,
    freeCallsLimit = 0,
  ): Promise<LedgerOperationResult | null> {
    if (
      freeCallsLimit > 0 &&
      (await this.tryConsumeFreeCall(userId, skillName, freeCallsLimit))
    ) {
      return null;
    }

    return this.chargeForSkill(
      userId,
      price,
      `Вызов навыка ${skillName}`,
      randomUUID(),
    );
  }

  /** Атомарно занимает один бесплатный вызов; `false` — лимит исчерпан. */
  private async tryConsumeFreeCall(
    userId: string,
    skillName: string,
    freeCallsLimit: number,
  ): Promise<boolean> {
    const consumed = await this.prisma.skillUsage.updateMany({
      where: { userId, skillName, callsCount: { lt: freeCallsLimit } },
      data: { callsCount: { increment: 1 } },
    });

    if (consumed.count > 0) {
      return true;
    }

    const existing = await this.prisma.skillUsage.findUnique({
      where: { userId_skillName: { userId, skillName } },
      select: { id: true },
    });

    if (existing) {
      return false;
    }

    try {
      await this.prisma.skillUsage.create({
        data: {
          userId,
          skillName,
          callsCount: 1,
          lastResetAt: new Date(),
        },
      });

      return true;
    } catch (error) {
      if (!isUniqueViolation(error)) {
        throw error;
      }

      // Параллельный вызов уже создал запись — повторяем атомарный инкремент.
      const raced = await this.prisma.skillUsage.updateMany({
        where: { userId, skillName, callsCount: { lt: freeCallsLimit } },
        data: { callsCount: { increment: 1 } },
      });

      return raced.count > 0;
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

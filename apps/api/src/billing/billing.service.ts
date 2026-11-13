import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { ERROR_KEYS } from '../i18n/error-keys.js';
import { PrismaService } from '../prisma/prisma.service.js';
import {
  encodeLedgerCursor,
  type LedgerQuery,
} from './dto/ledger-query.dto.js';
import type { LedgerItem, LedgerPage } from './dto/ledger-response.dto.js';

export interface WalletBalance {
  balance: string;
  /** Замороженные средства Pay-per-Outcome. */
  heldBalance?: string;
}

export interface LedgerOperationResult extends WalletBalance {
  entryId: string;
}

/** Результат escrow-операции: hold, capture или cancel. */
export interface EscrowOperationResult extends WalletBalance {
  entryId: string;
  amount: string;
  heldBalance: string;
  type: 'PENDING' | 'debit' | 'credit';
}

/** Запись истории операций для отдачи в API. */
export interface LedgerHistoryEntry {
  id: string;
  amount: string;
  balanceAfter: string;
  type: string;
  description: string;
  createdAt: Date;
}

/** Сколько последних операций отдаём в истории. */
const LEDGER_HISTORY_LIMIT = 50;

interface ExistingLedgerEntry {
  id: string;
  type: string;
  amount: Prisma.Decimal;
  wallet: {
    userId: string;
    balance: Prisma.Decimal;
    heldBalance: Prisma.Decimal;
  };
}

@Injectable()
export class BillingService {
  constructor(private readonly prisma: PrismaService) {}

  /** Баланс кошелька и сумма незавершённых PENDING-записей. */
  async getBalance(userId: string): Promise<WalletBalance> {
    const wallet = await this.prisma.wallet.upsert({
      where: { userId },
      create: { userId },
      update: {},
    });
    const pending = await this.prisma.ledgerEntry.aggregate({
      where: { walletId: wallet.id, type: 'PENDING' },
      _sum: { amount: true },
    });

    return {
      balance: formatBalance(wallet.balance),
      heldBalance: formatBalance(pending._sum.amount ?? new Prisma.Decimal(0)),
    };
  }

  /**
   * Последние 50 операций по кошельку пользователя (append-only Ledger).
   * Если кошелька ещё нет, возвращает пустой список.
   */
  async getTransactionHistory(userId: string): Promise<LedgerHistoryEntry[]> {
    const entries = await this.prisma.ledgerEntry.findMany({
      where: { wallet: { userId } },
      orderBy: { createdAt: 'desc' },
      take: LEDGER_HISTORY_LIMIT,
      select: {
        id: true,
        amount: true,
        balanceAfter: true,
        type: true,
        description: true,
        createdAt: true,
      },
    });

    return entries.map((entry) => ({
      id: entry.id,
      amount: formatBalance(entry.amount),
      balanceAfter: formatBalance(entry.balanceAfter),
      type: entry.type,
      description: entry.description,
      createdAt: entry.createdAt,
    }));
  }

  /**
   * Страница истории операций (read-API Ledger).
   *
   * Две стратегии: `offset` — простые страницы, `cursor` — keyset-пагинация
   * по `(createdAt, id)`, при которой новые записи не сдвигают уже выданные
   * страницы. Порядок — от новых к старым, `total` — общее число операций
   * пользователя (не длина страницы). `createdAt` отдаётся строкой ISO 8601.
   */
  async getTransactionPage(
    userId: string,
    query: LedgerQuery,
  ): Promise<LedgerPage> {
    const where =
      query.cursor === undefined
        ? { wallet: { userId } }
        : {
            wallet: { userId },
            OR: [
              { createdAt: { lt: new Date(query.cursor.createdAt) } },
              {
                createdAt: new Date(query.cursor.createdAt),
                id: { lt: query.cursor.id },
              },
            ],
          };

    const [rows, total] = await Promise.all([
      this.prisma.ledgerEntry.findMany({
        where,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        ...(query.cursor === undefined ? { skip: query.offset } : {}),
        // Одна запись сверху нужна только чтобы понять, есть ли следующая страница.
        take: query.limit + 1,
        select: {
          id: true,
          amount: true,
          balanceAfter: true,
          type: true,
          description: true,
          createdAt: true,
        },
      }),
      this.prisma.ledgerEntry.count({ where: { wallet: { userId } } }),
    ]);

    const hasMore = rows.length > query.limit;
    const pageRows = hasMore ? rows.slice(0, query.limit) : rows;
    const lastRow = pageRows.at(-1);

    const items: LedgerItem[] = pageRows.map((entry) => ({
      id: entry.id,
      amount: formatBalance(entry.amount),
      balanceAfter: formatBalance(entry.balanceAfter),
      type: entry.type,
      description: entry.description,
      createdAt: entry.createdAt.toISOString(),
    }));

    return {
      items,
      total,
      nextCursor:
        hasMore && lastRow !== undefined
          ? encodeLedgerCursor({
              createdAt: lastRow.createdAt.toISOString(),
              id: lastRow.id,
            })
          : null,
    };
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
      const raced = await this.replayAfterUniqueViolation(
        error,
        idempotencyKey,
        userId,
      );

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
   *
   * `llmRouteName` заполняется только для LLM-списаний: по этой колонке
   * LlmRouterService считает дневной бюджет маршрута (KI-010).
   */
  async chargeForSkill(
    userId: string,
    amount: number,
    description: string,
    idempotencyKey: string,
    llmRouteName?: string,
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
            ...(llmRouteName === undefined ? {} : { llmRouteName }),
          },
        });

        return { balance: formatBalance(wallet.balance), entryId: entry.id };
      });
    } catch (error) {
      const raced = await this.replayAfterUniqueViolation(
        error,
        idempotencyKey,
        userId,
      );

      if (raced) {
        return raced;
      }

      throw error;
    }
  }

  /**
   * Pay-per-Outcome, фаза 1: резервирует сумму под будущую задачу.
   * `balance` уменьшается, `heldBalance` растёт, в Ledger пишется PENDING.
   */
  async authorizeHold(
    userId: string,
    amount: number,
    idempotencyKey: string,
  ): Promise<EscrowOperationResult> {
    this.assertPositiveAmount(amount);
    this.assertIdempotencyKey(idempotencyKey);

    const existing = await this.findExistingEntry(idempotencyKey);

    if (existing) {
      return this.replayEscrow(existing, userId);
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
            heldBalance: { increment: decimalAmount },
          },
        });

        if (updateResult.count === 0) {
          throw new BadRequestException(ERROR_KEYS.insufficientFunds);
        }

        const wallet = await tx.wallet.findUniqueOrThrow({
          where: { userId },
        });

        const entry = await tx.ledgerEntry.create({
          data: {
            walletId: wallet.id,
            amount: decimalAmount,
            balanceAfter: wallet.balance,
            type: 'PENDING',
            description: 'Резерв под задачу (Pay-per-Outcome)',
            idempotencyKey,
          },
        });

        return {
          balance: formatBalance(wallet.balance),
          heldBalance: formatBalance(wallet.heldBalance),
          amount: formatBalance(decimalAmount),
          entryId: entry.id,
          type: 'PENDING' as const,
        };
      });
    } catch (error) {
      const raced = await this.replayEscrowAfterUniqueViolation(
        error,
        idempotencyKey,
        userId,
      );

      if (raced) {
        return raced;
      }

      throw error;
    }
  }

  /**
   * Pay-per-Outcome, фаза 2 (успех): PENDING становится debit.
   * `heldBalance` уменьшается, `balance` уже был уменьшен при hold.
   */
  async captureHold(transactionId: string): Promise<EscrowOperationResult> {
    this.assertTransactionId(transactionId);

    return this.prisma.$transaction(async (tx) => {
      const entry = await tx.ledgerEntry.findUnique({
        where: { id: transactionId },
        select: {
          id: true,
          type: true,
          amount: true,
          walletId: true,
          wallet: {
            select: { userId: true, balance: true, heldBalance: true },
          },
        },
      });

      if (!entry) {
        throw new NotFoundException(
          `Escrow-транзакция ${transactionId} не найдена`,
        );
      }

      if (entry.type === 'debit') {
        return this.escrowResult(entry, entry.wallet, 'debit');
      }

      if (entry.type !== 'PENDING') {
        throw new ConflictException('Escrow-транзакция уже отменена');
      }

      const updateResult = await tx.wallet.updateMany({
        where: {
          id: entry.walletId,
          heldBalance: { gte: entry.amount },
        },
        data: {
          heldBalance: { decrement: entry.amount },
        },
      });

      if (updateResult.count === 0) {
        throw new ConflictException('На кошельке недостаточно heldBalance');
      }

      const wallet = await tx.wallet.findUniqueOrThrow({
        where: { id: entry.walletId },
      });

      await tx.ledgerEntry.update({
        where: { id: entry.id },
        data: { type: 'debit' },
      });

      return this.escrowResult(entry, wallet, 'debit');
    });
  }

  /**
   * Pay-per-Outcome, фаза 2 (ошибка/отмена): PENDING становится credit.
   * `heldBalance` уменьшается, `balance` возвращается пользователю.
   */
  async cancelHold(transactionId: string): Promise<EscrowOperationResult> {
    this.assertTransactionId(transactionId);

    return this.prisma.$transaction(async (tx) => {
      const entry = await tx.ledgerEntry.findUnique({
        where: { id: transactionId },
        select: {
          id: true,
          type: true,
          amount: true,
          walletId: true,
          wallet: {
            select: { userId: true, balance: true, heldBalance: true },
          },
        },
      });

      if (!entry) {
        throw new NotFoundException(
          `Escrow-транзакция ${transactionId} не найдена`,
        );
      }

      if (entry.type === 'credit') {
        return this.escrowResult(entry, entry.wallet, 'credit');
      }

      if (entry.type !== 'PENDING') {
        throw new ConflictException('Escrow-транзакция уже списана');
      }

      const updateResult = await tx.wallet.updateMany({
        where: {
          id: entry.walletId,
          heldBalance: { gte: entry.amount },
        },
        data: {
          heldBalance: { decrement: entry.amount },
          balance: { increment: entry.amount },
        },
      });

      if (updateResult.count === 0) {
        throw new ConflictException('На кошельке недостаточно heldBalance');
      }

      const wallet = await tx.wallet.findUniqueOrThrow({
        where: { id: entry.walletId },
      });

      await tx.ledgerEntry.update({
        where: { id: entry.id },
        data: { type: 'credit', balanceAfter: wallet.balance },
      });

      return this.escrowResult(entry, wallet, 'credit');
    });
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

  private assertTransactionId(transactionId: string): void {
    if (typeof transactionId !== 'string' || transactionId.trim() === '') {
      throw new BadRequestException('transactionId обязателен');
    }
  }

  private findExistingEntry(
    idempotencyKey: string,
  ): Promise<ExistingLedgerEntry | null> {
    return this.prisma.ledgerEntry.findUnique({
      where: { idempotencyKey },
      select: {
        id: true,
        type: true,
        amount: true,
        wallet: {
          select: { userId: true, balance: true, heldBalance: true },
        },
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

  /** Повторный escrow-запрос: возвращаем состояние существующей записи. */
  private replayEscrow(
    entry: ExistingLedgerEntry,
    userId: string,
  ): EscrowOperationResult {
    if (entry.wallet.userId !== userId) {
      throw new ConflictException(
        'idempotencyKey уже использован другим пользователем',
      );
    }

    return this.escrowResult(entry, entry.wallet, escrowType(entry.type));
  }

  private escrowResult(
    entry: { id: string; amount: Prisma.Decimal },
    wallet: { balance: Prisma.Decimal; heldBalance: Prisma.Decimal },
    type: 'PENDING' | 'debit' | 'credit',
  ): EscrowOperationResult {
    return {
      balance: formatBalance(wallet.balance),
      heldBalance: formatBalance(wallet.heldBalance),
      amount: formatBalance(entry.amount),
      entryId: entry.id,
      type,
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

  private async replayEscrowAfterUniqueViolation(
    error: unknown,
    idempotencyKey: string,
    userId: string,
  ): Promise<EscrowOperationResult | null> {
    if (!isUniqueViolation(error)) {
      return null;
    }

    const entry = await this.findExistingEntry(idempotencyKey);

    return entry ? this.replayEscrow(entry, userId) : null;
  }
}

function formatBalance(balance: Prisma.Decimal): string {
  return balance.toFixed(2);
}

function escrowType(type: string): 'PENDING' | 'debit' | 'credit' {
  if (type === 'PENDING' || type === 'debit' || type === 'credit') {
    return type;
  }

  throw new Error(`Неподдерживаемый тип escrow-записи: ${type}`);
}

function isUniqueViolation(error: unknown): boolean {
  return (
    error instanceof Prisma.PrismaClientKnownRequestError &&
    error.code === 'P2002'
  );
}

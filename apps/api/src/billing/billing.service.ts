import { BadRequestException, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service.js';

export interface WalletBalance {
  balance: string;
}

export interface TopUpResult extends WalletBalance {
  entryId: string;
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

    return { balance: wallet.balance.toFixed(2) };
  }

  /**
   * Пополнение (credit): запись в append-only Ledger и обновление баланса
   * выполняются атомарно в одной транзакции.
   */
  async addFunds(
    userId: string,
    amount: number,
    description: string,
  ): Promise<TopUpResult> {
    if (!Number.isFinite(amount) || amount <= 0) {
      throw new BadRequestException(
        'Сумма пополнения должна быть положительным числом',
      );
    }

    const decimalAmount = new Prisma.Decimal(amount);

    return this.prisma.$transaction(async (tx) => {
      const wallet = await tx.wallet.upsert({
        where: { userId },
        create: { userId, balance: decimalAmount },
        update: { balance: { increment: decimalAmount } },
      });

      const entry = await tx.ledgerEntry.create({
        data: {
          walletId: wallet.id,
          amount: decimalAmount,
          type: 'credit',
          description,
        },
      });

      return { balance: wallet.balance.toFixed(2), entryId: entry.id };
    });
  }
}

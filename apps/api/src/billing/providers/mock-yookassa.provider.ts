import { Injectable, Logger } from '@nestjs/common';
import type { IBillingProvider, TransactionResult } from '@skillwharf/shared';
import { randomUUID } from 'node:crypto';

/**
 * Заглушка ЮKassa для локальной разработки и тестов: реализует BAL-интерфейс
 * из `@skillwharf/shared`, ничего не отправляет в платёжный сервис,
 * логирует вызовы и возвращает фейковые идентификаторы.
 */
@Injectable()
export class MockYooKassaProvider implements IBillingProvider {
  private readonly logger = new Logger(MockYooKassaProvider.name);

  async authorize(
    userId: string,
    skillId: string,
    amount: number,
  ): Promise<TransactionResult> {
    const transactionId = randomUUID();

    this.logger.log(
      `Mock ЮKassa: authorize user=${userId} skill=${skillId} amount=${amount} tx=${transactionId}`,
    );

    return { status: 'success', transactionId };
  }

  async capture(transactionId: string): Promise<void> {
    this.logger.log(`Mock ЮKassa: capture tx=${transactionId}`);
  }

  async cancel(transactionId: string): Promise<void> {
    this.logger.log(`Mock ЮKassa: cancel tx=${transactionId}`);
  }
}

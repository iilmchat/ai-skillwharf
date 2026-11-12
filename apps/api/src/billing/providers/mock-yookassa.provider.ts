import { Injectable, Logger } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type {
  CreatePaymentParams,
  IBillingProvider,
  PaymentResult,
  WebhookEvent,
} from '../interfaces/billing-provider.interface.js';

/**
 * Заглушка ЮKassa для локальной разработки и тестов: ничего не отправляет
 * в платёжный сервис, логирует вызовы и возвращает фейковый URL оплаты.
 */
@Injectable()
export class MockYooKassaProvider implements IBillingProvider {
  private readonly logger = new Logger(MockYooKassaProvider.name);

  async createPayment(params: CreatePaymentParams): Promise<PaymentResult> {
    const paymentId = randomUUID();

    this.logger.log(
      `Mock ЮKassa: createPayment user=${params.userId} amount=${params.amount} key=${params.idempotencyKey}`,
    );

    return {
      paymentId,
      confirmationUrl: `https://yookassa.mock/payments/${paymentId}/confirm`,
      status: 'pending',
    };
  }

  async handleWebhook(event: WebhookEvent): Promise<void> {
    this.logger.log(
      `Mock ЮKassa: webhook event=${event.event} payment=${event.paymentId} status=${event.status}`,
    );
  }
}

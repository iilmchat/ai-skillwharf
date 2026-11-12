/** Контракт платёжного провайдера в Billing Abstraction Layer (BAL). */
export interface IBillingProvider {
  createPayment(params: CreatePaymentParams): Promise<PaymentResult>;
  handleWebhook(event: WebhookEvent): Promise<void>;
}

export interface CreatePaymentParams {
  userId: string;
  amount: number;
  description: string;
  idempotencyKey: string;
}

export type PaymentStatus = 'pending' | 'succeeded' | 'canceled';

export interface PaymentResult {
  paymentId: string;
  /** URL страницы оплаты, куда перенаправляется пользователь. */
  confirmationUrl: string;
  status: PaymentStatus;
}

export interface WebhookEvent {
  event: string;
  paymentId: string;
  status: PaymentStatus;
}

import {
  BadRequestException,
  Injectable,
  Logger,
  Optional,
  ServiceUnavailableException,
} from '@nestjs/common';
import type { IBillingProvider, TransactionResult } from '@skillwharf/shared';
import axios, { isAxiosError, type AxiosInstance } from 'axios';
import { randomUUID } from 'node:crypto';

/** Базовый URL API ЮKassa. */
export const YOOKASSA_API_BASE_URL = 'https://api.yookassa.ru/v3';

/** Тело запроса на создание платежа (подмножество полей API). */
export interface YooKassaPaymentRequest {
  amount: { value: string; currency: string };
  confirmation: { type: 'redirect'; return_url: string };
  capture: boolean;
  description?: string;
  metadata: Record<string, string>;
}

/** Ответ API ЮKassa на создание платежа (используемые поля). */
export interface YooKassaPaymentResponse {
  id: string;
  status: string;
  confirmation?: { type: string; confirmation_url?: string };
}

/** Уведомление ЮKassa о событии платежа. */
export interface YooKassaWebhookPayload {
  type?: string;
  event?: string;
  object?: {
    id?: string;
    status?: string;
    paid?: boolean;
    amount?: { value?: string; currency?: string };
    metadata?: Record<string, unknown>;
  };
}

/**
 * Payer-уведомление, разобранное до безопасных значений: сумма и владелец
 * кошелька. Используется webhook-эндпоинтом.
 */
export interface YooKassaPaymentNotification {
  paymentId: string;
  userId: string;
  amount: number;
}

/** Настройки провайдера; по умолчанию читаются из переменных окружения. */
export interface YooKassaOptions {
  shopId?: string;
  secretKey?: string;
}

/**
 * Реальный провайдер ЮKassa: создаёт платёжные ссылки через REST API
 * (`POST /v3/payments`). Для локальной разработки без ключей остаётся
 * `MockYooKassaProvider`.
 */
@Injectable()
export class YooKassaProvider implements IBillingProvider {
  private readonly logger = new Logger(YooKassaProvider.name);
  private readonly http: AxiosInstance;
  private readonly shopId: string;
  private readonly secretKey: string;

  // `@Optional()` обязателен: Nest не должен искать `Object` в DI-контейнере.
  constructor(@Optional() options: YooKassaOptions = {}) {
    this.shopId = options.shopId ?? process.env.YOOKASSA_SHOP_ID ?? '';
    this.secretKey = options.secretKey ?? process.env.YOOKASSA_SECRET_KEY ?? '';
    this.http = axios.create({
      baseURL: YOOKASSA_API_BASE_URL,
      timeout: 10_000,
    });

    if (!this.isConfigured()) {
      this.logger.warn(
        'ЮKassa не настроена (YOOKASSA_SHOP_ID/YOOKASSA_SECRET_KEY) — платежи недоступны',
      );
    }
  }

  /** Заданы ли ключи магазина. */
  isConfigured(): boolean {
    return this.shopId !== '' && this.secretKey !== '';
  }

  /**
   * Создаёт платёж и возвращает ссылку на страницу оплаты.
   * `Idempotence-Key` защищает от повторного списания при ретраях.
   */
  async createPayment(
    userId: string,
    amount: number,
    returnUrl: string,
  ): Promise<string> {
    if (!this.isConfigured()) {
      throw new ServiceUnavailableException(
        'Платёжный провайдер ЮKassa не настроен',
      );
    }

    if (!Number.isFinite(amount) || amount <= 0) {
      throw new BadRequestException(
        'Сумма платежа должна быть положительным числом',
      );
    }

    if (typeof returnUrl !== 'string' || returnUrl.trim() === '') {
      throw new BadRequestException('returnUrl обязателен');
    }

    const body: YooKassaPaymentRequest = {
      amount: { value: amount.toFixed(2), currency: 'RUB' },
      confirmation: { type: 'redirect', return_url: returnUrl },
      capture: true,
      metadata: { userId },
    };

    try {
      const { data } = await this.http.post<YooKassaPaymentResponse>(
        '/payments',
        body,
        {
          headers: {
            'Content-Type': 'application/json',
            'Idempotence-Key': randomUUID(),
          },
          auth: { username: this.shopId, password: this.secretKey },
        },
      );
      const confirmationUrl = data.confirmation?.confirmation_url;

      if (!confirmationUrl) {
        throw new ServiceUnavailableException(
          'ЮKassa не вернула ссылку на оплату',
        );
      }

      this.logger.log(
        `ЮKassa: платёж ${data.id} создан для user=${userId} на ${body.amount.value} ₽`,
      );

      return confirmationUrl;
    } catch (error) {
      if (error instanceof BadRequestException) {
        throw error;
      }

      if (
        error instanceof ServiceUnavailableException ||
        isAxiosError(error) === false
      ) {
        throw error;
      }

      const status = error.response?.status ?? 0;
      const response = error.response?.data as
        { description?: string } | undefined;
      const description = response?.description ?? error.message;

      this.logger.error(
        `ЮKassa: не удалось создать платёж (HTTP ${status}): ${description}`,
      );
      throw new ServiceUnavailableException(
        'Не удалось создать платёж в ЮKassa',
      );
    }
  }

  /**
   * Разбирает уведомление `payment.succeeded`. Возвращает `null`, если
   * событие не про успешную оплату или в нём нет обязательных полей.
   */
  parsePaymentSucceeded(
    payload: YooKassaWebhookPayload,
  ): YooKassaPaymentNotification | null {
    if (payload.event !== 'payment.succeeded') {
      return null;
    }

    const object = payload.object;
    const userId = object?.metadata?.userId;
    const rawAmount = object?.amount?.value;

    if (typeof userId !== 'string' || userId.trim() === '') {
      return null;
    }

    if (typeof rawAmount !== 'string') {
      return null;
    }

    const amount = Number.parseFloat(rawAmount);

    if (!Number.isFinite(amount) || amount <= 0) {
      return null;
    }

    return {
      paymentId: typeof object?.id === 'string' ? object.id : '',
      userId,
      amount,
    };
  }

  /** BAL: авторизация через ЮKassa не используется в demo-потоке. */
  async authorize(): Promise<TransactionResult> {
    throw new ServiceUnavailableException(
      'Авторизация через ЮKassa пока не поддерживается',
    );
  }

  async capture(): Promise<void> {
    throw new ServiceUnavailableException(
      'Capture через ЮKassa пока не поддерживается',
    );
  }

  async cancel(): Promise<void> {
    throw new ServiceUnavailableException(
      'Cancel через ЮKassa пока не поддерживается',
    );
  }
}

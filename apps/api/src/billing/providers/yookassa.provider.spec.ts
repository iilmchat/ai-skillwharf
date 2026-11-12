import {
  BadRequestException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const post = vi.fn();
const create = vi.fn(() => ({ post }));

vi.mock('axios', () => ({
  default: { create },
  isAxiosError: (error: unknown): boolean =>
    typeof error === 'object' &&
    error !== null &&
    (error as { isAxiosError?: boolean }).isAxiosError === true,
}));

const { YooKassaProvider } = await import('./yookassa.provider.js');

const SHOP_ID = 'shop-1';
const SECRET_KEY = 'secret-key';
const RETURN_URL = 'http://localhost:8080/app/chat?payment=success';
const USER_ID = '11111111-1111-1111-1111-111111111111';

function createProvider(
  options: { shopId?: string; secretKey?: string } = {},
): InstanceType<typeof YooKassaProvider> {
  return new YooKassaProvider({
    shopId: options.shopId ?? SHOP_ID,
    secretKey: options.secretKey ?? SECRET_KEY,
  });
}

describe('YooKassaProvider', () => {
  beforeEach(() => {
    post.mockReset();
    create.mockClear();
  });

  describe('createPayment', () => {
    it('создаёт платёж и возвращает confirmation_url', async () => {
      post.mockResolvedValue({
        data: {
          id: 'payment-1',
          status: 'pending',
          confirmation: {
            type: 'redirect',
            confirmation_url: 'https://yoomoney.ru/checkout/abc',
          },
        },
      });
      const provider = createProvider();

      await expect(
        provider.createPayment(USER_ID, 500, RETURN_URL),
      ).resolves.toBe('https://yoomoney.ru/checkout/abc');

      expect(create).toHaveBeenCalledWith(
        expect.objectContaining({
          baseURL: 'https://api.yookassa.ru/v3',
        }),
      );

      const [path, body, config] = post.mock.calls[0] as [
        string,
        Record<string, unknown>,
        {
          headers: Record<string, string>;
          auth: { username: string; password: string };
        },
      ];

      expect(path).toBe('/payments');
      expect(body).toEqual({
        amount: { value: '500.00', currency: 'RUB' },
        confirmation: { type: 'redirect', return_url: RETURN_URL },
        capture: true,
        metadata: { userId: USER_ID },
      });
      expect(config.headers['Content-Type']).toBe('application/json');
      expect(config.headers['Idempotence-Key']).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
      );
      expect(config.auth).toEqual({
        username: SHOP_ID,
        password: SECRET_KEY,
      });
    });

    it('отклоняет неположительную сумму', async () => {
      const provider = createProvider();

      await expect(
        provider.createPayment(USER_ID, 0, RETURN_URL),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(post).not.toHaveBeenCalled();
    });

    it('отклоняет пустой returnUrl', async () => {
      const provider = createProvider();

      await expect(
        provider.createPayment(USER_ID, 100, '  '),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(post).not.toHaveBeenCalled();
    });

    it('сообщает об ошибке API как 503', async () => {
      post.mockRejectedValue({
        isAxiosError: true,
        message: 'Request failed with status code 401',
        response: {
          status: 401,
          data: { description: 'Invalid credentials' },
        },
      });
      const provider = createProvider();

      await expect(
        provider.createPayment(USER_ID, 100, RETURN_URL),
      ).rejects.toBeInstanceOf(ServiceUnavailableException);
    });

    it('падает, если ЮKassa не вернула ссылку на оплату', async () => {
      post.mockResolvedValue({
        data: { id: 'payment-1', status: 'pending' },
      });
      const provider = createProvider();

      await expect(
        provider.createPayment(USER_ID, 100, RETURN_URL),
      ).rejects.toBeInstanceOf(ServiceUnavailableException);
    });

    it('не делает запрос без ключей магазина', async () => {
      const provider = createProvider({ shopId: '', secretKey: '' });

      await expect(
        provider.createPayment(USER_ID, 100, RETURN_URL),
      ).rejects.toBeInstanceOf(ServiceUnavailableException);
      expect(post).not.toHaveBeenCalled();
    });
  });

  describe('parsePaymentSucceeded', () => {
    it('извлекает userId и сумму из уведомления', () => {
      const provider = createProvider();

      expect(
        provider.parsePaymentSucceeded({
          event: 'payment.succeeded',
          object: {
            id: 'payment-1',
            amount: { value: '500.00', currency: 'RUB' },
            metadata: { userId: USER_ID },
          },
        }),
      ).toEqual({ paymentId: 'payment-1', userId: USER_ID, amount: 500 });
    });

    it('игнорирует другие события', () => {
      const provider = createProvider();

      expect(
        provider.parsePaymentSucceeded({ event: 'payment.canceled' }),
      ).toBeNull();
    });

    it('игнорирует уведомление без userId или суммы', () => {
      const provider = createProvider();

      expect(
        provider.parsePaymentSucceeded({
          event: 'payment.succeeded',
          object: { id: 'payment-1' },
        }),
      ).toBeNull();
      expect(
        provider.parsePaymentSucceeded({
          event: 'payment.succeeded',
          object: {
            id: 'payment-1',
            amount: { value: '0' },
            metadata: { userId: USER_ID },
          },
        }),
      ).toBeNull();
    });
  });
});

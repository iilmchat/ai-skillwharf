import {
  BadRequestException,
  InternalServerErrorException,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { ROLES_KEY } from '../auth/decorators/roles.decorator.js';
import { ApiException } from '../common/api-error.js';
import { BillingController } from './billing.controller.js';
import { BillingService } from './billing.service.js';
import { encodeLedgerCursor } from './dto/ledger-query.dto.js';
import { LedgerPageSchema } from './dto/ledger-response.dto.js';
import { YooKassaProvider } from './providers/yookassa.provider.js';
import type { TopUpDto } from './dto/topup.dto.js';

const USER_ID = '11111111-1111-1111-1111-111111111111';
const OTHER_USER_ID = '22222222-2222-2222-2222-222222222222';
const ADMIN_ID = '33333333-3333-3333-3333-333333333333';
const LEDGER_CREATED_AT = '2026-11-12T10:00:00.000Z';

const LEDGER_PAGE = {
  items: [
    {
      id: 'entry-1',
      amount: '100.00',
      balanceAfter: '150.00',
      type: 'credit',
      description: 'Пополнение баланса',
      createdAt: LEDGER_CREATED_AT,
    },
  ],
  total: 7,
  nextCursor: null,
};

type MockFn = ReturnType<typeof vi.fn>;

interface BillingMock {
  addFunds: MockFn;
  getBalance: MockFn;
  getTransactionPage: MockFn;
}

interface YooKassaMock {
  createPayment: MockFn;
  parsePaymentSucceeded: MockFn;
  getPaymentStatus: MockFn;
}

type ControllerRequest = Parameters<BillingController['topup']>[0];

interface TestUser {
  userId: string;
  email: string;
  role: string;
}

function createRequest(user?: TestUser): ControllerRequest {
  return { user } as unknown as ControllerRequest;
}

function createDto(userId?: string): TopUpDto {
  return {
    ...(userId === undefined ? {} : { userId }),
    amount: 500,
    idempotencyKey: 'topup-key-1',
  };
}

describe('BillingController', () => {
  let controller: BillingController;
  let billing: BillingMock;
  let yooKassa: YooKassaMock;

  beforeEach(async () => {
    billing = {
      addFunds: vi.fn(),
      getBalance: vi.fn(),
      getTransactionPage: vi.fn(),
    };
    billing.addFunds.mockResolvedValue({
      balance: '500.00',
      entryId: 'entry-1',
    });
    yooKassa = {
      createPayment: vi.fn(),
      parsePaymentSucceeded: vi.fn(),
      getPaymentStatus: vi.fn(),
    };

    const moduleRef: TestingModule = await Test.createTestingModule({
      controllers: [BillingController],
      providers: [
        { provide: BillingService, useValue: billing },
        { provide: YooKassaProvider, useValue: yooKassa },
      ],
    }).compile();

    controller = moduleRef.get(BillingController);
  });

  describe('getBalance', () => {
    it('возвращает balance и heldBalance', async () => {
      const request = createRequest({
        userId: USER_ID,
        email: 'user@example.com',
        role: 'user',
      });
      billing.getBalance.mockResolvedValue({
        balance: '10.00',
        heldBalance: '100.00',
      });

      await expect(controller.getBalance(request)).resolves.toEqual({
        balance: '10.00',
        heldBalance: '100.00',
      });
      expect(billing.getBalance).toHaveBeenCalledWith(USER_ID);
    });

    it('требует аутентификации', () => {
      const request = createRequest();

      expect(() => controller.getBalance(request)).toThrow(
        UnauthorizedException,
      );
    });
  });

  describe('createPayment', () => {
    it('возвращает ссылку на оплату от ЮKassa', async () => {
      const request = createRequest({
        userId: USER_ID,
        email: 'user@example.com',
        role: 'user',
      });
      yooKassa.createPayment.mockResolvedValue(
        'https://yoomoney.ru/checkout/abc',
      );

      await expect(
        controller.createPayment(request, { amount: 500 }),
      ).resolves.toEqual({ url: 'https://yoomoney.ru/checkout/abc' });
      expect(yooKassa.createPayment).toHaveBeenCalledWith(
        USER_ID,
        500,
        expect.any(String),
      );
    });

    it('использует переданный returnUrl', async () => {
      const request = createRequest({
        userId: USER_ID,
        email: 'user@example.com',
        role: 'user',
      });
      yooKassa.createPayment.mockResolvedValue('https://pay.example/1');

      await controller.createPayment(request, {
        amount: 100,
        returnUrl: 'http://localhost:8080/app/chat?payment=success',
      });

      expect(yooKassa.createPayment).toHaveBeenCalledWith(
        USER_ID,
        100,
        'http://localhost:8080/app/chat?payment=success',
      );
    });

    it('требует аутентификации', async () => {
      const request = createRequest();

      await expect(
        controller.createPayment(request, { amount: 500 }),
      ).rejects.toBeInstanceOf(UnauthorizedException);
      expect(yooKassa.createPayment).not.toHaveBeenCalled();
    });
  });

  describe('webhook', () => {
    const notification = {
      paymentId: 'payment-1',
      userId: USER_ID,
      amount: 500,
    };
    const confirmedPayment = {
      id: 'payment-1',
      status: 'succeeded',
      paid: true,
      amount: { value: '500.00', currency: 'RUB' },
      metadata: { userId: USER_ID },
    };

    beforeEach(() => {
      yooKassa.parsePaymentSucceeded.mockReturnValue(notification);
      yooKassa.getPaymentStatus.mockResolvedValue(confirmedPayment);
    });

    it('зачисляет средства по payment.succeeded', async () => {
      await expect(
        controller.webhook({
          event: 'payment.succeeded',
          object: { id: 'payment-1' },
        }),
      ).resolves.toEqual({ ok: true });

      // Перед зачислением платёж перепроверяется в API ЮKassa.
      expect(yooKassa.getPaymentStatus).toHaveBeenCalledWith('payment-1');
      expect(billing.addFunds).toHaveBeenCalledWith(
        USER_ID,
        500,
        'Пополнение через ЮKassa',
        'yookassa:payment-1',
      );
    });

    it('игнорирует прочие события и отвечает 200', async () => {
      yooKassa.parsePaymentSucceeded.mockReturnValue(null);

      await expect(
        controller.webhook({ event: 'payment.canceled' }),
      ).resolves.toEqual({ ok: true });

      expect(billing.addFunds).not.toHaveBeenCalled();
      expect(yooKassa.getPaymentStatus).not.toHaveBeenCalled();
    });

    it('отклоняет поддельное уведомление с другой суммой', async () => {
      yooKassa.getPaymentStatus.mockResolvedValue({
        ...confirmedPayment,
        amount: { value: '1.00', currency: 'RUB' },
      });

      await expect(
        controller.webhook({ event: 'payment.succeeded' }),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(billing.addFunds).not.toHaveBeenCalled();
    });

    it('отклоняет уведомление о незавершённом платеже', async () => {
      yooKassa.getPaymentStatus.mockResolvedValue({
        ...confirmedPayment,
        status: 'pending',
        paid: false,
      });

      await expect(
        controller.webhook({ event: 'payment.succeeded' }),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(billing.addFunds).not.toHaveBeenCalled();
    });

    it('отклоняет уведомление с чужим userId', async () => {
      yooKassa.getPaymentStatus.mockResolvedValue({
        ...confirmedPayment,
        metadata: { userId: OTHER_USER_ID },
      });

      await expect(
        controller.webhook({ event: 'payment.succeeded' }),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(billing.addFunds).not.toHaveBeenCalled();
    });

    it('не зачисляет средства, если ЮKassa недоступна', async () => {
      yooKassa.getPaymentStatus.mockRejectedValue(
        new ServiceUnavailableException('ЮKassa недоступна'),
      );

      await expect(
        controller.webhook({ event: 'payment.succeeded' }),
      ).rejects.toBeInstanceOf(ServiceUnavailableException);
      expect(billing.addFunds).not.toHaveBeenCalled();
    });
  });

  describe('topup', () => {
    it('доступен только роли admin', () => {
      const descriptor = Object.getOwnPropertyDescriptor(
        BillingController.prototype,
        'topup',
      );
      const handler = descriptor?.value as object;

      expect(Reflect.getMetadata(ROLES_KEY, handler)).toEqual(['admin']);
    });

    it('разрешает админу пополнить любой кошелёк', async () => {
      const request = createRequest({
        userId: ADMIN_ID,
        email: 'admin@example.com',
        role: 'admin',
      });

      await controller.topup(request, createDto(OTHER_USER_ID));

      expect(billing.addFunds).toHaveBeenCalledWith(
        OTHER_USER_ID,
        500,
        'Пополнение баланса',
        'topup-key-1',
      );
    });

    it('пополняет свой кошелёк, если админ не передал userId', async () => {
      const request = createRequest({
        userId: ADMIN_ID,
        email: 'admin@example.com',
        role: 'admin',
      });

      await controller.topup(request, createDto());

      expect(billing.addFunds).toHaveBeenCalledWith(
        ADMIN_ID,
        500,
        'Пополнение баланса',
        'topup-key-1',
      );
    });

    it('требует аутентификации', () => {
      expect(() =>
        controller.topup(createRequest(), createDto(USER_ID)),
      ).toThrow(UnauthorizedException);
      expect(billing.addFunds).not.toHaveBeenCalled();
    });
  });

  describe('getLedger', () => {
    const request = createRequest({
      userId: USER_ID,
      email: 'user@example.com',
      role: 'user',
    });

    /** Вызывает getLedger и возвращает Api-ошибку 400 (сервис не вызван). */
    async function expectInvalidQuery(
      query: Record<string, string>,
    ): Promise<ApiException> {
      let caught: unknown;

      try {
        await controller.getLedger(request, query);
      } catch (error) {
        caught = error;
      }

      expect(caught).toBeInstanceOf(ApiException);
      expect((caught as ApiException).getResponse()).toMatchObject({
        statusCode: 400,
        error: 'Bad Request',
        code: 'errors.invalid_request',
        message: expect.stringContaining('Некорректные параметры запроса'),
      });
      expect(billing.getTransactionPage).not.toHaveBeenCalled();

      return caught as ApiException;
    }

    it('возвращает страницу операций текущего пользователя', async () => {
      billing.getTransactionPage.mockResolvedValue(LEDGER_PAGE);

      await expect(controller.getLedger(request, {})).resolves.toEqual(
        LEDGER_PAGE,
      );
      // userId — только из JWT; по умолчанию limit=20, offset=0.
      expect(billing.getTransactionPage).toHaveBeenCalledWith(USER_ID, {
        limit: 20,
        offset: 0,
      });
    });

    it('передаёт limit и offset в сервис', async () => {
      billing.getTransactionPage.mockResolvedValue(LEDGER_PAGE);

      await controller.getLedger(request, { limit: '5', offset: '10' });

      expect(billing.getTransactionPage).toHaveBeenCalledWith(USER_ID, {
        limit: 5,
        offset: 10,
      });
    });

    it('декодирует opaque cursor из query', async () => {
      billing.getTransactionPage.mockResolvedValue(LEDGER_PAGE);
      const cursor = encodeLedgerCursor({
        createdAt: LEDGER_CREATED_AT,
        id: 'entry-1',
      });

      await controller.getLedger(request, { limit: '5', cursor });

      expect(billing.getTransactionPage).toHaveBeenCalledWith(USER_ID, {
        limit: 5,
        offset: 0,
        cursor: { createdAt: LEDGER_CREATED_AT, id: 'entry-1' },
      });
    });

    it.each<[string, Record<string, string>]>([
      ['limit=0', { limit: '0' }],
      ['limit=101', { limit: '101' }],
      ['limit не число', { limit: 'abc' }],
      ['offset=-1', { offset: '-1' }],
      ['offset больше 10000', { offset: '10001' }],
      ['битый cursor', { cursor: 'не-курсор' }],
      [
        'cursor и offset одновременно',
        {
          cursor: encodeLedgerCursor({
            createdAt: LEDGER_CREATED_AT,
            id: 'entry-1',
          }),
          offset: '5',
        },
      ],
      ['лишний параметр', { limit: '10', userId: USER_ID }],
    ])('отклоняет некорректный query: %s', async (_name, query) => {
      await expectInvalidQuery(query);
    });

    it('требует аутентификации', async () => {
      await expect(
        controller.getLedger(createRequest(), {}),
      ).rejects.toBeInstanceOf(UnauthorizedException);
      expect(billing.getTransactionPage).not.toHaveBeenCalled();
    });

    it('отдаёт 500, если ответ сервиса разошёлся с контрактом', async () => {
      billing.getTransactionPage.mockResolvedValue({
        items: [
          {
            id: 'entry-1',
            amount: '100.00',
            balanceAfter: '150.00',
            type: 'credit',
            description: 'Пополнение баланса',
            createdAt: 'вчера',
          },
        ],
        total: 1,
        nextCursor: null,
      });

      await expect(controller.getLedger(request, {})).rejects.toBeInstanceOf(
        InternalServerErrorException,
      );
    });
  });
});

describe('LedgerPageSchema', () => {
  const item = LEDGER_PAGE.items[0];

  it('принимает контрактный ответ', () => {
    expect(LedgerPageSchema.parse(LEDGER_PAGE)).toEqual(LEDGER_PAGE);
  });

  it.each<[string, unknown]>([
    ['items не массив', { items: null, total: 0, nextCursor: null }],
    [
      'пустой id',
      {
        items: [{ ...item, id: '' }],
        total: 1,
        nextCursor: null,
      },
    ],
    [
      'не ISO дата',
      {
        items: [{ ...item, createdAt: 'вчера' }],
        total: 1,
        nextCursor: null,
      },
    ],
    [
      'пустой amount',
      { items: [{ ...item, amount: '' }], total: 1, nextCursor: null },
    ],
    ['дробный total', { items: [], total: 1.5, nextCursor: null }],
    ['отрицательный total', { items: [], total: -1, nextCursor: null }],
    ['nextCursor отсутствует', { items: [], total: 0 }],
    ['nextCursor не строка', { items: [], total: 0, nextCursor: 42 }],
  ])('отклоняет ответ с расхождением контракта: %s', (_name, payload) => {
    expect(LedgerPageSchema.safeParse(payload).success).toBe(false);
  });
});

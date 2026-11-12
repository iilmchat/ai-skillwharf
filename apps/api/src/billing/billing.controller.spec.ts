import { UnauthorizedException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { ROLES_KEY } from '../auth/decorators/roles.decorator.js';
import { BillingController } from './billing.controller.js';
import { BillingService } from './billing.service.js';
import type { TopUpDto } from './dto/topup.dto.js';

const USER_ID = '11111111-1111-1111-1111-111111111111';
const OTHER_USER_ID = '22222222-2222-2222-2222-222222222222';
const ADMIN_ID = '33333333-3333-3333-3333-333333333333';

type MockFn = ReturnType<typeof vi.fn>;

interface BillingMock {
  addFunds: MockFn;
  getBalance: MockFn;
  getTransactionHistory: MockFn;
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

  beforeEach(async () => {
    billing = {
      addFunds: vi.fn(),
      getBalance: vi.fn(),
      getTransactionHistory: vi.fn(),
    };
    billing.addFunds.mockResolvedValue({
      balance: '500.00',
      entryId: 'entry-1',
    });

    const moduleRef: TestingModule = await Test.createTestingModule({
      controllers: [BillingController],
      providers: [{ provide: BillingService, useValue: billing }],
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

  describe('topup', () => {
    it('позволяет пользователю пополнить свой баланс', async () => {
      const request = createRequest({
        userId: USER_ID,
        email: 'user@example.com',
        role: 'user',
      });

      await expect(
        controller.topup(request, createDto(USER_ID)),
      ).resolves.toEqual({ balance: '500.00', entryId: 'entry-1' });

      expect(billing.addFunds).toHaveBeenCalledWith(
        USER_ID,
        500,
        'Пополнение баланса',
        'topup-key-1',
      );
    });

    it('позволяет пользователю не передавать userId', async () => {
      const request = createRequest({
        userId: USER_ID,
        email: 'user@example.com',
        role: 'user',
      });

      await controller.topup(request, createDto());

      expect(billing.addFunds).toHaveBeenCalledWith(
        USER_ID,
        500,
        'Пополнение баланса',
        'topup-key-1',
      );
    });

    it('игнорирует чужой userId в теле запроса для роли user', async () => {
      const request = createRequest({
        userId: USER_ID,
        email: 'user@example.com',
        role: 'user',
      });

      await controller.topup(request, createDto(OTHER_USER_ID));

      expect(billing.addFunds).toHaveBeenCalledWith(
        USER_ID,
        500,
        'Пополнение баланса',
        'topup-key-1',
      );
      expect(billing.addFunds).not.toHaveBeenCalledWith(
        OTHER_USER_ID,
        expect.anything(),
        expect.anything(),
        expect.anything(),
      );
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

    it('разрешён ролям user и admin', () => {
      const descriptor = Object.getOwnPropertyDescriptor(
        BillingController.prototype,
        'topup',
      );
      const handler = descriptor?.value as object;

      expect(Reflect.getMetadata(ROLES_KEY, handler)).toEqual([
        'user',
        'admin',
      ]);
    });

    it('требует аутентификации', () => {
      expect(() =>
        controller.topup(createRequest(), createDto(USER_ID)),
      ).toThrow(UnauthorizedException);
      expect(billing.addFunds).not.toHaveBeenCalled();
    });
  });

  describe('getLedger', () => {
    it('возвращает историю операций текущего пользователя', async () => {
      const entries = [
        {
          id: 'entry-1',
          amount: '100.00',
          balanceAfter: '100.00',
          type: 'credit',
          description: 'Пополнение баланса',
          createdAt: new Date('2026-11-12T10:00:00.000Z'),
        },
      ];
      billing.getTransactionHistory.mockResolvedValue(entries);
      const request = createRequest({
        userId: USER_ID,
        email: 'user@example.com',
        role: 'user',
      });

      await expect(controller.getLedger(request)).resolves.toEqual(entries);
      expect(billing.getTransactionHistory).toHaveBeenCalledWith(USER_ID);
    });

    it('требует аутентификации', () => {
      expect(() => controller.getLedger(createRequest())).toThrow(
        UnauthorizedException,
      );
      expect(billing.getTransactionHistory).not.toHaveBeenCalled();
    });
  });
});

import type {
  HealthCheckResult,
  HealthCheckService,
  PrismaHealthIndicator,
} from '@nestjs/terminus';
import type { PrismaService } from '../prisma/prisma.service.js';
import { HealthController } from './health.controller.js';

function createController() {
  const healthResult: HealthCheckResult = {
    status: 'ok',
    info: {},
    error: {},
    details: {},
  };
  const health = {
    check: vi.fn(async (indicators: Array<() => unknown>) => {
      await Promise.all(indicators.map((indicator) => indicator()));
      return healthResult;
    }),
  };
  const prismaIndicator = {
    pingCheck: vi.fn().mockResolvedValue({ database: { status: 'up' } }),
  };
  const prisma = {} as PrismaService;

  const controller = new HealthController(
    health as unknown as HealthCheckService,
    prismaIndicator as unknown as PrismaHealthIndicator,
    prisma,
  );

  return { controller, health, prismaIndicator };
}

describe('HealthController', () => {
  it('live не обращается к БД', () => {
    const { controller, health } = createController();

    expect(controller.live()).toEqual({ status: 'ok' });
    expect(health.check).not.toHaveBeenCalled();
  });

  it('ready проверяет БД через Terminus', async () => {
    const { controller, health, prismaIndicator } = createController();

    await expect(controller.ready()).resolves.toEqual({
      status: 'ok',
      database: true,
    });
    expect(health.check).toHaveBeenCalledTimes(1);
    expect(prismaIndicator.pingCheck).toHaveBeenCalledWith(
      'database',
      expect.anything(),
    );
  });

  it('/health сохраняет обратную совместимость readiness', async () => {
    const { controller, health } = createController();

    await expect(controller.check()).resolves.toEqual({
      status: 'ok',
      database: true,
    });
    expect(health.check).toHaveBeenCalledTimes(1);
  });

  it('ready возвращает ошибку, если БД недоступна', async () => {
    const { controller, health } = createController();
    health.check.mockRejectedValueOnce(new Error('db down'));

    await expect(controller.ready()).rejects.toThrow('db down');
  });
});

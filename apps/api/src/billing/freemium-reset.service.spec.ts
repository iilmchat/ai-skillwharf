import { Logger } from '@nestjs/common';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PrismaService } from '../prisma/prisma.service.js';
import {
  FREEMIUM_RESET_DEFAULT_INTERVAL_MS,
  FreemiumResetService,
  resetFreemiumLimits,
  startOfUtcMonth,
} from './freemium-reset.service.js';

interface UsageRow {
  id: string;
  lastResetAt: Date;
  callsCount: number;
}

interface PrismaMock {
  skillUsage: { updateMany: ReturnType<typeof vi.fn> };
}

function createPrismaMock(): PrismaMock {
  return { skillUsage: { updateMany: vi.fn() } };
}

describe('startOfUtcMonth', () => {
  it.each<[string, string, string]>([
    ['середина месяца', '2026-11-13T15:06:46.123Z', '2026-11-01T00:00:00.000Z'],
    [
      'последняя миллисекунда месяца',
      '2026-11-30T23:59:59.999Z',
      '2026-11-01T00:00:00.000Z',
    ],
    [
      'полночь первого числа',
      '2026-11-01T00:00:00.000Z',
      '2026-11-01T00:00:00.000Z',
    ],
    ['декабрь', '2026-12-31T23:00:00.000Z', '2026-12-01T00:00:00.000Z'],
    ['январь', '2027-01-01T00:00:00.000Z', '2027-01-01T00:00:00.000Z'],
    [
      'февраль невисокосного года',
      '2026-02-28T23:59:59.999Z',
      '2026-02-01T00:00:00.000Z',
    ],
    [
      'февраль високосного года',
      '2028-02-29T12:00:00.000Z',
      '2028-02-01T00:00:00.000Z',
    ],
    [
      'сдвиг пояса: 00:30+03:00 — ещё предыдущий месяц UTC',
      '2026-01-01T00:30:00+03:00',
      '2025-12-01T00:00:00.000Z',
    ],
  ])('%s', (_name, iso, expected) => {
    expect(startOfUtcMonth(new Date(iso)).toISOString()).toBe(expected);
  });

  it('не мутирует переданную дату', () => {
    const now = new Date('2026-11-13T15:06:46.123Z');

    startOfUtcMonth(now);

    expect(now.toISOString()).toBe('2026-11-13T15:06:46.123Z');
  });
});

describe('resetFreemiumLimits', () => {
  it('обнуляет счётчики прошлых месяцев и ставит отметку now', async () => {
    const prisma = createPrismaMock();
    prisma.skillUsage.updateMany.mockResolvedValue({ count: 3 });
    const now = new Date('2026-11-13T15:06:46.000Z');

    await expect(
      resetFreemiumLimits(prisma as unknown as PrismaService, now),
    ).resolves.toBe(3);

    expect(prisma.skillUsage.updateMany).toHaveBeenCalledWith({
      where: { lastResetAt: { lt: new Date('2026-11-01T00:00:00.000Z') } },
      data: { callsCount: 0, lastResetAt: now },
    });
  });

  it('не трогает записи текущего месяца и идемпотентен при повторе', async () => {
    const rows: UsageRow[] = [
      {
        id: 'september',
        lastResetAt: new Date('2026-09-30T23:00:00.000Z'),
        callsCount: 50,
      },
      {
        id: 'october',
        lastResetAt: new Date('2026-10-15T10:00:00.000Z'),
        callsCount: 17,
      },
      {
        id: 'november',
        lastResetAt: new Date('2026-11-05T10:00:00.000Z'),
        callsCount: 7,
      },
    ];
    const prisma = createPrismaMock();
    prisma.skillUsage.updateMany.mockImplementation(
      async (args: {
        where: { lastResetAt: { lt: Date } };
        data: { callsCount: number; lastResetAt: Date };
      }) => {
        let count = 0;

        for (const row of rows) {
          if (row.lastResetAt.getTime() < args.where.lastResetAt.lt.getTime()) {
            row.callsCount = args.data.callsCount;
            row.lastResetAt = args.data.lastResetAt;
            count += 1;
          }
        }

        return { count };
      },
    );
    const now = new Date('2026-11-13T15:06:46.000Z');

    await expect(
      resetFreemiumLimits(prisma as unknown as PrismaService, now),
    ).resolves.toBe(2);

    expect(rows.find((row) => row.id === 'september')).toMatchObject({
      callsCount: 0,
      lastResetAt: now,
    });
    expect(rows.find((row) => row.id === 'october')).toMatchObject({
      callsCount: 0,
      lastResetAt: now,
    });
    // Запись текущего месяца не тронута.
    expect(rows.find((row) => row.id === 'november')).toMatchObject({
      callsCount: 7,
      lastResetAt: new Date('2026-11-05T10:00:00.000Z'),
    });

    // Повторный тик в том же месяце: счётчики уже отмечены — no-op.
    await expect(
      resetFreemiumLimits(prisma as unknown as PrismaService, now),
    ).resolves.toBe(0);
    expect(rows.find((row) => row.id === 'november')?.callsCount).toBe(7);
  });

  it('в новом календарном месяце сбрасывает счётчики прошлого', async () => {
    const rows: UsageRow[] = [
      {
        id: 'november',
        lastResetAt: new Date('2026-11-13T15:06:46.000Z'),
        callsCount: 5,
      },
    ];
    const prisma = createPrismaMock();
    prisma.skillUsage.updateMany.mockImplementation(
      async (args: {
        where: { lastResetAt: { lt: Date } };
        data: { callsCount: number; lastResetAt: Date };
      }) => {
        let count = 0;

        for (const row of rows) {
          if (row.lastResetAt.getTime() < args.where.lastResetAt.lt.getTime()) {
            row.callsCount = args.data.callsCount;
            row.lastResetAt = args.data.lastResetAt;
            count += 1;
          }
        }

        return { count };
      },
    );

    const december = new Date('2026-12-01T00:00:00.000Z');

    await expect(
      resetFreemiumLimits(prisma as unknown as PrismaService, december),
    ).resolves.toBe(1);
    expect(rows[0]).toMatchObject({ callsCount: 0, lastResetAt: december });
  });
});

describe('FreemiumResetService', () => {
  let prisma: PrismaMock;
  let service: FreemiumResetService;
  const originalInterval = process.env.FREEMIUM_RESET_INTERVAL_MS;

  function createService(): FreemiumResetService {
    return new FreemiumResetService(prisma as unknown as PrismaService);
  }

  beforeEach(() => {
    vi.useFakeTimers();
    // Лог сервиса не должен засорять вывод тестов.
    vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    prisma = createPrismaMock();
    prisma.skillUsage.updateMany.mockResolvedValue({ count: 0 });
    service = createService();
  });

  afterEach(() => {
    service.onModuleDestroy();
    vi.restoreAllMocks();
    vi.useRealTimers();

    if (originalInterval === undefined) {
      delete process.env.FREEMIUM_RESET_INTERVAL_MS;
    } else {
      process.env.FREEMIUM_RESET_INTERVAL_MS = originalInterval;
    }
  });

  it('выполняет тик сразу при старте и затем по интервалу', async () => {
    process.env.FREEMIUM_RESET_INTERVAL_MS = '1000';
    prisma.skillUsage.updateMany.mockResolvedValue({ count: 2 });

    service.onModuleInit();
    await vi.advanceTimersByTimeAsync(0);

    expect(prisma.skillUsage.updateMany).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(999);
    expect(prisma.skillUsage.updateMany).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1);
    expect(prisma.skillUsage.updateMany).toHaveBeenCalledTimes(2);
    expect(prisma.skillUsage.updateMany).toHaveBeenLastCalledWith({
      where: { lastResetAt: { lt: expect.any(Date) } },
      data: { callsCount: 0, lastResetAt: expect.any(Date) },
    });
  });

  it('использует суточный интервал по умолчанию', async () => {
    delete process.env.FREEMIUM_RESET_INTERVAL_MS;

    service.onModuleInit();
    await vi.advanceTimersByTimeAsync(0);
    expect(prisma.skillUsage.updateMany).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(FREEMIUM_RESET_DEFAULT_INTERVAL_MS - 1);
    expect(prisma.skillUsage.updateMany).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1);
    expect(prisma.skillUsage.updateMany).toHaveBeenCalledTimes(2);
  });

  it('игнорирует некорректный FREEMIUM_RESET_INTERVAL_MS', async () => {
    process.env.FREEMIUM_RESET_INTERVAL_MS = 'abc';

    service.onModuleInit();
    await vi.advanceTimersByTimeAsync(0);
    expect(prisma.skillUsage.updateMany).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(FREEMIUM_RESET_DEFAULT_INTERVAL_MS - 1);
    expect(prisma.skillUsage.updateMany).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1);
    expect(prisma.skillUsage.updateMany).toHaveBeenCalledTimes(2);
  });

  it('останавливает таймер в onModuleDestroy', async () => {
    process.env.FREEMIUM_RESET_INTERVAL_MS = '1000';

    service.onModuleInit();
    await vi.advanceTimersByTimeAsync(0);
    expect(prisma.skillUsage.updateMany).toHaveBeenCalledTimes(1);

    service.onModuleDestroy();
    await vi.advanceTimersByTimeAsync(10_000);

    expect(prisma.skillUsage.updateMany).toHaveBeenCalledTimes(1);
  });

  it('логирует ошибку тика и не роняет процесс', async () => {
    process.env.FREEMIUM_RESET_INTERVAL_MS = '1000';
    const errorLog = vi
      .spyOn(Logger.prototype, 'error')
      .mockImplementation(() => undefined);
    prisma.skillUsage.updateMany.mockRejectedValue(new Error('БД недоступна'));

    service.onModuleInit();
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(1000);

    expect(errorLog).toHaveBeenCalledWith(
      expect.stringContaining('БД недоступна'),
    );
    expect(prisma.skillUsage.updateMany).toHaveBeenCalledTimes(2);
  });

  it('tick возвращает 0, если сброс упал', async () => {
    prisma.skillUsage.updateMany.mockRejectedValue(new Error('fail'));

    await expect(
      service.tick(new Date('2026-11-13T00:00:00.000Z')),
    ).resolves.toBe(0);
  });
});

import { describe, expect, it } from 'vitest';
import {
  computeNextCronRun,
  cronExpressionSchema,
  parseCronExpression,
} from './cron.js';

describe('cron-парсер (CRON-43.1)', () => {
  it('поддерживает *, числа, списки, диапазоны и шаги', () => {
    const parsed = parseCronExpression('*/15 8-10 1,15 1,12 1-5');

    expect([...parsed.minutes]).toEqual([0, 15, 30, 45]);
    expect([...parsed.hours]).toEqual([8, 9, 10]);
    expect([...parsed.daysOfMonth]).toEqual([1, 15]);
    expect([...parsed.months]).toEqual([1, 12]);
    expect([...parsed.daysOfWeek].sort()).toEqual([1, 2, 3, 4, 5]);
  });

  it('Zod отвергает невалидные выражения', () => {
    for (const bad of ['* * * *', '60 * * * *', '*/0 * * * *', 'x * * * *']) {
      expect(cronExpressionSchema.safeParse(bad).success).toBe(false);
    }
    expect(cronExpressionSchema.safeParse('30 8 * * 1-5').success).toBe(true);
  });

  it('*/15 считает следующее срабатывание по четвертям часа', () => {
    expect(
      computeNextCronRun(
        '*/15 * * * *',
        'UTC',
        new Date('2026-11-20T12:07:00Z'),
      ).toISOString(),
    ).toBe('2026-11-20T12:15:00.000Z');
  });

  it('30 8 * * 1-5 пропускает выходные (Europe/Moscow)', () => {
    // Пятница 12:00 MSK — время уже прошло, следующее срабатывание — понедельник.
    expect(
      computeNextCronRun(
        '30 8 * * 1-5',
        'Europe/Moscow',
        new Date('2026-11-20T09:00:00Z'),
      ).toISOString(),
    ).toBe('2026-11-23T05:30:00.000Z');
  });

  it('30 8 * * 1-5 срабатывает в тот же день, если время не наступило', () => {
    expect(
      computeNextCronRun(
        '30 8 * * 1-5',
        'Europe/Moscow',
        new Date('2026-11-20T05:00:00Z'),
      ).toISOString(),
    ).toBe('2026-11-20T05:30:00.000Z');
  });

  it('учитывает таймзон с дневным светом (лето)', () => {
    // Июль: MSK = UTC+3, 08:30 MSK = 05:30 UTC.
    expect(
      computeNextCronRun(
        '30 8 * * *',
        'Europe/Moscow',
        new Date('2026-07-01T00:00:00Z'),
      ).toISOString(),
    ).toBe('2026-07-01T05:30:00.000Z');
  });
});

import { z } from 'zod';

/** Разобранное 5-полевое cron-выражение: min hour dom month dow. */
export interface CronFields {
  readonly minutes: ReadonlySet<number>;
  readonly hours: ReadonlySet<number>;
  readonly daysOfMonth: ReadonlySet<number>;
  readonly months: ReadonlySet<number>;
  readonly daysOfWeek: ReadonlySet<number>;
  readonly domWildcard: boolean;
  readonly dowWildcard: boolean;
}

function parseField(
  raw: string,
  min: number,
  max: number,
  label: string,
): { values: Set<number>; wildcard: boolean } {
  const values = new Set<number>();
  let wildcard = false;

  for (const part of raw.split(',')) {
    if (part === '') {
      throw new Error(`Пустое поле cron: ${label}`);
    }

    let body = part;
    let step = 1;
    const slash = part.split('/');

    if (slash.length === 2) {
      body = slash[0]!;
      const parsedStep = Number(slash[1]);

      if (!Number.isInteger(parsedStep) || parsedStep < 1 || parsedStep > max) {
        throw new Error(`Некорректный шаг cron: ${part}`);
      }
      step = parsedStep;
    } else if (slash.length > 2) {
      throw new Error(`Некорректный шаг cron: ${part}`);
    }

    let from: number;
    let to: number;

    if (body === '*') {
      wildcard = step === 1;
      from = min;
      to = max;
    } else {
      const range = body.split('-');

      if (range.length > 2) {
        throw new Error(`Некорректный диапазон cron: ${part}`);
      }
      from = Number(range[0]);
      to = range.length === 2 ? Number(range[1]) : from;
    }

    if (
      !Number.isInteger(from) ||
      !Number.isInteger(to) ||
      from < min ||
      to > max ||
      from > to
    ) {
      throw new Error(`Значение вне диапазона cron (${label}): ${part}`);
    }

    for (let value = from; value <= to; value += step) {
      values.add(value);
    }
  }

  if (values.size === 0) {
    throw new Error(`Пустое поле cron: ${label}`);
  }

  return { values, wildcard };
}

/** Парсит 5-полевое выражение min hour dom month dow. */
export function parseCronExpression(expression: string): CronFields {
  const fields = expression.trim().split(/\s+/);

  if (fields.length !== 5) {
    throw new Error('Ожидается 5 полей cron: min hour dom month dow');
  }

  const minutes = parseField(fields[0]!, 0, 59, 'min');
  const hours = parseField(fields[1]!, 0, 23, 'hour');
  const daysOfMonth = parseField(fields[2]!, 1, 31, 'dom');
  const months = parseField(fields[3]!, 1, 12, 'month');
  // В cron 7 тоже обозначает воскресенье.
  const daysOfWeek = parseField(fields[4]!, 0, 7, 'dow');

  if (daysOfWeek.values.has(7)) {
    daysOfWeek.values.add(0);
    daysOfWeek.values.delete(7);
  }

  return {
    minutes: minutes.values,
    hours: hours.values,
    daysOfMonth: daysOfMonth.values,
    months: months.values,
    daysOfWeek: daysOfWeek.values,
    domWildcard: daysOfMonth.wildcard,
    dowWildcard: daysOfWeek.wildcard,
  };
}

/** Zod-валидация cron-выражения (парсер — источник истины). */
export const cronExpressionSchema = z
  .string()
  .trim()
  .min(5)
  .max(128)
  .refine(
    (value) => {
      try {
        parseCronExpression(value);

        return true;
      } catch {
        return false;
      }
    },
    { message: 'Некорректное cron-выражение' },
  );

interface ZonedParts {
  readonly year: number;
  readonly month: number;
  readonly day: number;
  readonly hour: number;
  readonly minute: number;
  readonly weekday: number;
}

const MINUTE_MS = 60_000;
const MAX_SEARCH_DAYS = 366 * 2;

function zonedParts(date: Date, timeZone: string): ZonedParts {
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
    weekday: 'short',
  });
  const values = new Map(
    formatter.formatToParts(date).map((part) => [part.type, part.value]),
  );
  const weekdays = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

  return {
    year: Number(values.get('year')),
    month: Number(values.get('month')),
    day: Number(values.get('day')),
    hour: Number(values.get('hour')),
    minute: Number(values.get('minute')),
    weekday: weekdays.indexOf(values.get('weekday') ?? 'Sun'),
  };
}

function timezoneOffsetMs(timestamp: number, timeZone: string): number {
  const parts = zonedParts(new Date(timestamp), timeZone);

  return (
    Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute) -
    Math.floor(timestamp / MINUTE_MS) * MINUTE_MS
  );
}

/** Переводит локальное время в UTC с учётом DST (две итерации для переходов). */
function zonedTimeToUtc(
  parts: { year: number; month: number; day: number; hour: number; minute: number },
  timeZone: string,
): number {
  const naive = Date.UTC(
    parts.year,
    parts.month - 1,
    parts.day,
    parts.hour,
    parts.minute,
  );
  const first = naive - timezoneOffsetMs(naive, timeZone);

  return naive - timezoneOffsetMs(first, timeZone);
}

function dayMatches(fields: CronFields, parts: ZonedParts): boolean {
  if (!fields.months.has(parts.month)) {
    return false;
  }

  const dom = fields.daysOfMonth.has(parts.day);
  const dow = fields.daysOfWeek.has(parts.weekday);

  if (fields.domWildcard && fields.dowWildcard) {
    return true;
  }
  if (fields.domWildcard) {
    return dow;
  }
  if (fields.dowWildcard) {
    return dom;
  }

  return dom || dow;
}

/**
 * Детерминированное вычисление следующего срабатывания.
 * Перебор идёт по дням, затем по отсортированным часам и минутам.
 */
export function computeNextCronRun(
  cronExpression: string,
  timezone: string,
  fromDate: Date,
): Date {
  const fields = parseCronExpression(cronExpression);
  // Проверка таймзоны: невалидная зона упадёт до начала перебора.
  zonedParts(fromDate, timezone);

  const minutes = [...fields.minutes].sort((a, b) => a - b);
  const hours = [...fields.hours].sort((a, b) => a - b);
  const fromMinute = Math.floor(fromDate.getTime() / MINUTE_MS) * MINUTE_MS + MINUTE_MS;
  const startDay = new Date(fromMinute);

  for (let dayIndex = 0; dayIndex < MAX_SEARCH_DAYS; dayIndex += 1) {
    const dayCursor = new Date(
      Date.UTC(
        startDay.getUTCFullYear(),
        startDay.getUTCMonth(),
        startDay.getUTCDate() + dayIndex,
        12,
      ),
    );
    const parts = zonedParts(dayCursor, timezone);

    if (!dayMatches(fields, parts)) {
      continue;
    }

    for (const hour of hours) {
      for (const minute of minutes) {
        const timestamp = zonedTimeToUtc(
          {
            year: parts.year,
            month: parts.month,
            day: parts.day,
            hour,
            minute,
          },
          timezone,
        );

        if (timestamp >= fromMinute) {
          return new Date(timestamp);
        }
      }
    }
  }

  throw new Error('Не удалось найти следующее срабатывание cron за 2 года');
}

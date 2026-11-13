import { z } from 'zod';
import { invalidRequestError } from '../../common/api-error.js';
import { mcpProviderError } from '../tools/mcp-gateway.js';

/** Период запроса данных (даты в ISO YYYY-MM-DD). */
export interface FinancePeriod {
  readonly from: string;
  readonly to: string;
}

/** Максимальный период Ozon (сервер обходит начисления по дням). */
export const OZON_MAX_PERIOD_DAYS = 31;

/** Период по умолчанию — последние 30 дней (в UTC). */
export const DEFAULT_PERIOD_DAYS = 30;

export const isoDateSchema = z
  .string()
  .trim()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'ожидается дата YYYY-MM-DD');

/** Сдвиг даты на `days` дней (UTC), результат YYYY-MM-DD. */
export function shiftDate(date: Date, days: number): string {
  const copy = new Date(date.getTime());
  copy.setUTCDate(copy.getUTCDate() + days);

  return copy.toISOString().slice(0, 10);
}

/**
 * Период из аргументов инструмента. По умолчанию — последние 30 дней.
 * Некорректные даты или `from > to` — 400 `errors.invalid_request`.
 */
export function resolvePeriod(
  input: { dateFrom?: string; dateTo?: string },
  now: Date = new Date(),
): FinancePeriod {
  const to = input.dateTo === undefined ? shiftDate(now, 0) : input.dateTo;
  const from =
    input.dateFrom === undefined
      ? shiftDate(now, -DEFAULT_PERIOD_DAYS)
      : input.dateFrom;

  const parsedTo = isoDateSchema.safeParse(to);
  const parsedFrom = isoDateSchema.safeParse(from);

  if (!parsedFrom.success || !parsedTo.success) {
    throw invalidRequestError('Период должен быть в формате YYYY-MM-DD');
  }

  if (parsedFrom.data > parsedTo.data) {
    throw invalidRequestError('dateFrom должен быть не позже dateTo');
  }

  return { from: parsedFrom.data, to: parsedTo.data };
}

/** Число дней в периоде (включительно). */
export function periodDays(period: FinancePeriod): number {
  const from = Date.parse(`${period.from}T00:00:00Z`);
  const to = Date.parse(`${period.to}T00:00:00Z`);

  return Math.floor((to - from) / 86_400_000) + 1;
}

/** Ozon обходит начисления по дням: длиннее 31 дня — явная ошибка. */
export function assertOzonPeriod(period: FinancePeriod): void {
  if (periodDays(period) > OZON_MAX_PERIOD_DAYS) {
    throw invalidRequestError(
      `Ozon: период не может превышать ${OZON_MAX_PERIOD_DAYS} дней`,
    );
  }
}

/** Разбирает JSON-ответ MCP; не-JSON — ошибка провайдера, не пустой результат. */
export function parseMcpJson(
  provider: string,
  action: string,
  text: string,
): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw mcpProviderError(
      `${provider}: ${action} вернул ответ, который не является JSON`,
    );
  }
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Достаёт массив строк из ответа MCP.
 *
 * Провайдеры заворачивают списки по-разному (`data.list`, `report`,
 * `accruals`, `result.data`), поэтому ключи предпочтений задаются вызывающим
 * слоем, а затем выполняется ограниченный рекурсивный поиск массива объектов.
 */
export function extractRows(
  payload: unknown,
  preferredKeys: readonly string[] = [],
  depth = 0,
): Record<string, unknown>[] {
  if (Array.isArray(payload)) {
    return payload.filter(isRecord);
  }

  if (!isRecord(payload) || depth > 4) {
    return [];
  }

  for (const key of preferredKeys) {
    const value = payload[key];

    if (Array.isArray(value)) {
      return value.filter(isRecord);
    }

    if (isRecord(value)) {
      const nested = extractRows(value, preferredKeys, depth + 1);

      if (nested.length > 0) {
        return nested;
      }
    }
  }

  for (const value of Object.values(payload)) {
    if (Array.isArray(value)) {
      const rows = value.filter(isRecord);

      if (rows.length > 0) {
        return rows;
      }
    }

    if (isRecord(value)) {
      const nested = extractRows(value, preferredKeys, depth + 1);

      if (nested.length > 0) {
        return nested;
      }
    }
  }

  return [];
}

/** Число из MCP: number, строка с точкой/запятой или `{amount: string}`. */
export function toNumber(value: unknown): number | null {
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : null;
  }

  if (typeof value === 'string') {
    const normalized = value.trim().replace(/\s/g, '').replace(',', '.');
    const parsed = Number(normalized);

    return Number.isFinite(parsed) ? parsed : null;
  }

  if (isRecord(value)) {
    return toNumber(value.amount ?? value.value ?? value.sum);
  }

  return null;
}

/** Числовое поле по списку возможных имён (camelCase/snake_case). */
export function readNumber(
  record: Record<string, unknown>,
  keys: readonly string[],
): number | null {
  for (const key of keys) {
    if (key in record) {
      const parsed = toNumber(record[key]);

      if (parsed !== null) {
        return parsed;
      }
    }
  }

  return null;
}

/** Строковое поле по списку возможных имён. */
export function readString(
  record: Record<string, unknown>,
  keys: readonly string[],
): string | null {
  for (const key of keys) {
    const value = record[key];

    if (typeof value === 'string' && value.trim() !== '') {
      return value;
    }

    if (typeof value === 'number' && Number.isFinite(value)) {
      return String(value);
    }
  }

  return null;
}

/**
 * Ищет маркер (ERID/UTM) в ключах и строковых значениях ответа MCP.
 * Регистр не важен; глубина ограничена, чтобы не обходить гигантские ответы.
 */
export function containsMarker(
  payload: unknown,
  markers: readonly string[],
  depth = 0,
): boolean {
  if (depth > 6) {
    return false;
  }

  const normalizedMarkers = markers.map((marker) => marker.toLowerCase());

  if (typeof payload === 'string') {
    const lower = payload.toLowerCase();

    return normalizedMarkers.some((marker) => lower.includes(marker));
  }

  if (Array.isArray(payload)) {
    return payload.some((item) => containsMarker(item, markers, depth + 1));
  }

  if (!isRecord(payload)) {
    return false;
  }

  for (const [key, value] of Object.entries(payload)) {
    if (
      normalizedMarkers.some((marker) => key.toLowerCase().includes(marker))
    ) {
      return true;
    }

    if (containsMarker(value, markers, depth + 1)) {
      return true;
    }
  }

  return false;
}

/** Ошибка провайдера: MCP вернул данные без ожидаемых полей. */

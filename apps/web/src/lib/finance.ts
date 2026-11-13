import { isAxiosError } from 'axios';
import { z } from 'zod';
import { api } from './api';

/**
 * Финансовый дашборд (Sprint 19, Track J).
 *
 * Backend-поля взяты из `FinanceToolsService`: `unit-economics`,
 * `profit-leak-detector` и `fraud-shield-audit` возвращают такие объекты в
 * ответе инструмента. UI ожидает агрегирующий `GET /finance/overview`; если
 * его нет, пробует `/finance/unit-economics`, `/finance/profit-leaks` и
 * `/finance/fraud-shield`. В текущей ветке API REST-контроллера ещё нет —
 * см. KI-060.
 */
export const financePeriodSchema = z.object({
  from: z.string().trim().min(1),
  to: z.string().trim().min(1),
});

export const financeFindingSchema = z.object({
  code: z.string().trim().min(1),
  severity: z.enum(['low', 'medium', 'high']),
  amount: z.number().finite().optional(),
  detail: z.string().trim().min(1),
  source: z.string().trim().min(1),
});

export type FinanceFinding = z.infer<typeof financeFindingSchema>;

export const unitEconomicsResultSchema = z.object({
  tool: z.literal('unit-economics').optional(),
  marketplace: z.enum(['ozon', 'wb']),
  sku: z.string().trim().min(1),
  period: financePeriodSchema.optional(),
  dataAvailable: z.boolean(),
  reason: z.string().optional(),
  units: z.number().finite().optional(),
  revenue: z.number().finite().optional(),
  revenueCurrency: z.literal('RUB').optional(),
  costs: z
    .object({
      commission: z.number().finite(),
      logistics: z.number().finite(),
      returns: z.number().finite(),
      storage: z.number().finite(),
      penalties: z.number().finite(),
      acquiring: z.number().finite(),
    })
    .optional(),
  costOfGoods: z.number().finite().nullable().optional(),
  /** Прибыль в рублях (так поле называет backend). */
  margin: z.number().finite().optional(),
  marginPercent: z.number().finite().optional(),
  perUnit: z
    .object({
      price: z.number().finite().nullable(),
      margin: z.number().finite().nullable(),
      cost: z.number().finite().nullable(),
    })
    .optional(),
  assumptions: z.array(z.string()).optional(),
  sources: z.array(z.string()).optional(),
});

export type UnitEconomicsResult = z.infer<typeof unitEconomicsResultSchema>;

export const profitLeakResultSchema = z.object({
  tool: z.literal('profit-leak-detector').optional(),
  marketplace: z.enum(['ozon', 'wb']),
  period: financePeriodSchema.optional(),
  dataAvailable: z.boolean(),
  reason: z.string().optional(),
  totals: z
    .object({
      penalties: z.number().finite().optional(),
      deductions: z.number().finite().optional(),
      returns: z.number().finite().optional(),
      logistics: z.number().finite().optional(),
      storage: z.number().finite().optional(),
    })
    .optional(),
  findings: z.array(financeFindingSchema).default([]),
  sources: z.array(z.string()).optional(),
});

export type ProfitLeakResult = z.infer<typeof profitLeakResultSchema>;

export const fraudAuditResultSchema = z.object({
  tool: z.literal('fraud-shield-audit').optional(),
  marketplace: z.enum(['ozon', 'wb']).optional(),
  campaignId: z.string().optional(),
  period: financePeriodSchema.optional(),
  dataAvailable: z.boolean(),
  reason: z.string().optional(),
  eridPresent: z.boolean().optional(),
  utmPresent: z.boolean().optional(),
  findings: z.array(financeFindingSchema).default([]),
  checks: z
    .array(z.object({ id: z.string(), passed: z.boolean() }))
    .default([]),
  sources: z.array(z.string()).optional(),
});

export type FraudAuditResult = z.infer<typeof fraudAuditResultSchema>;

function oneOrMany<T extends z.ZodType<unknown>>(schema: T) {
  return z.union([
    z.array(schema),
    schema.transform((value) => [value]),
    z.object({ items: z.array(schema) }).transform((value) => value.items),
  ]);
}

export const financeOverviewSchema = z.object({
  currency: z.string().trim().min(1).default('RUB'),
  period: z.union([z.string(), financePeriodSchema]).optional(),
  unitEconomics: oneOrMany(unitEconomicsResultSchema).default([]),
  profitLeaks: oneOrMany(profitLeakResultSchema).default([]),
  fraudShield: fraudAuditResultSchema.nullable().optional(),
});

export type FinanceOverview = z.infer<typeof financeOverviewSchema>;

export const financeQueryKey = ['finance', 'overview'] as const;

export async function fetchFinanceOverview(): Promise<FinanceOverview> {
  try {
    const { data } = await api.get<unknown>('/finance/overview');

    return financeOverviewSchema.parse(data);
  } catch (error) {
    if (!isAxiosError(error) || error.response?.status !== 404) {
      throw error;
    }

    const [unitEconomics, profitLeaks, fraudShield] = await Promise.all([
      api.get<unknown>('/finance/unit-economics'),
      api.get<unknown>('/finance/profit-leaks'),
      api.get<unknown>('/finance/fraud-shield'),
    ]);

    const parsed = financeOverviewSchema.parse({
      unitEconomics: unitEconomics.data,
      profitLeaks: profitLeaks.data,
      fraudShield: fraudShield.data,
    });
    const firstPeriod = parsed.unitEconomics[0]?.period;

    return parsed.period === undefined && firstPeriod !== undefined
      ? { ...parsed, period: firstPeriod }
      : parsed;
  }
}

export type FraudShieldStatus = 'complete' | 'risks' | 'unknown';

/** Статус evidence package выводится из фактических findings/checks. */
export function getFraudShieldStatus(
  audit: FraudAuditResult | null | undefined,
): FraudShieldStatus {
  if (audit === null || audit === undefined || !audit.dataAvailable) {
    return 'unknown';
  }

  if (
    audit.findings.length > 0 ||
    audit.checks.some((check) => !check.passed)
  ) {
    return 'risks';
  }

  return 'complete';
}

export function getFraudShieldRisks(
  audit: FraudAuditResult | null | undefined,
): string[] {
  if (audit === null || audit === undefined) {
    return [];
  }

  return audit.findings.map((finding) => finding.detail);
}

/** Сумма абсолютной прибыли (`margin`) по доступным SKU. */
export function sumUnitEconomicsMargin(
  items: readonly UnitEconomicsResult[],
): number {
  return items.reduce(
    (total, item) => total + (item.dataAvailable ? (item.margin ?? 0) : 0),
    0,
  );
}

export function sumUnitEconomicsRevenue(
  items: readonly UnitEconomicsResult[],
): number {
  return items.reduce(
    (total, item) => total + (item.dataAvailable ? (item.revenue ?? 0) : 0),
    0,
  );
}

export function getTotalMarginPercent(
  items: readonly UnitEconomicsResult[],
): number | null {
  const revenue = sumUnitEconomicsRevenue(items);

  if (revenue === 0) {
    return null;
  }

  return (sumUnitEconomicsMargin(items) / revenue) * 100;
}

export function getProfitLeakFindings(
  results: readonly ProfitLeakResult[],
): FinanceFinding[] {
  return results.flatMap((result) =>
    result.dataAvailable ? result.findings : [],
  );
}

export type FinanceErrorKind =
  | 'network'
  | 'sessionExpired'
  | 'forbidden'
  | 'notFound'
  | 'unavailable'
  | 'invalidResponse'
  | 'unknown';

export interface FinanceErrorDetails {
  kind: FinanceErrorKind;
  serverMessage: string | null;
}

const errorPayloadSchema = z.object({
  code: z.string().optional(),
  message: z.union([z.string(), z.array(z.string())]).optional(),
});

function readServerMessage(value: unknown): string | null {
  const parsed = errorPayloadSchema.safeParse(value);

  if (!parsed.success) {
    return null;
  }

  const { code, message } = parsed.data;

  if (typeof code === 'string' && code.startsWith('errors.')) {
    return code;
  }

  if (typeof message === 'string' && message.trim() !== '') {
    return message.trim();
  }

  if (Array.isArray(message)) {
    const joined = message
      .map((item) => item.trim())
      .filter((item) => item !== '')
      .join('; ');

    return joined === '' ? null : joined;
  }

  return null;
}

export function getFinanceErrorDetails(
  error: unknown,
): FinanceErrorDetails {
  if (error instanceof z.ZodError) {
    return { kind: 'invalidResponse', serverMessage: null };
  }

  if (!isAxiosError(error)) {
    return { kind: 'unknown', serverMessage: null };
  }

  if (error.response === undefined) {
    return { kind: 'network', serverMessage: null };
  }

  const serverMessage = readServerMessage(error.response.data);
  const { status } = error.response;

  if (status === 401) {
    return { kind: 'sessionExpired', serverMessage };
  }

  if (status === 403) {
    return { kind: 'forbidden', serverMessage };
  }

  if (status === 404) {
    return { kind: 'notFound', serverMessage };
  }

  if (status === 502 || status === 503) {
    return { kind: 'unavailable', serverMessage };
  }

  return { kind: 'unknown', serverMessage };
}

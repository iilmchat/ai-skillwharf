import { z } from 'zod';

/**
 * REST-контракт финансового дашборда.
 *
 * Синхронизирован с Zod-схемами UI из `apps/web/src/lib/finance.ts`:
 * UI парсит ответы `/finance/*` теми же полями. Отличия только в
 * `.passthrough()`: API не отбрасывает дополнительные поля инструментов
 * (`spend`, `adSpend`, `deductions`, `antifraudRecords`), которые UI
 * игнорирует, но они полезны в отладке.
 */
export const financePeriodSchema = z.object({
  from: z.string().trim().min(1),
  to: z.string().trim().min(1),
});

export const financeFindingSchema = z
  .object({
    code: z.string().trim().min(1),
    severity: z.enum(['low', 'medium', 'high']),
    amount: z.number().finite().optional(),
    detail: z.string().trim().min(1),
    source: z.string().trim().min(1),
  })
  .passthrough();

export const unitEconomicsResultSchema = z
  .object({
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
  })
  .passthrough();

export const profitLeakResultSchema = z
  .object({
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
  })
  .passthrough();

export const fraudAuditResultSchema = z
  .object({
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
  })
  .passthrough();

export const financeOverviewResponseSchema = z.object({
  currency: z.string().trim().min(1).default('RUB'),
  period: z.union([z.string(), financePeriodSchema]).optional(),
  unitEconomics: z.array(unitEconomicsResultSchema).default([]),
  profitLeaks: z.array(profitLeakResultSchema).default([]),
  fraudShield: fraudAuditResultSchema.nullable().optional(),
  /** Дополнительно к UI-схеме: честный признак отсутствия данных. */
  dataAvailable: z.boolean().optional(),
  reason: z.string().optional(),
  updatedAt: z.string().optional(),
});

export type FinanceOverviewResponse = z.infer<
  typeof financeOverviewResponseSchema
>;

const optionalTrimmedString = (max: number) =>
  z.preprocess(
    (value) =>
      typeof value === 'string' && value.trim() === ''
        ? undefined
        : typeof value === 'string'
          ? value.trim()
          : value,
    z.string().min(1).max(max).optional(),
  );

const optionalMoney = z.preprocess(
  (value) => (value === '' || value === undefined ? undefined : value),
  z.coerce.number().nonnegative().max(100_000_000).optional(),
);

const optionalDate = z.preprocess(
  (value) => (value === '' || value === undefined ? undefined : value),
  z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, 'ожидается дата YYYY-MM-DD')
    .optional(),
);

export const unitEconomicsQuerySchema = z
  .object({
    sku: optionalTrimmedString(256),
    marketplace: z.enum(['ozon', 'wb']).optional(),
    cost: optionalMoney,
    price: optionalMoney,
    dateFrom: optionalDate,
    dateTo: optionalDate,
    sellerId: optionalTrimmedString(64),
  })
  .strict();

export const profitLeaksQuerySchema = z
  .object({
    sellerId: optionalTrimmedString(64),
    marketplace: z.enum(['ozon', 'wb']).optional(),
    dateFrom: optionalDate,
    dateTo: optionalDate,
  })
  .strict();

export const fraudShieldQuerySchema = z
  .object({
    campaignId: optionalTrimmedString(128),
    marketplace: z.enum(['ozon', 'wb']).optional(),
    dateFrom: optionalDate,
    dateTo: optionalDate,
    sellerId: optionalTrimmedString(64),
  })
  .strict();

export type UnitEconomicsQuery = z.infer<typeof unitEconomicsQuerySchema>;
export type ProfitLeaksQuery = z.infer<typeof profitLeaksQuerySchema>;
export type FraudShieldQuery = z.infer<typeof fraudShieldQuerySchema>;

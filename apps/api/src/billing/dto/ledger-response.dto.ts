import { z } from 'zod';

/**
 * Дата в ответе Ledger: строка ISO 8601, которую клиент проверяет тем же
 * `Date.parse`, что и остальные read-API (контракт Sprint 14).
 */
const IsoDateTimeSchema = z
  .string()
  .refine((value) => !Number.isNaN(Date.parse(value)), {
    message: 'ожидается дата в формате ISO 8601',
  });

/** Запись истории операций в ответе `GET /api/v1/billing/ledger`. */
export const LedgerItemSchema = z.object({
  id: z.string().min(1),
  amount: z.string().min(1),
  balanceAfter: z.string().min(1),
  type: z.string().min(1),
  description: z.string(),
  createdAt: IsoDateTimeSchema,
});

/**
 * Ответ `GET /api/v1/billing/ledger`: страница записей, их общее количество
 * (`total`, а не длина страницы) и курсор следующей страницы либо `null`.
 */
export const LedgerPageSchema = z.object({
  items: z.array(LedgerItemSchema),
  total: z.number().int().nonnegative(),
  nextCursor: z.string().min(1).nullable(),
});

export type LedgerItem = z.infer<typeof LedgerItemSchema>;
export type LedgerPage = z.infer<typeof LedgerPageSchema>;

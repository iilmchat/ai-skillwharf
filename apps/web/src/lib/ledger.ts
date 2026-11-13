import { z } from 'zod';
import { api } from './api';

/**
 * Контракт истории операций Ledger (`GET /api/v1/billing/ledger`).
 *
 * Keyset-пагинация: сервер отдаёт страницу записей и opaque-курсор
 * `nextCursor` следующей страницы. Ответ валидируется Zod: при расхождении
 * контракта UI показывает ошибку, а не вымышленные строки.
 */
export const ledgerEntrySchema = z.object({
  id: z.string().min(1),
  amount: z.string(),
  balanceAfter: z.string(),
  type: z.string(),
  description: z.string(),
  createdAt: z.string().refine((value) => !Number.isNaN(Date.parse(value)), {
    message: 'ожидается дата в формате ISO 8601',
  }),
});

export const ledgerPageSchema = z.object({
  items: z.array(ledgerEntrySchema),
  total: z.number().int().nonnegative(),
  /** Opaque-курсор следующей страницы; `null` — история закончилась. */
  nextCursor: z.string().min(1).nullable(),
});

export type LedgerEntry = z.infer<typeof ledgerEntrySchema>;
export type LedgerPage = z.infer<typeof ledgerPageSchema>;

/** Ключ кэша истории операций (infinite-query: все страницы в одном кэше). */
export const ledgerQueryKey = ['ledger'] as const;

/**
 * Склеивает страницы keyset-пагинации в плоский список.
 *
 * Дубликаты по `id` отбрасываются на случай повторной подгрузки одной и той
 * же страницы: уже показанные записи не теряются и не удваиваются.
 */
export function collectLedgerEntries(
  pages: readonly LedgerPage[],
): LedgerEntry[] {
  const seen = new Set<string>();
  const entries: LedgerEntry[] = [];

  for (const page of pages) {
    for (const entry of page.items) {
      if (seen.has(entry.id)) {
        continue;
      }

      seen.add(entry.id);
      entries.push(entry);
    }
  }

  return entries;
}

/**
 * Одна страница истории операций.
 *
 * `cursor` — opaque-значение из `nextCursor` предыдущей страницы; `null` —
 * первая страница.
 */
export async function fetchLedgerPage(
  cursor: string | null,
): Promise<LedgerPage> {
  const { data } = await api.get<unknown>('/billing/ledger', {
    params: cursor === null ? undefined : { cursor },
  });

  return ledgerPageSchema.parse(data);
}

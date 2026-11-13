import { z } from 'zod';

/** Размер страницы истории Ledger по умолчанию. */
export const LEDGER_PAGE_DEFAULT_LIMIT = 20;

/** Максимальный размер страницы: защита от выгрузки всей истории разом. */
export const LEDGER_PAGE_MAX_LIMIT = 100;

/** Максимальное смещение: защита от дорогих `OFFSET`-запросов. */
export const LEDGER_PAGE_MAX_OFFSET = 10_000;

/** Максимальная длина opaque-курсора (base64url от короткого JSON). */
export const LEDGER_CURSOR_MAX_LENGTH = 200;

/** Дата ISO 8601, которую принимает курсор. */
const IsoDateTimeSchema = z
  .string()
  .refine((value) => !Number.isNaN(Date.parse(value)), {
    message: 'ожидается дата в формате ISO 8601',
  });

/**
 * Позиция в append-only истории: запись с таким `createdAt` и `id` уже
 * отдана клиенту, следующая страница начинается строго после неё.
 */
export const LedgerCursorSchema = z
  .object({
    createdAt: IsoDateTimeSchema,
    id: z.string().min(1),
  })
  .strict();

export type LedgerCursor = z.infer<typeof LedgerCursorSchema>;

/** Кодирует позицию в opaque base64url-курсор (клиент его не разбирает). */
export function encodeLedgerCursor(cursor: LedgerCursor): string {
  return Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url');
}

/** Декодирует opaque-курсор; `null` — курсор битый или чужого формата. */
export function decodeLedgerCursor(encoded: string): LedgerCursor | null {
  try {
    const decoded: unknown = JSON.parse(
      Buffer.from(encoded, 'base64url').toString('utf8'),
    );
    const parsed = LedgerCursorSchema.safeParse(decoded);

    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/**
 * Курсор приходит строкой и сразу превращается в позицию. Битый курсор —
 * ошибка клиента (400), а не падение сервиса.
 */
const CursorSchema = z
  .string()
  .max(LEDGER_CURSOR_MAX_LENGTH)
  .transform((encoded, ctx) => {
    const cursor = decodeLedgerCursor(encoded);

    if (cursor === null) {
      ctx.addIssue({
        code: 'custom',
        message: 'cursor не декодируется: ожидается opaque base64url-курсор',
      });

      return z.NEVER;
    }

    return cursor;
  });

/**
 * Query-параметры `GET /api/v1/billing/ledger`.
 *
 * `strict()` фиксирует контракт: неизвестные параметры отклоняются. `offset`
 * и `cursor` — две альтернативные стратегии страниц, вместе их передавать
 * нельзя (иначе неясно, от какой позиции считать).
 */
export const LedgerQuerySchema = z
  .object({
    limit: z.coerce
      .number()
      .int()
      .min(1)
      .max(LEDGER_PAGE_MAX_LIMIT)
      .default(LEDGER_PAGE_DEFAULT_LIMIT),
    offset: z.coerce
      .number()
      .int()
      .min(0)
      .max(LEDGER_PAGE_MAX_OFFSET)
      .default(0),
    cursor: CursorSchema.optional(),
  })
  .strict()
  .superRefine((query, ctx) => {
    if (query.cursor !== undefined && query.offset > 0) {
      ctx.addIssue({
        code: 'custom',
        path: ['cursor'],
        message: 'cursor и offset нельзя передавать одновременно',
      });
    }
  });

export type LedgerQuery = z.infer<typeof LedgerQuerySchema>;

import { z } from 'zod';

/** Размер страницы read-API памяти по умолчанию. */
export const MEMORY_PAGE_DEFAULT_LIMIT = 20;

/** Максимальный размер страницы: защита от выгрузки всей памяти разом. */
export const MEMORY_PAGE_MAX_LIMIT = 100;

/** Максимальное смещение: защита от дорогих `OFFSET`-запросов. */
export const MEMORY_PAGE_MAX_OFFSET = 10_000;

/**
 * Query-параметры `GET /api/v1/chat/memory`.
 *
 * `strict()` фиксирует контракт: неизвестные параметры (в том числе
 * `userId`) отклоняются, чтобы клиент не мог влиять на выборку в обход JWT.
 */
export const MemoryQuerySchema = z
  .object({
    limit: z.coerce
      .number()
      .int()
      .min(1)
      .max(MEMORY_PAGE_MAX_LIMIT)
      .default(MEMORY_PAGE_DEFAULT_LIMIT),
    offset: z.coerce
      .number()
      .int()
      .min(0)
      .max(MEMORY_PAGE_MAX_OFFSET)
      .default(0),
  })
  .strict();

export type MemoryQuery = z.infer<typeof MemoryQuerySchema>;

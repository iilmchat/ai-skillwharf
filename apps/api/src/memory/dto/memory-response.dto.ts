import { z } from 'zod';

/**
 * Дата в ответе read-API: строка ISO 8601, которую клиент проверяет тем же
 * `Date.parse`, что и `apps/web/src/lib/rag-memory.ts` (контракт Sprint 14).
 */
const IsoDateTimeSchema = z
  .string()
  .refine((value) => !Number.isNaN(Date.parse(value)), {
    message: 'ожидается дата в формате ISO 8601',
  });

/** Фрагмент памяти в ответе `GET /api/v1/chat/memory`. */
export const MemoryItemSchema = z.object({
  id: z.string().min(1),
  content: z.string().min(1),
  createdAt: IsoDateTimeSchema,
});

/** Ответ `GET /api/v1/chat/memory`: страница фрагментов и общее количество. */
export const MemoryListResponseSchema = z.object({
  items: z.array(MemoryItemSchema),
  total: z.number().int().nonnegative(),
});

export type MemoryItemDto = z.infer<typeof MemoryItemSchema>;
export type MemoryListResponse = z.infer<typeof MemoryListResponseSchema>;

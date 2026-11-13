import { isAxiosError } from 'axios';
import { z } from 'zod';
import { api } from './api';

/**
 * Контракт чтения RAG-памяти.
 *
 * Sprint 14 фиксирует контракт `GET /api/v1/chat/memory`:
 * `{ items: [{ id, content, createdAt }], total? }`. Схема описывает только
 * те поля, которые реально есть в модели `MemoryChunk` (KI-024), и валидирует
 * ответ Zod: при расхождении контракта панель показывает ошибку, а не
 * вымышленные или частично распарсенные записи.
 */
export const memoryEntrySchema = z.object({
  id: z.string().min(1),
  content: z.string().min(1),
  createdAt: z.string().refine((value) => !Number.isNaN(Date.parse(value)), {
    message: 'ожидается дата в формате ISO 8601',
  }),
});

export const memoryListSchema = z.object({
  items: z.array(memoryEntrySchema),
  total: z.number().int().nonnegative().optional(),
});

export type MemoryEntry = z.infer<typeof memoryEntrySchema>;
export type MemoryList = z.infer<typeof memoryListSchema>;

export const ragMemoryQueryKey = ['rag-memory'] as const;

export async function fetchMemoryEntries(): Promise<MemoryList> {
  const { data } = await api.get<unknown>('/chat/memory');

  return memoryListSchema.parse(data);
}

/** Категория ошибки — по ней панель выбирает локализованный текст. */
export type RagMemoryErrorKind =
  'unauthorized' | 'unavailable' | 'network' | 'invalid' | 'unknown';

export function getRagMemoryErrorKind(error: unknown): RagMemoryErrorKind {
  if (error instanceof z.ZodError) {
    return 'invalid';
  }

  if (isAxiosError(error)) {
    if (error.response === undefined) {
      return 'network';
    }

    if (error.response.status === 401) {
      return 'unauthorized';
    }

    if (error.response.status === 404) {
      // Read-эндпоинт ещё не задеплоен (KI-023) — это ожидаемое состояние,
      // пока бэкенд Sprint 14 не выкатил `GET /api/v1/chat/memory`.
      return 'unavailable';
    }
  }

  return 'unknown';
}

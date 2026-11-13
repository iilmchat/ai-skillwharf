import { isAxiosError } from 'axios';
import { z } from 'zod';
import { api } from './api';

/**
 * Контракт чтения RAG-памяти.
 *
 * Эндпоинт `GET /api/v1/chat/memory` пока не реализован (KI-023). Схема
 * описывает только те поля, которые реально есть в модели `MemoryChunk`:
 * `id`, `content` и `createdAt`. Ответ валидируется Zod, поэтому при
 * расхождении контракта UI покажет ошибку, а не вымышленные записи.
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
      // Эндпоинт ещё не появился в API — это ожидаемое состояние до KI-023.
      return 'unavailable';
    }
  }

  return 'unknown';
}

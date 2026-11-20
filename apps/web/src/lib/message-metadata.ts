import { z } from 'zod';
import { artifactItemSchema, executionStepSchema } from './artifacts';

/**
 * Метаданные ответа ассистента (Sprint 30, CACHE-30.1; Sprint 37, UX-37.1/37.3).
 *
 * Поля необязательны: старый API не присылает метаданные вовсе, поэтому
 * отсутствие новых полей не должно ломать ленту сообщений. Невалидные
 * артефакты или шаги трассировки отбрасываются целиком парсером ниже.
 */
/** Сноска на фрагмент документа в ответе ассистента (KB-38.2). */
export const citationSchema = z.object({
  index: z.number(),
  chunkId: z.string(),
  title: z.string(),
  snippet: z.string(),
  pageNumber: z.number().optional(),
});

export const assistantMessageMetadataSchema = z.object({
  cacheHit: z.boolean().optional(),
  artifacts: z.array(artifactItemSchema).optional(),
  executionTrace: z.array(executionStepSchema).optional(),
  citations: z.array(citationSchema).optional(),
});

export type Citation = z.infer<typeof citationSchema>;
export type AssistantMessageMetadata = z.infer<
  typeof assistantMessageMetadataSchema
>;

/** Возвращает только валидные метаданные; невалидные игнорируются. */
export function parseAssistantMessageMetadata(
  value: unknown,
): AssistantMessageMetadata {
  const parsed = assistantMessageMetadataSchema.safeParse(value);

  return parsed.success ? parsed.data : {};
}

/** Признак того, что рядом с ответом нужно показать бейдж кеша. */
export function isCacheHitMessage(message: {
  metadata?: AssistantMessageMetadata;
}): boolean {
  return message.metadata?.cacheHit === true;
}

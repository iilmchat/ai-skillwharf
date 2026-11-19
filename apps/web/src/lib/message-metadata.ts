import { z } from 'zod';

/**
 * Метаданные ответа ассистента (Sprint 30, CACHE-30.1).
 *
 * Поля необязательны: старый API не присылает метаданные вовсе, поэтому
 * отсутствие новых полей не должно ломать ленту сообщений.
 */
export const assistantMessageMetadataSchema = z.object({
  cacheHit: z.boolean().optional(),
});

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

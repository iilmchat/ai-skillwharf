import { z } from 'zod';
import { artifactItemSchema, executionStepSchema } from './artifacts';

/**
 * Метаданные ответа ассистента (Sprint 30, CACHE-30.1; Sprint 37, UX-37.1/37.3).
 *
 * Поля необязательны: старый API не присылает метаданные вовсе, поэтому
 * отсутствие новых полей не должно ломать ленту сообщений. Невалидные
 * артефакты или шаги трассировки отбрасываются целиком парсером ниже.
 */
export const assistantMessageMetadataSchema = z.object({
  cacheHit: z.boolean().optional(),
  artifacts: z.array(artifactItemSchema).optional(),
  executionTrace: z.array(executionStepSchema).optional(),
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

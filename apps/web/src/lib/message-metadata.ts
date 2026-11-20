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

/** Уровень модели из Smart Model Cascade (Sprint 44, CASCADE-44.1). */
export const modelTierSchema = z.enum(['lite', 'standard', 'flagship']);

export const assistantMessageMetadataSchema = z.object({
  cacheHit: z.boolean().optional(),
  artifacts: z.array(artifactItemSchema).optional(),
  executionTrace: z.array(executionStepSchema).optional(),
  citations: z.array(citationSchema).optional(),
  /** Сколько ПДн обезличено перед отправкой во внешнюю LLM (152-ФЗ). */
  piiMaskedCount: z.number().int().nonnegative().optional(),
  modelTier: modelTierSchema.optional(),
});

export type Citation = z.infer<typeof citationSchema>;
export type ModelTier = z.infer<typeof modelTierSchema>;
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

/**
 * Количество ПДн для бейджа 152-ФЗ: `0` означает, что бейдж не показывается.
 * Отрицательные и дробные значения отсекает Zod-схема метаданных.
 */
export function getPiiMaskedBadgeCount(metadata?: AssistantMessageMetadata): number {
  const count = metadata?.piiMaskedCount;

  return typeof count === 'number' && count > 0 ? count : 0;
}

/** Уровень модели для бейджа Smart Cascade или `null`, если его нет. */
export function getModelTier(
  metadata?: AssistantMessageMetadata,
): ModelTier | null {
  return metadata?.modelTier ?? null;
}

/** Ключ i18n для подписи уровня модели. */
export function getModelTierLabelKey(tier: ModelTier): string {
  return `chat.modelTier.${tier}`;
}

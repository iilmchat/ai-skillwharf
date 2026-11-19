import { z } from 'zod';

export const TRIGGER_SOURCES = ['bitrix24', 'moysklad', '1c', 'custom'] as const;
export const triggerSourceSchema = z.enum(TRIGGER_SOURCES);
export type TriggerSource = z.infer<typeof triggerSourceSchema>;

export const createTriggerSchema = z.object({
  name: z.string().trim().min(1).max(128),
  source: triggerSourceSchema,
  promptTemplate: z.string().trim().min(1).max(4_000),
});

/** Входящий payload: JSON-объект до 32 КБ в сериализованном виде. */
export const triggerPayloadSchema = z
  .unknown()
  .refine((value) => value !== null && typeof value === 'object' && !Array.isArray(value), {
    message: 'ожидается JSON-объект',
  });

export const MAX_TRIGGER_PAYLOAD_BYTES = 32 * 1024;

/**
 * Ответ каталога триггеров. Поля `promptTemplate` и `status` обязательны для
 * UI-контракта (`apps/web/src/lib/triggers.ts` → `triggerSchema`): Zod-схема
 * витрины отклоняет ответ без них. Лишние поля (`workspaceId`, `isActive`,
 * `lastTriggeredAt`) UI отбрасывает — они остаются для Control Plane API.
 */
export const triggerViewSchema = z.object({
  id: z.string(),
  workspaceId: z.string(),
  name: z.string(),
  slug: z.string(),
  source: triggerSourceSchema,
  promptTemplate: z.string(),
  status: z.enum(['active', 'paused']),
  isActive: z.boolean(),
  lastTriggeredAt: z.string().nullable(),
  triggerCount: z.number().int().nonnegative(),
  createdAt: z.string(),
});

export type TriggerView = z.infer<typeof triggerViewSchema>;

/**
 * Ответ POST /triggers: UI ожидает одноразовый `secret` (и опциональный
 * `webhookUrl`) в той же карточке триггера.
 */
export const createdTriggerViewSchema = triggerViewSchema.extend({
  secret: z.string().min(1),
  webhookUrl: z.string().nullable().optional(),
});

export type CreatedTriggerView = z.infer<typeof createdTriggerViewSchema>;

import { z } from 'zod';
import { api } from './api';

/**
 * Контракт `GET /api/v1/chat/pending`.
 *
 * Эндпоинт перечисляет диалоги пользователя, которые ждут `approve_action`
 * (HITL) и переживают рестарт API. `expiresAt` — необязательный TTL
 * ожидания: старый API поле не присылает, поэтому таймер в UI показывается
 * только когда оно есть. Ответ валидируется Zod, чтобы UI не зависел от
 * внутренних полей БД.
 */
const isoDateTimeSchema = z
  .string()
  .refine((value) => !Number.isNaN(Date.parse(value)), {
    message: 'ожидается дата в формате ISO 8601',
  });

export const pendingApprovalItemSchema = z.object({
  conversationId: z.string().min(1),
  reason: z.enum(['approval', 'payment']),
  tools: z.array(z.string().min(1)),
  createdAt: isoDateTimeSchema,
  /** Срок, до которого ожидание действительно (TTL). */
  expiresAt: isoDateTimeSchema.optional(),
});

export const pendingApprovalListSchema = z.object({
  items: z.array(pendingApprovalItemSchema),
});

export type PendingApproval = z.infer<typeof pendingApprovalItemSchema>;
export type PendingApprovalList = z.infer<typeof pendingApprovalListSchema>;

/** Ключ кэша списка ожиданий; инвалидируется после `approve_action`. */
export const pendingApprovalsQueryKey = ['chat', 'pending'] as const;

export async function fetchPendingApprovals(): Promise<PendingApprovalList> {
  const { data } = await api.get<unknown>('/chat/pending');

  return pendingApprovalListSchema.parse(data);
}

/** Готовая к локализации величина оставшегося TTL ожидания. */
export type PendingTtl =
  | { kind: 'hours'; value: number }
  | { kind: 'minutes'; value: number }
  | { kind: 'expired' };

/**
 * Оставшееся время ожидания по `expiresAt`.
 *
 * - `null` — TTL нет (старый API) или дата не разбирается: таймер не нужен;
 * - часы — пока осталось не меньше часа (полные часы, как «Осталось 23 ч»);
 * - минуты — меньше часа (округление вверх, чтобы не показывать «0 мин»);
 * - `expired` — срок уже истёк.
 */
export function getPendingTtl(
  expiresAt: string | undefined,
  nowMs: number = Date.now(),
): PendingTtl | null {
  if (expiresAt === undefined) {
    return null;
  }

  const expiresAtMs = Date.parse(expiresAt);

  if (Number.isNaN(expiresAtMs)) {
    return null;
  }

  const remainingMs = expiresAtMs - nowMs;

  if (remainingMs <= 0) {
    return { kind: 'expired' };
  }

  if (remainingMs >= 3_600_000) {
    return {
      kind: 'hours',
      value: Math.max(1, Math.floor(remainingMs / 3_600_000)),
    };
  }

  return {
    kind: 'minutes',
    value: Math.max(1, Math.ceil(remainingMs / 60_000)),
  };
}

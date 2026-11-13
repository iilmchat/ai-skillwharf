import { z } from 'zod';

/**
 * Контракт `GET /api/v1/chat/pending`.
 *
 * Эндпоинт перечисляет диалоги пользователя, которые стоят на паузе
 * `waiting_approval` (HITL) и переживают рестарт API. Ответ валидируется
 * Zod-схемой, чтобы клиент не зависел от внутренних полей БД.
 */
export const pendingApprovalItemSchema = z
  .object({
    conversationId: z.string().min(1),
    reason: z.enum(['approval', 'payment']),
    tools: z.array(z.string().min(1)),
    createdAt: z.string().refine(
      (value) => !Number.isNaN(Date.parse(value)),
      { message: 'ожидается дата в формате ISO 8601' },
    ),
  })
  .strict();

export const pendingApprovalListSchema = z
  .object({ items: z.array(pendingApprovalItemSchema) })
  .strict();

export type PendingApprovalItem = z.infer<typeof pendingApprovalItemSchema>;
export type PendingApprovalList = z.infer<typeof pendingApprovalListSchema>;

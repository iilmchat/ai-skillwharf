import { z } from 'zod';

/** Статусы, которые понимает визуальный слой AI-Офиса. */
export type OfficeAgentStatus = 'idle' | 'working' | 'waiting_approval';

/** Причина остановки агента: оплата или обычное одобрение. */
export type OfficeApprovalReason = 'payment' | 'approval';

const officeAgentStatusSchema = z.enum([
  'idle',
  'working',
  'waiting_approval',
]);

const officeApprovalReasonSchema = z.enum(['payment', 'approval']);

/**
 * Передача задачи между ролями (Sprint 30, GRAPH-30.1).
 *
 * Валидируется Zod: некорректный payload не должен ломать ленту передач.
 */
export const officeHandoffSchema = z.object({
  fromRole: z.string().min(1),
  toRole: z.string().min(1),
  reason: z.string().min(1),
});

export type OfficeHandoff = z.infer<typeof officeHandoffSchema>;

const baseOfficeEventSchema = z.object({
  agentId: z.string().min(1),
  status: officeAgentStatusSchema,
  task: z.string().min(1),
  reason: officeApprovalReasonSchema.optional(),
  conversationId: z.string().min(1).optional(),
});

/** Событие AI-Офиса из WebSocket (`office_event`). */
export interface OfficeEvent {
  agentId: string;
  status: OfficeAgentStatus;
  task: string;
  reason?: OfficeApprovalReason;
  conversationId?: string;
  /** `agent_handoff` приходит вместе с полями `fromRole`/`toRole`/`reason`. */
  type?: 'agent_handoff';
  handoff?: OfficeHandoff;
}

/** MVP-бэкенд использует одного агента с этим идентификатором. */
export const DEFAULT_OFFICE_AGENT_ID = 'default';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isHandoffPayload(value: Record<string, unknown>): boolean {
  return (
    value.type === 'agent_handoff' ||
    (typeof value.fromRole === 'string' && typeof value.toRole === 'string')
  );
}

/**
 * Валидирует payload события: неизвестные поля не должны ломать офис.
 * Обычное событие меняет статус агента, `agent_handoff` дополнительно несёт
 * пару ролей и причину передачи.
 */
export function parseOfficeEvent(value: unknown): OfficeEvent | null {
  if (!isRecord(value)) {
    return null;
  }

  const conversationId =
    typeof value.conversationId === 'string' && value.conversationId !== ''
      ? value.conversationId
      : undefined;
  const approvalReason = officeApprovalReasonSchema.safeParse(value.reason);

  if (isHandoffPayload(value)) {
    const handoff = officeHandoffSchema.safeParse(value);

    if (!handoff.success) {
      return null;
    }

    return {
      agentId:
        typeof value.agentId === 'string' && value.agentId !== ''
          ? value.agentId
          : DEFAULT_OFFICE_AGENT_ID,
      status: officeAgentStatusSchema.safeParse(value.status).success
        ? (value.status as OfficeAgentStatus)
        : 'working',
      task:
        typeof value.task === 'string' && value.task !== ''
          ? value.task
          : handoff.data.reason,
      ...(approvalReason.success ? { reason: approvalReason.data } : {}),
      ...(conversationId === undefined ? {} : { conversationId }),
      type: 'agent_handoff',
      handoff: handoff.data,
    };
  }

  const parsed = baseOfficeEventSchema.safeParse(value);

  if (!parsed.success) {
    return null;
  }

  return {
    ...parsed.data,
    ...(parsed.data.conversationId === undefined
      ? {}
      : { conversationId: parsed.data.conversationId }),
  };
}

/** Идентификатор диалога из события `stream_end` или `office_event`. */
export function readConversationId(value: unknown): string | null {
  if (!isRecord(value) || typeof value.conversationId !== 'string') {
    return null;
  }

  return value.conversationId === '' ? null : value.conversationId;
}

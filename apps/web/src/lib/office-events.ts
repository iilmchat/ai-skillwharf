/** Статусы, которые понимает визуальный слой AI-Офиса. */
export type OfficeAgentStatus = 'idle' | 'working' | 'waiting_approval';

/** Событие AI-Офиса из WebSocket (`office_event`). */
export interface OfficeEvent {
  agentId: string;
  status: OfficeAgentStatus;
  task: string;
  conversationId?: string;
}

/** MVP-бэкенд использует одного агента с этим идентификатором. */
export const DEFAULT_OFFICE_AGENT_ID = 'default';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isOfficeAgentStatus(value: unknown): value is OfficeAgentStatus {
  return (
    value === 'idle' ||
    value === 'working' ||
    value === 'waiting_approval'
  );
}

/** Валидирует payload события: неизвестные поля не должны ломать офис. */
export function parseOfficeEvent(value: unknown): OfficeEvent | null {
  if (!isRecord(value)) {
    return null;
  }

  const { agentId, status, task } = value;

  if (
    typeof agentId !== 'string' ||
    agentId === '' ||
    !isOfficeAgentStatus(status) ||
    typeof task !== 'string' ||
    task === ''
  ) {
    return null;
  }

  const conversationId =
    typeof value.conversationId === 'string' && value.conversationId !== ''
      ? value.conversationId
      : undefined;

  return { agentId, status, task, conversationId };
}

/** Идентификатор диалога из события `stream_end` или `office_event`. */
export function readConversationId(value: unknown): string | null {
  if (!isRecord(value) || typeof value.conversationId !== 'string') {
    return null;
  }

  return value.conversationId === '' ? null : value.conversationId;
}

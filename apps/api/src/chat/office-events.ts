/** Статусы агента, которые понимает визуальный слой AI-Офиса. */
export type OfficeAgentStatus = 'working' | 'waiting_approval';

/** Событие AI-Офиса, которое Gateway отправляет клиенту. */
export interface OfficeEvent {
  agentId: string;
  status: OfficeAgentStatus;
  task: string;
}

/** Событие AI-Офиса внутри custom-стрима LangGraph. */
export interface ChatOfficeEvent extends OfficeEvent {
  type: 'office';
}

/** Идентификатор агента по умолчанию: MVP работает с одним агентом. */
export const DEFAULT_OFFICE_AGENT_ID = 'default';

/** Задачи, которые Gateway сообщает AI-Офису. */
export const OFFICE_TASKS = {
  analyzing: 'Анализ запроса',
  sandbox: 'Выполнение кода в песочнице',
  waitingApproval: 'Ожидание подтверждения',
} as const;

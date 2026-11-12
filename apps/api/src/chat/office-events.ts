/** Статусы агента, которые понимает визуальный слой AI-Офиса. */
export type OfficeAgentStatus = 'working' | 'waiting_approval';

/** Событие AI-Офиса, которое Gateway отправляет клиенту. */
export interface OfficeEvent {
  conversationId: string;
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
  waitingApproval: 'Ожидание подтверждения',
  resumingAfterApproval: 'Продолжение после одобрения',
} as const;

/**
 * Человекочитаемая задача для конкретного инструмента. Имя инструмента
 * приходит из `tool_calls` модели; для неизвестных инструментов остаётся
 * общий fallback.
 */
export function officeTaskForTool(toolName: string): string {
  switch (toolName) {
    case 'web_search':
      return 'Веб-поиск';
    case 'execute_sandbox_code':
      return 'Выполнение кода';
    case 'exec':
      return 'Выполнение shell-команды';
    case 'read_file':
      return 'Чтение файла';
    default:
      return `Вызов инструмента «${toolName}»`;
  }
}

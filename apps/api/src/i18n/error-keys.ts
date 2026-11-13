/**
 * Ключи ошибок API.
 *
 * Сервер возвращает ключ (например, `errors.insufficient_funds`), а перевод
 * выполняет клиент по своим словарям — один контракт для русского и
 * английского интерфейса.
 */
export const ERROR_KEYS = {
  insufficientFunds: 'errors.insufficient_funds',
  dailyTokenLimit: 'errors.daily_token_limit',
  /** Аргументы вызова не прошли Zod-валидацию или нарушили политику. */
  invalidRequest: 'errors.invalid_request',
  /** Вызов инструмента заблокирован runtime-политикой Agent Gateway. */
  policyBlocked: 'errors.policy_blocked',
  /** MCP-провайдер вернул ошибку. */
  mcpProvider: 'errors.mcp_provider',
  /** MCP-провайдер не ответил за отведённое время. */
  mcpTimeout: 'errors.mcp_timeout',
  /** MCP-сервер не сконфигурирован (нет `mcp_endpoint`). */
  mcpUnavailable: 'errors.mcp_unavailable',
  /**
   * Marketplace-провайдер (Ozon/WB) недоступен: не заданы ключи, сервер не
   * отвечает или вернул ошибку. Отдельный код нужен UI, чтобы показать
   * локализованное сообщение вместо сырого текста MCP (KI-025).
   */
  marketplaceUnavailable: 'errors.marketplace_unavailable',
  /**
   * LLM временно недоступен: все маршруты цепочки упали или исчерпали
   * дневной бюджет (LLM Router v2).
   */
  llmUnavailable: 'errors.llm_unavailable',
} as const;

export type ErrorKey = (typeof ERROR_KEYS)[keyof typeof ERROR_KEYS];

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
   * Внешний провайдер (Telegram, Google Workspace) вернул 429 после всех
   * повторов с экспоненциальным backoff. Повтор возможен позже.
   */
  providerRateLimited: 'errors.provider_rate_limited',
  /** Внешний провайдер недоступен: 5xx, сеть или некорректный ответ. */
  providerUnavailable: 'errors.provider_unavailable',
  /**
   * Провайдер отклонил учётные данные (401/403): токен истёк или отозван.
   * Для Google пользователю нужно заново пройти OAuth.
   */
  providerAuthRequired: 'errors.provider_auth_required',
  /** Интеграция не настроена: нет токена бота/клиента OAuth в окружении. */
  providerNotConfigured: 'errors.provider_not_configured',
  /** Внешний запрос отклонён egress-политикой API/worker. */
  outboundBlocked: 'errors.outbound_blocked',
  /**
   * LLM временно недоступен: все маршруты цепочки упали или исчерпали
   * дневной бюджет (LLM Router v2).
   */
  llmUnavailable: 'errors.llm_unavailable',
} as const;

export type ErrorKey = (typeof ERROR_KEYS)[keyof typeof ERROR_KEYS];

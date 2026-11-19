import { HttpException } from '@nestjs/common';

/**
 * Единый JSON-формат ошибки API: HTTP-статус, машиночитаемый `code`
 * (ключ перевода на клиенте) и человекочитаемый `message`.
 *
 * Формат используется HTTP-контроллерами и WebSocket-шлюзом: клиент
 * показывает перевод по `code`, поэтому текст ошибки не является контрактом.
 */
/** Находка статического аудита в теле ошибки (DEVPORTAL-36.2). */
export interface ApiErrorFinding {
  readonly severity: 'critical' | 'warning' | 'info';
  readonly code: string;
  readonly message: string;
}

export interface ApiErrorBody {
  statusCode: number;
  error: string;
  code: string;
  message: string;
  readonly findings?: readonly ApiErrorFinding[];
}

/** HTTP-исключение, которое отдаёт клиенту тело в едином формате. */
export class ApiException extends HttpException {
  private readonly body: ApiErrorBody;

  constructor(body: ApiErrorBody) {
    super(body, body.statusCode);

    this.body = body;
    // ChatGateway передаёт клиенту `error.message`, поэтому дублируем текст.
    this.message = body.message;
  }

  override getResponse(): ApiErrorBody {
    return this.body;
  }
}

/** Ошибка валидации внешних данных (Zod-схемы аргументов и read-API). */
export function invalidRequestError(message: string): ApiException {
  return new ApiException({
    statusCode: 400,
    error: 'Bad Request',
    code: 'errors.invalid_request',
    message,
  });
}

/** Недостаточно средств на BAL: 402 `errors.insufficient_funds`. */
export function insufficientFundsError(message: string): ApiException {
  return new ApiException({
    statusCode: 402,
    error: 'Payment Required',
    code: 'errors.insufficient_funds',
    message,
  });
}

/** Действие заблокировано runtime-политикой Agent Gateway. */
export function policyBlockedError(message: string): ApiException {
  return new ApiException({
    statusCode: 403,
    error: 'Forbidden',
    code: 'errors.policy_blocked',
    message,
  });
}

/** Регистрация закрыта: `REGISTRATION_MODE=closed` (KI-073). */
export function registrationClosedError(message: string): ApiException {
  return new ApiException({
    statusCode: 403,
    error: 'Forbidden',
    code: 'errors.registration_closed',
    message,
  });
}

/** Инвайт-код не передан или не совпал (`REGISTRATION_MODE=invite`, KI-073). */
export function invalidInviteCodeError(message: string): ApiException {
  return new ApiException({
    statusCode: 403,
    error: 'Forbidden',
    code: 'errors.invalid_invite_code',
    message,
  });
}

/**
 * Провайдер отклонил учётные данные при явном подключении интеграции (400).
 *
 * Отличается от `providerAuthRequiredError` (502) намеренно: это ответ на
 * запрос пользователя «подключить ключ», а не сбой уже настроенной
 * интеграции, поэтому клиент исправляет ввод, а не повторяет позже.
 */
export function providerCredentialsRejectedError(
  message: string,
): ApiException {
  return new ApiException({
    statusCode: 400,
    error: 'Bad Request',
    code: 'errors.provider_auth_required',
    message,
  });
}

/**
 * Marketplace-провайдер недоступен (нет ключей, сервер не отвечает).
 *
 * Отдельный код от `errors.mcp_unavailable`: UI показывает для витрины
 * маркетплейса своё сообщение, а не общий текст MCP (KI-025).
 */
export function marketplaceUnavailableError(message: string): ApiException {
  return new ApiException({
    statusCode: 503,
    error: 'Service Unavailable',
    code: 'errors.marketplace_unavailable',
    message,
  });
}

/** Внешний провайдер исчерпал лимит запросов (429 после backoff). */
export function providerRateLimitedError(message: string): ApiException {
  return new ApiException({
    statusCode: 429,
    error: 'Too Many Requests',
    code: 'errors.provider_rate_limited',
    message,
  });
}

/** Внешний провайдер недоступен: 5xx, сеть или некорректный ответ. */
export function providerUnavailableError(message: string): ApiException {
  return new ApiException({
    statusCode: 502,
    error: 'Bad Gateway',
    code: 'errors.provider_unavailable',
    message,
  });
}

/**
 * Провайдер отклонил токен (401/403). Для Google это означает, что
 * пользователь должен заново пройти OAuth; для Telegram — проверить токен бота.
 */
export function providerAuthRequiredError(message: string): ApiException {
  return new ApiException({
    statusCode: 502,
    error: 'Bad Gateway',
    code: 'errors.provider_auth_required',
    message,
  });
}

/** Интеграция не сконфигурирована в окружении (нет токена/клиента OAuth). */
export function providerNotConfiguredError(message: string): ApiException {
  return new ApiException({
    statusCode: 503,
    error: 'Service Unavailable',
    code: 'errors.provider_not_configured',
    message,
  });
}

/** Внешний запрос отклонён egress-политикой (домен не в allowlist). */
export function outboundBlockedError(message: string): ApiException {
  return new ApiException({
    statusCode: 403,
    error: 'Forbidden',
    code: 'errors.outbound_blocked',
    message,
  });
}

/** Неверный секрет вебхук-триггера. */
export function invalidTriggerSecretError(message: string): ApiException {
  return new ApiException({
    statusCode: 401,
    error: 'Unauthorized',
    code: 'errors.invalid_trigger_secret',
    message,
  });
}

/** Роль воркспейса недостаточна для действия (ORG-31.2). */
export function insufficientWorkspaceRoleError(message: string): ApiException {
  return new ApiException({
    statusCode: 403,
    error: 'Forbidden',
    code: 'errors.insufficient_workspace_role',
    message,
  });
}

/** Сумма операции превышает per-member лимит HITL-одобрения. */
export function hitlLimitExceededError(message: string): ApiException {
  return new ApiException({
    statusCode: 403,
    error: 'Forbidden',
    code: 'errors.hitl_limit_exceeded',
    message,
  });
}

/** Подпись SKILL.md невалидна или неподписанный навык запрещён политикой. */
export function invalidSkillSignatureError(message: string): ApiException {
  return new ApiException({
    statusCode: 400,
    error: 'Bad Request',
    code: 'errors.invalid_skill_signature',
    message,
  });
}

/** Статический аудит SKILL.md не прошёл: 400 с деталями находок. */
export function skillAuditRejectedError(
  findings: readonly ApiErrorFinding[],
): ApiException {
  return new ApiException({
    statusCode: 400,
    error: 'Bad Request',
    code: 'errors.skill_audit_rejected',
    message: 'Публикация заблокирована статическим аудитом безопасности',
    findings,
  });
}

/** Навык публичного каталога не найден или не опубликован. */
export function marketplaceSkillNotFoundError(message: string): ApiException {
  return new ApiException({
    statusCode: 404,
    error: 'Not Found',
    code: 'errors.marketplace_skill_not_found',
    message,
  });
}

/** Промоушен A/B-победителя заблокирован гейтом качества Evals. */
export function evalGateFailedError(message: string): ApiException {
  return new ApiException({
    statusCode: 400,
    error: 'Bad Request',
    code: 'errors.eval_gate_failed',
    message,
  });
}

/** Загруженный документ больше лимита multipart (15 МБ). */
export function documentTooLargeError(message: string): ApiException {
  return new ApiException({
    statusCode: 413,
    error: 'Payload Too Large',
    code: 'errors.document_too_large',
    message,
  });
}

/** MIME-тип документа не поддержан парсером (PDF и изображения). */
export function unsupportedDocumentTypeError(message: string): ApiException {
  return new ApiException({
    statusCode: 415,
    error: 'Unsupported Media Type',
    code: 'errors.unsupported_document_type',
    message,
  });
}

import { HttpException } from '@nestjs/common';

/**
 * Единый JSON-формат ошибки API: HTTP-статус, машиночитаемый `code`
 * (ключ перевода на клиенте) и человекочитаемый `message`.
 *
 * Формат используется HTTP-контроллерами и WebSocket-шлюзом: клиент
 * показывает перевод по `code`, поэтому текст ошибки не является контрактом.
 */
export interface ApiErrorBody {
  statusCode: number;
  error: string;
  code: string;
  message: string;
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

/** Действие заблокировано runtime-политикой Agent Gateway. */
export function policyBlockedError(message: string): ApiException {
  return new ApiException({
    statusCode: 403,
    error: 'Forbidden',
    code: 'errors.policy_blocked',
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

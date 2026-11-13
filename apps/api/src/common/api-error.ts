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

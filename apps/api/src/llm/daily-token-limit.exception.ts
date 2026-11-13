import { HttpException, HttpStatus } from '@nestjs/common';
import { ERROR_KEYS } from '../i18n/error-keys.js';

/** Текст ошибки при исчерпании дневного лимита токенов. */
export const DAILY_TOKEN_LIMIT_MESSAGE =
  'Дневной лимит токенов исчерпан. Попробуйте завтра';

/**
 * Единый JSON-формат ошибки API: HTTP-статус, машиночитаемый `code`
 * (ключ перевода на клиенте) и человекочитаемый `message`.
 */
export interface ApiErrorBody {
  statusCode: number;
  error: string;
  code: string;
  message: string;
}

/** Ответ клиенту, когда жёсткий дневной лимит токенов исчерпан. */
export class DailyTokenLimitException extends HttpException {
  private readonly body: ApiErrorBody;

  constructor() {
    const body: ApiErrorBody = {
      statusCode: HttpStatus.TOO_MANY_REQUESTS,
      error: 'Too Many Requests',
      code: ERROR_KEYS.dailyTokenLimit,
      message: DAILY_TOKEN_LIMIT_MESSAGE,
    };

    super(body, HttpStatus.TOO_MANY_REQUESTS);

    this.body = body;
    // ChatGateway передаёт клиенту `error.message`, поэтому дублируем текст.
    this.message = DAILY_TOKEN_LIMIT_MESSAGE;
  }

  override getResponse(): ApiErrorBody {
    return this.body;
  }
}

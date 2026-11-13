import { HttpStatus } from '@nestjs/common';
import { ApiException, type ApiErrorBody } from '../common/api-error.js';
import { ERROR_KEYS } from '../i18n/error-keys.js';

/** Текст ошибки при исчерпании дневного лимита токенов. */
export const DAILY_TOKEN_LIMIT_MESSAGE =
  'Дневной лимит токенов исчерпан. Попробуйте завтра';

/** Ответ клиенту, когда жёсткий дневной лимит токенов исчерпан. */
export class DailyTokenLimitException extends ApiException {
  constructor() {
    super({
      statusCode: HttpStatus.TOO_MANY_REQUESTS,
      error: 'Too Many Requests',
      code: ERROR_KEYS.dailyTokenLimit,
      message: DAILY_TOKEN_LIMIT_MESSAGE,
    });
  }
}

export type { ApiErrorBody };

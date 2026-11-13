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
} as const;

export type ErrorKey = (typeof ERROR_KEYS)[keyof typeof ERROR_KEYS];

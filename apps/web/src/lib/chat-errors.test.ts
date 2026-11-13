import { AxiosError, type AxiosResponse } from 'axios';
import { describe, expect, it } from 'vitest';
import {
  ERROR_CODES,
  classifyChatError,
  getErrorMeta,
  getErrorMetaFromError,
  isInsufficientFundsPayload,
} from './chat-errors';

/** Ответ Axios с единым JSON-телом ошибки API. */
function axiosErrorWith(data: unknown, status = 429): AxiosError {
  const response = {
    data,
    status,
    statusText: 'Error',
    headers: {},
    config: {},
  } as unknown as AxiosResponse;

  return new AxiosError(
    'Request failed',
    undefined,
    undefined,
    undefined,
    response,
  );
}

describe('getErrorMeta', () => {
  it('извлекает `code` и `statusCode` из payload WsException', () => {
    expect(
      getErrorMeta({
        statusCode: 429,
        error: 'Too Many Requests',
        code: ERROR_CODES.dailyTokenLimit,
        message: 'Дневной лимит токенов исчерпан. Попробуйте завтра',
      }),
    ).toEqual({ code: ERROR_CODES.dailyTokenLimit, status: 429 });
  });

  it('понимает `statusCode` строкой и обрезает `code`', () => {
    expect(
      getErrorMeta({ statusCode: '429', code: '  errors.test  ' }),
    ).toEqual({ code: 'errors.test', status: 429 });
  });

  it('возвращает пустые значения для строки и мусора', () => {
    expect(getErrorMeta('Ожидается { conversationId, content }')).toEqual({
      code: undefined,
      status: undefined,
    });
    expect(getErrorMeta(null)).toEqual({ code: undefined, status: undefined });
    expect(getErrorMeta({ code: 42, statusCode: 'abc' })).toEqual({
      code: undefined,
      status: undefined,
    });
  });

  it('достаёт `code` из JSON-тела ошибки Axios', () => {
    expect(
      getErrorMetaFromError(
        axiosErrorWith({
          statusCode: 429,
          error: 'Too Many Requests',
          code: ERROR_CODES.dailyTokenLimit,
          message: 'Дневной лимит токенов исчерпан. Попробуйте завтра',
        }),
      ),
    ).toEqual({ code: ERROR_CODES.dailyTokenLimit, status: 429 });
  });
});

describe('classifyChatError', () => {
  it('распознаёт дневной лимит по `code`, даже если текст не совпадает', () => {
    expect(
      classifyChatError('Что-то пошло не так', {
        code: ERROR_CODES.dailyTokenLimit,
        status: 429,
      }),
    ).toBe('dailyTokenLimit');
  });

  it('fallback: без `code` — по HTTP-статусу 429', () => {
    expect(
      classifyChatError('Неизвестная ошибка', {
        code: undefined,
        status: 429,
      }),
    ).toBe('dailyTokenLimit');
  });

  it('fallback: без `code` и статуса — по тексту старого API', () => {
    expect(classifyChatError('Too Many Requests')).toBe('dailyTokenLimit');
    expect(classifyChatError('Дневной лимит токенов исчерпан')).toBe(
      'dailyTokenLimit',
    );
  });

  it('неизвестный `code` не мешает текстовому fallback', () => {
    expect(
      classifyChatError('Ошибка: Too Many Requests', {
        code: 'errors.unknown',
        status: undefined,
      }),
    ).toBe('dailyTokenLimit');
  });

  it('по-прежнему распознаёт ошибку marketplace по тексту', () => {
    expect(classifyChatError('MCP Error: connection reset')).toBe(
      'marketplace',
    );
  });

  it('обычный ответ ассистента не классифицирует', () => {
    expect(classifyChatError('Привет! Чем помочь?')).toBeNull();
  });
});

describe('isInsufficientFundsPayload', () => {
  it('распознаёт по `code` из WsException, не глядя на текст', () => {
    expect(
      isInsufficientFundsPayload({
        statusCode: 400,
        message: 'Оплата не прошла',
        code: ERROR_CODES.insufficientFunds,
      }),
    ).toBe(true);
  });

  it('fallback: старый API без `code` — ключ ошибки в сообщении', () => {
    expect(
      isInsufficientFundsPayload({
        statusCode: 400,
        message: ERROR_CODES.insufficientFunds,
      }),
    ).toBe(true);
  });

  it('fallback: старый API без `code` — человекочитаемый текст', () => {
    expect(
      isInsufficientFundsPayload({
        statusCode: 400,
        message: 'Недостаточно средств для запуска агента',
      }),
    ).toBe(true);
  });

  it('понимает массив сообщений (MCP/валидация)', () => {
    expect(
      isInsufficientFundsPayload({
        statusCode: 400,
        message: ['Другая ошибка', 'Недостаточно средств'],
      }),
    ).toBe(true);
  });

  it('прочие ошибки не считает нехваткой средств', () => {
    expect(
      isInsufficientFundsPayload({
        statusCode: 400,
        message: 'Ожидается { conversationId, content }',
      }),
    ).toBe(false);
    expect(isInsufficientFundsPayload('Пользователь не аутентифицирован')).toBe(
      false,
    );
    expect(isInsufficientFundsPayload(null)).toBe(false);
  });
});

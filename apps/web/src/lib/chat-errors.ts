import { isAxiosError } from 'axios';
import { z } from 'zod';

/**
 * Распознавание ошибок API в чате.
 *
 * Бэкенд отдаёт машиночитаемый `code` в едином JSON-формате ошибок
 * (`{ statusCode, error, code, message }`) и в `WsException`. UI принимает
 * решение по `code`, а текстовые маркеры использует только как fallback —
 * для старого API, где `code` ещё нет (см. KI-025).
 */
export const ERROR_CODES = {
  insufficientFunds: 'errors.insufficient_funds',
  dailyTokenLimit: 'errors.daily_token_limit',
  /** Аргументы вызова не прошли валидацию (400). */
  invalidRequest: 'errors.invalid_request',
  /** Вызов инструмента заблокирован политикой безопасности (403). */
  policyBlocked: 'errors.policy_blocked',
  /** MCP-провайдер вернул ошибку (502). */
  mcpProvider: 'errors.mcp_provider',
  /** MCP-провайдер не ответил за отведённое время (504). */
  mcpTimeout: 'errors.mcp_timeout',
  /** MCP-сервер не сконфигурирован (503). */
  mcpUnavailable: 'errors.mcp_unavailable',
  /** Все LLM-маршруты исчерпали бюджет/недоступны (502/503). */
  llmUnavailable: 'errors.llm_unavailable',
  /** Внешний marketplace недоступен (502/503). */
  marketplaceUnavailable: 'errors.marketplace_unavailable',
} as const;

export type ErrorCode = (typeof ERROR_CODES)[keyof typeof ERROR_CODES];

/** Текст, который старый бэкенд присылал вместо кода ошибки. */
const INSUFFICIENT_FUNDS_MARKER = 'Недостаточно средств';

const MARKETPLACE_ERROR_MARKERS = [
  'MCP Error:',
  'MCP error:',
  'MCP SSE:',
  'MCP POST:',
  'Connection refused',
  'ECONNREFUSED',
  'fetch failed',
] as const;

// Голое «429» здесь намеренно не ищем: цифра часто встречается в обычных
// ответах ассистента. HTTP-статус приходит из payload `exception`, а текстовые
// маркеры описывают ошибку однозначно.
const DAILY_TOKEN_LIMIT_MARKERS = [
  'Too Many Requests',
  'too many requests',
  'HTTP 429',
  'status code 429',
  'Дневной лимит токенов',
  'Daily token limit',
  'daily token limit',
] as const;

/** Внешние данные ошибки: доверяем только строкам и числам известных полей. */
const errorPayloadSchema = z.object({
  code: z.string().optional(),
  statusCode: z.union([z.number(), z.string()]).optional(),
});

export interface ApiErrorMeta {
  /** Машиночитаемый `code` ошибки, если бэкенд его прислал. */
  code: string | undefined;
  /** HTTP-статус из payload `exception` или JSON-тела ошибки. */
  status: number | undefined;
}

const EMPTY_META: ApiErrorMeta = { code: undefined, status: undefined };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function parseStatusCode(
  value: number | string | undefined,
): number | undefined {
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : undefined;
  }

  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);

    return Number.isFinite(parsed) ? parsed : undefined;
  }

  return undefined;
}

/** `code` и статус из payload `WsException` или JSON-тела ошибки API. */
export function getErrorMeta(value: unknown): ApiErrorMeta {
  const parsed = errorPayloadSchema.safeParse(value);

  if (!parsed.success) {
    return EMPTY_META;
  }

  const rawCode = parsed.data.code;
  const code =
    typeof rawCode === 'string' && rawCode.trim() !== ''
      ? rawCode.trim()
      : undefined;

  return { code, status: parseStatusCode(parsed.data.statusCode) };
}

/** Метаданные ошибки из отклонённого промиса (Axios или payload `exception`). */
export function getErrorMetaFromError(error: unknown): ApiErrorMeta {
  return isAxiosError(error)
    ? getErrorMeta(error.response?.data)
    : getErrorMeta(error);
}

export type ChatErrorKind =
  | 'marketplace'
  | 'dailyTokenLimit'
  | 'invalidRequest'
  | 'policyBlocked'
  | 'mcpProvider'
  | 'mcpTimeout'
  | 'mcpUnavailable'
  | 'llmUnavailable'
  | 'marketplaceUnavailable';

/** Ошибка внешнего marketplace/MCP-сервиса (например, Ozon). */
export function isMarketplaceError(message: string): boolean {
  return MARKETPLACE_ERROR_MARKERS.some((marker) => message.includes(marker));
}

/** Известные коды из единого JSON API → категория для i18n. */
function codeErrorKind(code: string | undefined): ChatErrorKind | null {
  switch (code) {
    case ERROR_CODES.invalidRequest:
      return 'invalidRequest';
    case ERROR_CODES.policyBlocked:
      return 'policyBlocked';
    case ERROR_CODES.mcpProvider:
      return 'mcpProvider';
    case ERROR_CODES.mcpTimeout:
      return 'mcpTimeout';
    case ERROR_CODES.mcpUnavailable:
      return 'mcpUnavailable';
    case ERROR_CODES.llmUnavailable:
      return 'llmUnavailable';
    case ERROR_CODES.marketplaceUnavailable:
      return 'marketplaceUnavailable';
    default:
      return null;
  }
}

/** Fallback старого API: HTTP 429 или текстовые маркеры дневного лимита. */
function hasDailyTokenLimitFallback(
  message: string,
  meta: ApiErrorMeta,
): boolean {
  return (
    meta.status === 429 ||
    DAILY_TOKEN_LIMIT_MARKERS.some((marker) => message.includes(marker))
  );
}

/** Дневной лимит токенов: `code`, HTTP 429 или текст ошибки старого API. */
export function isDailyTokenLimitError(
  message: string,
  meta: ApiErrorMeta = EMPTY_META,
): boolean {
  return (
    meta.code === ERROR_CODES.dailyTokenLimit ||
    hasDailyTokenLimitFallback(message, meta)
  );
}

export function classifyChatError(
  message: string,
  meta: ApiErrorMeta = EMPTY_META,
): ChatErrorKind | null {
  // Код важнее текста: сообщения бэкенда — не контракт (KI-025).
  if (meta.code === ERROR_CODES.dailyTokenLimit) {
    return 'dailyTokenLimit';
  }

  const codeKind = codeErrorKind(meta.code);

  if (codeKind !== null) {
    return codeKind;
  }

  // Fallback для старого API без `code`.
  if (hasDailyTokenLimitFallback(message, meta)) {
    return 'dailyTokenLimit';
  }

  if (isMarketplaceError(message)) {
    return 'marketplace';
  }

  return null;
}

function isInsufficientFundsCode(code: string | undefined): boolean {
  return code === ERROR_CODES.insufficientFunds;
}

export function hasInsufficientFundsMessage(message: string): boolean {
  return (
    message === ERROR_CODES.insufficientFunds ||
    message.includes(INSUFFICIENT_FUNDS_MARKER)
  );
}

/** Недостаточно средств: сначала `code`, затем текст старого API. */
export function isInsufficientFundsError(
  message: string,
  code: string | undefined,
): boolean {
  return isInsufficientFundsCode(code) || hasInsufficientFundsMessage(message);
}

/** Payload ошибочного события `exception` или JSON-тело ошибки. */
export function isInsufficientFundsPayload(payload: unknown): boolean {
  const { code } = getErrorMeta(payload);

  if (isInsufficientFundsCode(code)) {
    return true;
  }

  if (!isRecord(payload) || !('message' in payload)) {
    return false;
  }

  const { message } = payload;

  if (typeof message === 'string') {
    return hasInsufficientFundsMessage(message);
  }

  return (
    Array.isArray(message) &&
    message.some(
      (item): boolean =>
        typeof item === 'string' && hasInsufficientFundsMessage(item),
    )
  );
}

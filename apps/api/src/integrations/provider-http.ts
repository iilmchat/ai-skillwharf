import { Logger } from '@nestjs/common';
import axios, {
  type AxiosRequestConfig,
  type AxiosResponse,
} from 'axios';
import type { z } from 'zod';
import {
  assertOutboundUrlAllowed,
  OutboundHostNotAllowedError,
  parseOutboundAllowlist,
} from '@skillwharf/shared';
import {
  invalidRequestError,
  outboundBlockedError,
  providerAuthRequiredError,
  providerRateLimitedError,
  providerUnavailableError,
} from '../common/api-error.js';

/** Внешний провайдер, к которому относится вызов. */
export type ProviderName = 'telegram' | 'google' | 'midjourney';

/** Политика повторов при 429/5xx/сетевых сбоях. */
export interface ProviderRetryPolicy {
  /** Всего попыток, включая первую. */
  readonly maxAttempts: number;
  /** Базовая задержка экспоненциального backoff. */
  readonly baseDelayMs: number;
  /** Максимальная задержка чистого backoff (не считая `Retry-After`). */
  readonly maxDelayMs: number;
  /** `retry_after` больше этого значения не ждём: отдаём 429 сразу. */
  readonly maxRetryAfterMs: number;
}

export const DEFAULT_PROVIDER_RETRY_POLICY: ProviderRetryPolicy = {
  maxAttempts: 3,
  baseDelayMs: 500,
  maxDelayMs: 5_000,
  maxRetryAfterMs: 30_000,
};

function readPositiveInt(
  value: string | undefined,
  fallback: number,
): number {
  const parsed = Number.parseInt(value ?? '', 10);

  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

/** Политика из окружения (`PROVIDER_RETRY_*`). */
export function readProviderRetryPolicy(
  env: NodeJS.ProcessEnv = process.env,
): ProviderRetryPolicy {
  return {
    maxAttempts: readPositiveInt(
      env.PROVIDER_RETRY_MAX_ATTEMPTS,
      DEFAULT_PROVIDER_RETRY_POLICY.maxAttempts,
    ),
    baseDelayMs: readPositiveInt(
      env.PROVIDER_RETRY_BASE_DELAY_MS,
      DEFAULT_PROVIDER_RETRY_POLICY.baseDelayMs,
    ),
    maxDelayMs: readPositiveInt(
      env.PROVIDER_RETRY_MAX_DELAY_MS,
      DEFAULT_PROVIDER_RETRY_POLICY.maxDelayMs,
    ),
    maxRetryAfterMs: readPositiveInt(
      env.PROVIDER_RETRY_MAX_AFTER_MS,
      DEFAULT_PROVIDER_RETRY_POLICY.maxRetryAfterMs,
    ),
  };
}

/** Задержка перед повтором: экспонента, но не меньше требования провайдера. */
export function retryDelayMs(
  attempt: number,
  policy: ProviderRetryPolicy,
  retryAfterMs: number | undefined,
): number {
  const backoff = Math.min(
    policy.maxDelayMs,
    policy.baseDelayMs * 2 ** Math.max(0, attempt - 1),
  );

  if (retryAfterMs === undefined) {
    return backoff;
  }

  return Math.min(
    Math.max(backoff, retryAfterMs),
    Math.max(policy.maxDelayMs, Math.min(retryAfterMs, policy.maxRetryAfterMs)),
  );
}

/** Запрос к провайдеру: любой ответ валидируется Zod-схемой. */
export interface ProviderRequest<T> {
  readonly provider: ProviderName;
  readonly method: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  readonly url: string;
  readonly headers?: Readonly<Record<string, string>>;
  readonly data?: unknown;
  readonly schema: z.ZodType<T>;
  readonly timeoutMs?: number;
  readonly retry?: ProviderRetryPolicy;
  /** Внедряемая задержка: тесты не спят по-настоящему. */
  readonly sleep?: (ms: number) => Promise<void>;
  readonly logger?: Pick<Logger, 'warn'>;
}

/** HTTP-статус ответа провайдера. */
export interface ProviderHttpError {
  readonly status: number;
  readonly description: string;
  readonly retryAfterMs?: number;
}

const DEFAULT_TIMEOUT_MS = 15_000;

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/**
 * Вызов внешнего API с повторами.
 *
 * Повторяем 429, 5xx и сетевые ошибки; 401/403 означают проблему с токеном,
 * остальные 4xx — неверные аргументы. `Retry-After` (заголовок) и
 * `parameters.retry_after` (Telegram) учитываются, но ожидание ограничено
 * `maxRetryAfterMs`: иначе один tool-call мог бы «повиснуть» на минуты.
 */
export async function providerRequest<T>(
  request: ProviderRequest<T>,
): Promise<T> {
  assertProviderEgress(request.url);

  const policy = request.retry ?? readProviderRetryPolicy();
  const sleep = request.sleep ?? defaultSleep;
  const timeoutMs = request.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const config: AxiosRequestConfig = {
    method: request.method,
    url: request.url,
    timeout: timeoutMs,
    // Разбираем статусы сами: нужен единый маппинг в ApiException.
    validateStatus: () => true,
    headers: request.headers,
    ...(request.data === undefined ? {} : { data: request.data }),
  };

  let lastError: ProviderHttpError | null = null;

  for (let attempt = 1; attempt <= policy.maxAttempts; attempt += 1) {
    let response: AxiosResponse<unknown>;

    try {
      response = await axios.request<unknown>(config);
    } catch (error) {
      lastError = {
        status: 0,
        description: `сеть недоступна: ${
          error instanceof Error ? error.message : String(error)
        }`,
      };

      if (attempt < policy.maxAttempts) {
        request.logger?.warn(
          `${request.provider}: сетевая ошибка (попытка ${attempt}/${policy.maxAttempts}), повтор`,
        );
        await sleep(retryDelayMs(attempt, policy, undefined));
        continue;
      }

      throw providerUnavailableError(
        `${providerLabel(request.provider)} недоступен: ${lastError.description}`,
      );
    }

    if (response.status >= 200 && response.status < 300) {
      const parsed = request.schema.safeParse(response.data);

      if (!parsed.success) {
        throw providerUnavailableError(
          `${providerLabel(request.provider)}: некорректный ответ API (${parsed.error.issues
            .slice(0, 3)
            .map((issue) => issue.path.join('.') || 'body')
            .join(', ')})`,
        );
      }

      return parsed.data;
    }

    const failure = describeHttpError(response.status, response.data, response.headers);

    if (response.status === 401 || response.status === 403) {
      throw providerAuthRequiredError(
        `${providerLabel(request.provider)} отклонил учётные данные: ${failure.description}`,
      );
    }

    if (response.status !== 429 && response.status < 500) {
      throw invalidRequestError(
        `${providerLabel(request.provider)} отклонил запрос: ${failure.description}`,
      );
    }

    lastError = failure;

    if (attempt === policy.maxAttempts) {
      break;
    }

    if (
      failure.retryAfterMs !== undefined &&
      failure.retryAfterMs > policy.maxRetryAfterMs
    ) {
      // Провайдер просит ждать слишком долго: не блокируем tool-call.
      break;
    }

    request.logger?.warn(
      `${request.provider}: HTTP ${response.status} (попытка ${attempt}/${policy.maxAttempts}), повтор через ${retryDelayMs(attempt, policy, failure.retryAfterMs)} мс`,
    );
    await sleep(retryDelayMs(attempt, policy, failure.retryAfterMs));
  }

  if (lastError?.status === 429) {
    throw providerRateLimitedError(
      `${providerLabel(request.provider)} временно ограничил запросы (429): ${lastError.description}`,
    );
  }

  throw providerUnavailableError(
    `${providerLabel(request.provider)} недоступен: ${lastError?.description ?? 'неизвестная ошибка'}`,
  );
}

function providerLabel(provider: ProviderName): string {
  switch (provider) {
    case 'telegram':
      return 'Telegram';
    case 'midjourney':
      return 'Midjourney';
    default:
      return 'Google API';
  }
}

/**
 * Egress-политика API для внешних интеграций: домен должен быть в
 * `OUTBOUND_ALLOWLIST`, внешний трафик — только https. Проверка выполняется
 * до retry-цикла, чтобы запрещённый домен не ретраился.
 */
export function assertProviderEgress(url: string): void {
  try {
    assertOutboundUrlAllowed(
      url,
      parseOutboundAllowlist(
        process.env.OUTBOUND_ALLOWLIST ?? process.env.API_OUTBOUND_ALLOWLIST,
      ),
    );
  } catch (error) {
    const host =
      error instanceof OutboundHostNotAllowedError ? error.host : 'неизвестный';

    throw outboundBlockedError(
      `Внешний запрос к ${host} запрещён egress-политикой`,
    );
  }
}

/**
 * Описание ошибки провайдера: текст + подсказка о задержке.
 *
 * Telegram кладёт задержку в `parameters.retry_after`, Google — в заголовок
 * `Retry-After` или `error.details[].retryDelay` (строка вида `12s`).
 */
export function describeHttpError(
  status: number,
  body: unknown,
  headers: unknown,
): ProviderHttpError {
  return {
    status,
    description: extractDescription(body) ?? `HTTP ${status}`,
    retryAfterMs: extractRetryAfterMs(body, headers),
  };
}

function extractDescription(body: unknown): string | undefined {
  if (body === null || typeof body !== 'object') {
    return undefined;
  }

  const record = body as Record<string, unknown>;
  const description = record.description;

  if (typeof description === 'string' && description !== '') {
    return description;
  }

  const error = record.error;

  if (typeof error === 'string' && error !== '') {
    return error;
  }

  if (error !== null && typeof error === 'object') {
    const message = (error as Record<string, unknown>).message;

    if (typeof message === 'string' && message !== '') {
      return message;
    }
  }

  const message = record.message;

  return typeof message === 'string' && message !== '' ? message : undefined;
}

function extractRetryAfterMs(
  body: unknown,
  headers: unknown,
): number | undefined {
  const fromHeader = headerValue(headers, 'retry-after');
  const headerSeconds =
    fromHeader === undefined ? undefined : Number.parseInt(fromHeader, 10);

  if (
    headerSeconds !== undefined &&
    Number.isInteger(headerSeconds) &&
    headerSeconds >= 0
  ) {
    return headerSeconds * 1_000;
  }

  if (body === null || typeof body !== 'object') {
    return undefined;
  }

  const record = body as Record<string, unknown>;
  const parameters = record.parameters;

  if (parameters !== null && typeof parameters === 'object') {
    const retryAfter = (parameters as Record<string, unknown>).retry_after;

    if (typeof retryAfter === 'number' && Number.isFinite(retryAfter)) {
      return Math.max(0, retryAfter) * 1_000;
    }
  }

  const details = retryDelayDetails(record);

  if (details !== undefined) {
    const parsed = /^(\d+(?:\.\d+)?)s$/.exec(details.trim());

    if (parsed !== null) {
      return Math.round(Number.parseFloat(parsed[1] ?? '0') * 1_000);
    }
  }

  return undefined;
}

function retryDelayDetails(
  record: Record<string, unknown>,
): string | undefined {
  const error = record.error;

  if (error === null || typeof error !== 'object') {
    return undefined;
  }

  const details = (error as Record<string, unknown>).details;

  if (!Array.isArray(details)) {
    return undefined;
  }

  for (const detail of details) {
    if (detail === null || typeof detail !== 'object') {
      continue;
    }

    const retryDelay = (detail as Record<string, unknown>).retryDelay;

    if (typeof retryDelay === 'string') {
      return retryDelay;
    }
  }

  return undefined;
}

function headerValue(headers: unknown, name: string): string | undefined {
  if (headers === null || typeof headers !== 'object') {
    return undefined;
  }

  const get = (headers as { get?: (key: string) => unknown }).get;

  if (typeof get === 'function') {
    const value = get.call(headers, name);

    if (typeof value === 'string') {
      return value;
    }
  }

  const record = headers as Record<string, unknown>;
  const direct = record[name] ?? record[name.toLowerCase()];

  if (typeof direct === 'string') {
    return direct;
  }

  if (Array.isArray(direct)) {
    const first = direct[0];

    return typeof first === 'string' ? first : undefined;
  }

  return undefined;
}

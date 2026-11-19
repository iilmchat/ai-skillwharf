import { z } from 'zod';
import {
  ApiException,
  providerCredentialsRejectedError,
} from '../../common/api-error.js';
import { ERROR_KEYS } from '../../i18n/error-keys.js';
import {
  providerRequest,
  type ProviderRetryPolicy,
} from '../provider-http.js';

/**
 * Live-проверка ключей при подключении интеграций (завершение KI-075).
 *
 * Проверка выполняется до записи в `ProviderCredential`: невалидный вебхук
 * Битрикс24 или токен МойСклада не попадает в БД, а пользователь сразу видит
 * причину. Запросы идут через `providerRequest` — с egress-политикой,
 * таймаутом и единым форматом ошибок API.
 */

/** Таймаут live-проверки: подключение не должно «висеть» дольше 5 секунд. */
export const INTEGRATION_LIVE_CHECK_TIMEOUT_MS = 5_000;

/** Явный флаг для изолированных окружений, где внешний API недоступен. */
export const SKIP_INTEGRATION_LIVE_CHECK_ENV = 'SKIP_INTEGRATION_LIVE_CHECK';

/** Базовый URL JSON API 1.2, если `MOYSKLAD_BASE_URL` не задан. */
const DEFAULT_MOYSKLAD_BASE_URL = 'https://api.moysklad.ru/api/remap/1.2';

/** Одна попытка: подключение — интерактивное действие, retry не нужен. */
const LIVE_CHECK_RETRY: ProviderRetryPolicy = {
  maxAttempts: 1,
  baseDelayMs: 500,
  maxDelayMs: 5_000,
  maxRetryAfterMs: 30_000,
};

/** Ответ `GET <webhook>/profile.json`: `result` либо `error`. */
const bitrix24ProfileSchema = z
  .object({
    result: z.record(z.string(), z.unknown()).optional(),
    error: z.string().min(1).optional(),
  })
  .refine(
    (body) => body.result !== undefined || body.error !== undefined,
    'пустой ответ profile.json',
  );

/** Ответ `GET /entity/organization?limit=1`: список строк обязателен. */
const moyskladOrganizationSchema = z.object({
  rows: z.array(z.unknown()),
});

/** Пропуск live-проверки только по явному `true`. */
export function isIntegrationLiveCheckSkipped(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return (
    env[SKIP_INTEGRATION_LIVE_CHECK_ENV]?.trim().toLowerCase() === 'true'
  );
}

/** URL профиля Битрикс24: `<webhook>/profile.json`. */
export function bitrix24ProfileUrl(webhookUrl: string): string {
  const url = new URL(webhookUrl);

  url.pathname = `${url.pathname.replace(/\/+$/, '')}/profile.json`;
  url.search = '';
  url.hash = '';

  return url.toString();
}

/** URL проверки токена МойСклада: `<base>/entity/organization?limit=1`. */
export function moyskladOrganizationUrl(
  env: NodeJS.ProcessEnv = process.env,
): string {
  const base = (
    env.MOYSKLAD_BASE_URL?.trim() ?? DEFAULT_MOYSKLAD_BASE_URL
  ).replace(/\/+$/, '');
  const url = new URL(`${base}/entity/organization`);

  url.searchParams.set('limit', '1');

  return url.toString();
}

/**
 * Проверяет входящий вебхук Битрикс24 реальным запросом `profile.json`.
 *
 * 401/403 → 400 `errors.provider_auth_required` (пользователь исправляет
 * вебхук), сеть/5xx → 502 `errors.provider_unavailable` (повтор позже).
 */
export async function verifyBitrix24Webhook(
  webhookUrl: string,
): Promise<void> {
  if (isIntegrationLiveCheckSkipped()) {
    return;
  }

  const profile = await requestLiveCheck(
    'Битрикс24',
    providerRequest({
      provider: 'bitrix24',
      method: 'GET',
      url: bitrix24ProfileUrl(webhookUrl),
      schema: bitrix24ProfileSchema,
      timeoutMs: INTEGRATION_LIVE_CHECK_TIMEOUT_MS,
      retry: LIVE_CHECK_RETRY,
    }),
  );

  if (profile.error !== undefined || profile.result === undefined) {
    throw providerCredentialsRejectedError(
      'Битрикс24 отклонил вебхук: проверьте код входящего вебхука',
    );
  }
}

/**
 * Проверяет токен МойСклада запросом `GET /entity/organization?limit=1`.
 *
 * 401/403 → 400 `errors.provider_auth_required`; остальные сбои — 502.
 */
export async function verifyMoyskladToken(apiToken: string): Promise<void> {
  if (isIntegrationLiveCheckSkipped()) {
    return;
  }

  await requestLiveCheck(
    'МойСклад',
    providerRequest({
      provider: 'moysklad',
      method: 'GET',
      url: moyskladOrganizationUrl(),
      headers: { Authorization: `Bearer ${apiToken}` },
      schema: moyskladOrganizationSchema,
      timeoutMs: INTEGRATION_LIVE_CHECK_TIMEOUT_MS,
      retry: LIVE_CHECK_RETRY,
    }),
  );
}

/** Тело OData `$metadata`: корневой элемент `edmx:Edmx` (необязателен). */
const onecMetadataSchema = z.object({
  'edmx:Edmx': z.record(z.string(), z.unknown()).optional(),
});

/** URL live-проверки 1С: `<odataUrl>/$metadata`. */
export function onecMetadataUrl(odataUrl: string): string {
  return `${odataUrl.replace(/\/+$/, '')}/$metadata`;
}

/** Проверяет доступность OData-сервиса 1С с BASIC-кредо. */
export async function verifyOnecCredentials(
  odataUrl: string,
  username: string,
  password: string,
): Promise<void> {
  if (isIntegrationLiveCheckSkipped()) {
    return;
  }

  await requestLiveCheck(
    '1С:Предприятие',
    providerRequest({
      provider: '1c',
      method: 'GET',
      url: onecMetadataUrl(odataUrl),
      headers: {
        Authorization: `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`,
      },
      schema: onecMetadataSchema,
      timeoutMs: INTEGRATION_LIVE_CHECK_TIMEOUT_MS,
      retry: LIVE_CHECK_RETRY,
    }),
  );
}

/**
 * Переводит 401/403 из `providerRequest` (502 для уже настроенной интеграции)
 * в 400 для явного подключения; остальные ошибки не меняет.
 */
async function requestLiveCheck<T>(
  label: string,
  request: Promise<T>,
): Promise<T> {
  try {
    return await request;
  } catch (error) {
    if (
      error instanceof ApiException &&
      error.getResponse().code === ERROR_KEYS.providerAuthRequired
    ) {
      throw providerCredentialsRejectedError(
        `${label} отклонил учётные данные: проверьте ключ подключения`,
      );
    }

    throw error;
  }
}

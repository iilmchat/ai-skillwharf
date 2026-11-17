import { z } from 'zod';

/**
 * Провайдеры, ключи которых подключает пользователь (Sprint 19, 22).
 *
 * Контракт совпадает с `apps/web/src/lib/integrations.ts`
 * (`KEY_INTEGRATION_PROVIDERS`): Ozon — `{clientId, apiKey}`,
 * Wildberries — `{apiToken}`, Midjourney — `{apiKey}` (TT-API-KEY),
 * Битрикс24 — `{webhookUrl}`, МойСклад — `{apiToken}` (Треки K/L).
 */
export const KEY_PROVIDERS = [
  'ozon',
  'wildberries',
  'midjourney',
  'bitrix24',
  'moysklad',
] as const;

export type KeyProvider = (typeof KEY_PROVIDERS)[number];

const clientIdSchema = z.string().trim().min(1).max(128);
const secretSchema = z.string().trim().min(1).max(512);

/** Токен МойСклада длиннее прочих секретов: провайдер выдаёт base64-строку. */
const moyskladTokenSchema = z.string().trim().min(10).max(2048);

/** Домен облачного портала Битрикс24 (on-prem вебхуки не поддерживаются). */
const BITRIX24_HOST_PATTERN = /(^|\.)bitrix24\.ru$/i;

/** Разбирает URL без исключения: Zod-схема должна вернуть boolean. */
function parseUrl(value: string): URL | null {
  try {
    return new URL(value);
  } catch {
    return null;
  }
}

/**
 * Входящий вебхук Битрикс24.
 *
 * Разрешён только абсолютный `https://`-адрес портала `*.bitrix24.ru` с путём
 * `/rest/<user_id>/<token>/`: по такому адресу MCP-сервер вызывает REST API, и
 * он же является секретом (код вебхука лежит в пути). Правило совпадает с
 * проверкой `infra/mcp/bitrix24/server.mjs`, чтобы ошибка была видна при
 * подключении, а не только при первом вызове инструмента.
 */
export const bitrix24WebhookUrlSchema = z
  .string()
  .trim()
  .min(1)
  .max(2048)
  .refine((value) => {
    const url = parseUrl(value);

    return (
      url !== null &&
      url.protocol === 'https:' &&
      BITRIX24_HOST_PATTERN.test(url.hostname) &&
      url.pathname.toLowerCase().includes('/rest/')
    );
  }, 'ожидается https-вебхук портала вида https://<портал>.bitrix24.ru/rest/<id>/<token>/');

/** Тело `POST /integrations/ozon`. */
export const ozonKeysSchema = z
  .object({ clientId: clientIdSchema, apiKey: secretSchema })
  .strict();

/** Тело `POST /integrations/wildberries`. */
export const wildberriesKeysSchema = z
  .object({ apiToken: secretSchema })
  .strict();

/** Тело `POST /integrations/midjourney`. */
export const midjourneyKeysSchema = z
  .object({ apiKey: secretSchema })
  .strict();

/** Тело `POST /integrations/bitrix24` (Треки K/L). */
export const bitrix24KeysSchema = z
  .object({ webhookUrl: bitrix24WebhookUrlSchema })
  .strict();

/** Тело `POST /integrations/moysklad` (Треки K/L). */
export const moyskladKeysSchema = z
  .object({ apiToken: moyskladTokenSchema })
  .strict();

/** Полезная нагрузка, которая шифруется в `ProviderCredential.secret`. */
export const ozonSecretSchema = z
  .object({ clientId: clientIdSchema, apiKey: secretSchema })
  .strict();

export const wildberriesSecretSchema = z
  .object({ apiToken: secretSchema })
  .strict();

export const midjourneySecretSchema = z
  .object({ apiKey: secretSchema })
  .strict();

export const bitrix24SecretSchema = z
  .object({ webhookUrl: bitrix24WebhookUrlSchema })
  .strict();

export const moyskladSecretSchema = z
  .object({ apiToken: moyskladTokenSchema })
  .strict();

/**
 * Незашифрованные (неконфиденциальные) поля для UI.
 *
 * Не `strict`: лишние ключи из будущих версий отбрасываются, а не ломают
 * чтение статуса.
 */
export const providerMetadataSchema = z.object({
  /** ISO-дата истечения токена WB (180 дней с момента подключения). */
  tokenExpiresAt: z.string().datetime().optional(),
});

export type OzonKeys = z.infer<typeof ozonKeysSchema>;
export type WildberriesKeys = z.infer<typeof wildberriesKeysSchema>;
export type MidjourneyKeys = z.infer<typeof midjourneyKeysSchema>;
export type Bitrix24Keys = z.infer<typeof bitrix24KeysSchema>;
export type MoyskladKeys = z.infer<typeof moyskladKeysSchema>;
export type ProviderMetadata = z.infer<typeof providerMetadataSchema>;

/** Срок жизни токена Wildberries: продавец выдаёт его на 180 дней. */
export const WB_TOKEN_TTL_DAYS = 180;

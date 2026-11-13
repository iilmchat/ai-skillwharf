import { z } from 'zod';

/**
 * Провайдеры, ключи которых подключает пользователь (Sprint 19).
 *
 * Контракт совпадает с `apps/web/src/lib/integrations.ts`
 * (`KEY_INTEGRATION_PROVIDERS`): Ozon — `{clientId, apiKey}`,
 * Wildberries — `{apiToken}`, Midjourney — `{apiKey}` (TT-API-KEY).
 */
export const KEY_PROVIDERS = ['ozon', 'wildberries', 'midjourney'] as const;

export type KeyProvider = (typeof KEY_PROVIDERS)[number];

const clientIdSchema = z.string().trim().min(1).max(128);
const secretSchema = z.string().trim().min(1).max(512);

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
export type ProviderMetadata = z.infer<typeof providerMetadataSchema>;

/** Срок жизни токена Wildberries: продавец выдаёт его на 180 дней. */
export const WB_TOKEN_TTL_DAYS = 180;

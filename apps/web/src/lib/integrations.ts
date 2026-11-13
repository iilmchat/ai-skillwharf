import { isAxiosError } from 'axios';
import { z } from 'zod';
import { api } from './api';

/**
 * Контракт раздела «Интеграции» (Sprint 18).
 *
 * `GET /api/v1/integrations` возвращает состояние обоих провайдеров:
 *
 * ```json
 * {
 *   "telegram": { "status": "active", "botName": "Wharf Bot", "botUsername": "wharf_bot" },
 *   "google": { "status": "active", "email": "owner@example.com" }
 * }
 * ```
 *
 * `status` — `active`, `disconnected` или `error`; `error` — необязательный
 * текст/ключ i18n для объяснения ошибки. Остальные операции:
 *
 * - `POST /api/v1/integrations/telegram` `{ botToken }` — проверка через
 *   Telegram `getMe`;
 * - `DELETE /api/v1/integrations/telegram` — отключение бота;
 * - `GET /api/v1/integrations/google/authorization-url` — `{ url }` (или
 *   `{ authorizationUrl }`) для редиректа на Google OAuth;
 * - `DELETE /api/v1/integrations/google` — отзыв доступа.
 *
 * Ответы валидируются Zod: UI не показывает частично распарсенное состояние
 * и не подставляет вымышленные имена ботов/email.
 */
export const INTEGRATION_PROVIDERS = ['telegram', 'google'] as const;

export type IntegrationProvider = (typeof INTEGRATION_PROVIDERS)[number];

export const integrationStatusSchema = z.enum([
  'active',
  'disconnected',
  'error',
]);

export type IntegrationStatus = z.infer<typeof integrationStatusSchema>;

const integrationErrorTextSchema = z
  .string()
  .trim()
  .min(1)
  .nullable()
  .optional();

export const telegramIntegrationSchema = z.object({
  status: integrationStatusSchema,
  botName: z.string().trim().min(1).nullable().optional(),
  botUsername: z.string().trim().min(1).nullable().optional(),
  error: integrationErrorTextSchema,
});

export type TelegramIntegration = z.infer<typeof telegramIntegrationSchema>;

export const googleIntegrationSchema = z.object({
  status: integrationStatusSchema,
  email: z.string().trim().min(1).nullable().optional(),
  error: integrationErrorTextSchema,
});

export type GoogleIntegration = z.infer<typeof googleIntegrationSchema>;

export const integrationsSchema = z.object({
  telegram: telegramIntegrationSchema,
  google: googleIntegrationSchema,
});

export type IntegrationsState = z.infer<typeof integrationsSchema>;

/** Ключ кэша; userId разделяет состояния разных пользователей. */
export const integrationsQueryKey = ['integrations'] as const;

export function integrationsQueryKeyFor(
  userId: string | null,
): readonly unknown[] {
  return [...integrationsQueryKey, userId];
}

/** Токен бота из @BotFather: `<bot_id>:<secret>`. */
export const telegramBotTokenSchema = z
  .string()
  .trim()
  .min(10)
  .max(256)
  .regex(/^\d+:[A-Za-z0-9_-]+$/, 'ожидается токен вида 123456789:AA...');

/** Абсолютный https-URL OAuth; другие схемы отклоняются. */
export const googleAuthorizationUrlSchema = z.string().url().refine(
  (value) => {
    try {
      return new URL(value).protocol === 'https:';
    } catch {
      return false;
    }
  },
  { message: 'ожидается абсолютный https URL' },
);

const googleAuthorizationResponseSchema = z.union([
  z.object({ url: z.string() }).transform((value) => value.url),
  z
    .object({ authorizationUrl: z.string() })
    .transform((value) => value.authorizationUrl),
]);

export async function fetchIntegrations(): Promise<IntegrationsState> {
  const { data } = await api.get<unknown>('/integrations');

  return integrationsSchema.parse(data);
}

export async function connectTelegram(botToken: string): Promise<void> {
  await api.post('/integrations/telegram', { botToken });
}

export async function disconnectTelegram(): Promise<void> {
  await api.delete('/integrations/telegram');
}

export async function fetchGoogleAuthorizationUrl(): Promise<string> {
  const { data } = await api.get<unknown>(
    '/integrations/google/authorization-url',
  );
  const rawUrl = googleAuthorizationResponseSchema.parse(data);

  return googleAuthorizationUrlSchema.parse(rawUrl);
}

export async function disconnectGoogle(): Promise<void> {
  await api.delete('/integrations/google');
}

/** Отображаемое имя бота: имя, иначе @username. */
export function getTelegramDisplayName(
  integration: TelegramIntegration,
): string | null {
  const name = integration.botName?.trim();

  if (name !== undefined && name !== '') {
    return name;
  }

  const username = integration.botUsername?.trim();

  if (username === undefined || username === '') {
    return null;
  }

  return username.startsWith('@') ? username : `@${username}`;
}

/** Активные каналы в стабильном порядке telegram → google. */
export function getActiveIntegrationChannels(
  state: IntegrationsState | undefined,
): IntegrationProvider[] {
  if (state === undefined) {
    return [];
  }

  return INTEGRATION_PROVIDERS.filter(
    (provider) => state[provider].status === 'active',
  );
}

export type IntegrationOperation =
  | 'load'
  | 'telegramConnect'
  | 'telegramDisconnect'
  | 'googleConnect'
  | 'googleDisconnect';

export type IntegrationErrorKind =
  | 'network'
  | 'sessionExpired'
  | 'forbidden'
  | 'notFound'
  | 'invalidToken'
  | 'oauthUnavailable'
  | 'unavailable'
  | 'invalidResponse'
  | 'requestFailed'
  | 'unknown';

export interface IntegrationErrorDetails {
  kind: IntegrationErrorKind;
  /** Ключ i18n (`errors.*`) или человекочитаемый текст от API. */
  serverMessage: string | null;
}

const errorPayloadSchema = z.object({
  code: z.string().optional(),
  message: z.union([z.string(), z.array(z.string())]).optional(),
});

function readServerMessage(value: unknown): string | null {
  const parsed = errorPayloadSchema.safeParse(value);

  if (!parsed.success) {
    return null;
  }

  const { code, message } = parsed.data;

  if (typeof code === 'string' && code.startsWith('errors.')) {
    return code;
  }

  if (typeof message === 'string' && message.trim() !== '') {
    return message.trim();
  }

  if (Array.isArray(message)) {
    const joined = message
      .map((item) => item.trim())
      .filter((item) => item !== '')
      .join('; ');

    return joined === '' ? null : joined;
  }

  return null;
}

function readServerCode(value: unknown): string | null {
  const parsed = errorPayloadSchema.safeParse(value);

  return parsed.success &&
    typeof parsed.data.code === 'string' &&
    parsed.data.code.startsWith('errors.')
    ? parsed.data.code
    : null;
}

/**
 * Категория ошибки для локализованного сообщения. HTTP-статус важнее текста;
 * для 400/422 контекст операции отличает неверный Telegram-токен от
 * ненастроенного Google OAuth.
 */
export function getIntegrationErrorDetails(
  error: unknown,
  operation: IntegrationOperation,
): IntegrationErrorDetails {
  if (error instanceof z.ZodError) {
    return { kind: 'invalidResponse', serverMessage: null };
  }

  if (!isAxiosError(error)) {
    return {
      kind: 'unknown',
      serverMessage: error instanceof Error ? error.message : null,
    };
  }

  if (error.response === undefined) {
    return { kind: 'network', serverMessage: null };
  }

  const serverMessage = readServerMessage(error.response.data);
  const code = readServerCode(error.response.data);
  const { status } = error.response;

  // Telegram отвечает 401/403 на неверный токен; provider-http может отдать
  // 502 errors.provider_auth_required. Оба варианта — проблема токена, а не
  // истёкшая сессия пользователя.
  if (
    operation === 'telegramConnect' &&
    (status === 401 || code === 'errors.provider_auth_required')
  ) {
    return { kind: 'invalidToken', serverMessage };
  }

  // Незаданные GOOGLE_CLIENT_ID/SECRET — это не сбой сети, а ненастроенный
  // OAuth; пользователю нужна подсказка про конфигурацию сервера.
  if (
    operation === 'googleConnect' &&
    code === 'errors.provider_not_configured'
  ) {
    return { kind: 'oauthUnavailable', serverMessage };
  }

  if (status === 401) {
    return { kind: 'sessionExpired', serverMessage };
  }

  if (status === 403) {
    return { kind: 'forbidden', serverMessage };
  }

  if (status === 404) {
    return { kind: 'notFound', serverMessage };
  }

  if (status === 502 || status === 503) {
    return { kind: 'unavailable', serverMessage };
  }

  if (status === 400 || status === 422) {
    if (operation === 'telegramConnect') {
      return { kind: 'invalidToken', serverMessage };
    }

    if (operation === 'googleConnect') {
      return { kind: 'oauthUnavailable', serverMessage };
    }

    return { kind: 'requestFailed', serverMessage };
  }

  return { kind: 'unknown', serverMessage };
}

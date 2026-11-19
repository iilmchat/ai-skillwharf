import { isAxiosError } from 'axios';
import { z } from 'zod';
import { api } from './api';

/**
 * Вебхук-триггеры (Sprint 32, UI-задача WEB-32.3).
 *
 * Внешние системы (Битрикс24, МойСклад, 1С:Предприятие или свой вебхук)
 * запускают агента по событию через `POST /api/v1/webhooks/triggers/:slug`.
 * CRUD триггеров живёт по пути `/api/v1/triggers` (baseURL `api.ts` уже
 * содержит `/api/v1`). Секрет заголовка `X-Trigger-Secret` выдаётся только
 * в ответе на создание и в UI маскируется.
 *
 * Все ответы валидируются Zod: UI не показывает частично распарсенный список
 * и не подставляет вымышленные счётчики/даты. Если endpoint ещё не реализован
 * (404), раздел показывает локализованное сообщение о недоступности.
 */

/** Источники события; `custom` — произвольный внешний вебхук. */
export const TRIGGER_SOURCES = ['bitrix24', 'moysklad', '1c', 'custom'] as const;

export const triggerSourceSchema = z.enum(TRIGGER_SOURCES);

export type TriggerSource = z.infer<typeof triggerSourceSchema>;

export const triggerStatusSchema = z.enum(['active', 'paused']);

export type TriggerStatus = z.infer<typeof triggerStatusSchema>;

/** Карточка триггера в списке. `triggerCount` — число срабатываний. */
export const triggerSchema = z.object({
  id: z.string().trim().min(1),
  name: z.string().trim().min(1),
  source: triggerSourceSchema,
  promptTemplate: z.string().trim().min(1),
  slug: z.string().trim().min(1),
  /** Backend может называть счётчик иначе; алиасы нормализуются в одно поле. */
  triggerCount: z
    .union([z.number().int().nonnegative(), z.string().regex(/^\d+$/)])
    .transform((value) =>
      typeof value === 'number' ? value : Number.parseInt(value, 10),
    )
    .default(0),
  status: triggerStatusSchema.default('active'),
  createdAt: z.string().nullable().optional(),
});

export type Trigger = z.infer<typeof triggerSchema>;

/** Ответ создания: секрет одноразовый, дальше API его не возвращает. */
export const createdTriggerSchema = triggerSchema.extend({
  secret: z.string().trim().min(1),
  webhookUrl: z.string().nullable().optional(),
});

export type CreatedTrigger = z.infer<typeof createdTriggerSchema>;

/** Форма создания; `{{payload}}` — подстановка тела входящего события. */
export const createTriggerInputSchema = z.object({
  name: z.string().trim().min(1).max(120),
  source: triggerSourceSchema,
  promptTemplate: z.string().trim().min(1).max(4000),
});

export type CreateTriggerInput = z.infer<typeof createTriggerInputSchema>;

/** Список приходит массивом или обёрткой `{ items }` (как остальные API). */
export const triggerListSchema = z.union([
  z.array(triggerSchema),
  z
    .object({ items: z.array(triggerSchema) })
    .transform((value) => value.items),
]);

/** Некоторые версии API кладут карточку в поле `trigger`. */
const createdTriggerResponseSchema = z.union([
  createdTriggerSchema,
  z
    .object({ trigger: triggerSchema, secret: z.string().trim().min(1) })
    .transform((value) => ({ ...value.trigger, secret: value.secret })),
]);

/** Ключ кэша TanStack Query; userId разделяет триггеры разных аккаунтов. */
export const triggersQueryKey = ['triggers'] as const;

export function triggersQueryKeyFor(userId: string | null): readonly unknown[] {
  return [...triggersQueryKey, userId];
}

/** Готовый URL для вставки в настройки внешней системы. */
export function getTriggerWebhookUrl(slug: string, origin = ''): string {
  return `${origin}/api/v1/webhooks/triggers/${encodeURIComponent(slug)}`;
}

export async function fetchTriggers(): Promise<Trigger[]> {
  const { data } = await api.get<unknown>('/triggers');

  return triggerListSchema.parse(data);
}

export async function createTrigger(
  input: CreateTriggerInput,
): Promise<CreatedTrigger> {
  const body = createTriggerInputSchema.parse(input);
  const { data } = await api.post<unknown>('/triggers', body);

  return createdTriggerResponseSchema.parse(data);
}

export async function deleteTrigger(id: string): Promise<void> {
  await api.delete(`/triggers/${encodeURIComponent(id)}`);
}

export type TriggerErrorKind =
  | 'network'
  | 'sessionExpired'
  | 'forbidden'
  | 'notFound'
  | 'slugConflict'
  | 'unavailable'
  | 'invalidResponse'
  | 'requestFailed'
  | 'unknown';

const errorPayloadSchema = z.object({
  code: z.string().optional(),
});

/** Категория ошибки для локализованного сообщения в секции триггеров. */
export function getTriggerErrorKind(error: unknown): TriggerErrorKind {
  if (error instanceof z.ZodError) {
    return 'invalidResponse';
  }

  if (!isAxiosError(error)) {
    return 'unknown';
  }

  if (error.response === undefined) {
    return 'network';
  }

  const parsed = errorPayloadSchema.safeParse(error.response.data);
  const code = parsed.success ? parsed.data.code : undefined;
  const { status } = error.response;

  if (code === 'errors.trigger_slug_exists') {
    return 'slugConflict';
  }

  if (status === 401) {
    return 'sessionExpired';
  }

  if (status === 403) {
    return 'forbidden';
  }

  if (status === 404) {
    return 'notFound';
  }

  if (status === 409 || status === 422) {
    return 'slugConflict';
  }

  if (status === 502 || status === 503) {
    return 'unavailable';
  }

  if (status === 400) {
    return 'requestFailed';
  }

  return 'unknown';
}

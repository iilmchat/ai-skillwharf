import { isAxiosError } from 'axios';
import { z } from 'zod';
import { api } from './api';

/**
 * Контракт корпоративных мессенджеров (Sprint 40, OMNI-40.3/40.4).
 *
 * Единый эндпоинт покрывает VK Teams, Пачку и Яндекс Мессенджер. Все ответы
 * проверяются Zod; токен никогда не возвращается в открытом виде.
 */
export const CORP_CHANNELS_ENDPOINT = '/channels/corporate';

export const corpProviderSchema = z.enum([
  'vk_teams',
  'pachca',
  'yandex_messenger',
]);

export type CorpProvider = z.infer<typeof corpProviderSchema>;

const CHAT_ID = /^[A-Za-z0-9_.:@-]{1,64}$/;

/** Разделяем список chat_id запятой, точкой с запятой, пробелом или переносом. */
export function parseCorpChatIds(value: string): string[] {
  return value
    .split(/[,;\s]+/)
    .map((item) => item.trim())
    .filter((item) => CHAT_ID.test(item));
}

const apiBaseUrlSchema = z
  .string()
  .trim()
  .refine((value) => value === '' || /^https?:\/\/\S+$/.test(value), {
    message: 'ожидается абсолютный http(s)-адрес',
  })
  .transform((value) => (value === '' ? undefined : value));

export const corpChannelSchema = z
  .object({
    id: z.string().min(1),
    workspaceId: z.string().min(1),
    provider: corpProviderSchema,
    name: z.string().min(1),
    apiBaseUrl: z.string().nullable().optional(),
    /** Совместимость с ответами, где поле называется `maskedToken`. */
    tokenMasked: z.string().optional(),
    maskedToken: z.string().optional(),
    webhookUrl: z.string(),
    allowedChatIds: z.array(z.string()),
    isActive: z.boolean(),
    lastMessageAt: z.string().nullable().optional(),
    createdAt: z.string(),
    /** Секрет показывается только в ответе на создание канала. */
    webhookSecret: z.string().optional(),
  })
  .transform((wire) => ({
    id: wire.id,
    workspaceId: wire.workspaceId,
    provider: wire.provider,
    name: wire.name,
    apiBaseUrl: wire.apiBaseUrl ?? undefined,
    tokenMasked: wire.tokenMasked ?? wire.maskedToken ?? '',
    webhookUrl: wire.webhookUrl,
    allowedChatIds: wire.allowedChatIds,
    isActive: wire.isActive,
    lastMessageAt: wire.lastMessageAt,
    createdAt: wire.createdAt,
    webhookSecret: wire.webhookSecret,
  }));

export type CorpChannel = z.infer<typeof corpChannelSchema>;

export const corpChannelListSchema = z
  .union([
    z.array(corpChannelSchema),
    z.object({ items: z.array(corpChannelSchema) }),
    z.object({ channels: z.array(corpChannelSchema) }),
  ])
  .transform((value) =>
    Array.isArray(value)
      ? value
      : 'items' in value
        ? value.items
        : value.channels,
  );

export const connectCorpChannelSchema = z
  .object({
    provider: corpProviderSchema,
    name: z.string().trim().min(2).max(80),
    botToken: z.string().trim().min(1).max(256),
    apiBaseUrl: apiBaseUrlSchema.optional(),
    allowedChatIds: z
      .union([z.string(), z.array(z.string())])
      .transform((value) =>
        Array.isArray(value)
          ? value.map((item) => item.trim()).filter((item) => item !== '')
          : parseCorpChatIds(value),
      )
      .refine(
        (ids) => ids.length > 0 && ids.every((id) => CHAT_ID.test(id)),
        { message: 'нужен хотя бы один Chat ID' },
      ),
  })
  .transform((value) => ({
    provider: value.provider,
    name: value.name,
    botToken: value.botToken,
    ...(value.apiBaseUrl === undefined ? {} : { apiBaseUrl: value.apiBaseUrl }),
    allowedChatIds: value.allowedChatIds,
  }));

export type ConnectCorpChannelInput = z.input<
  typeof connectCorpChannelSchema
>;

export const corpChannelsQueryKey = (workspaceId: string) =>
  ['corporate', 'channels', workspaceId] as const;

function channelsUrl(workspaceId: string): string {
  return `/workspaces/${encodeURIComponent(workspaceId)}${CORP_CHANNELS_ENDPOINT}`;
}

export async function fetchCorpChannels(
  workspaceId: string,
): Promise<CorpChannel[]> {
  const { data } = await api.get<unknown>(channelsUrl(workspaceId));

  return corpChannelListSchema.parse(data);
}

export async function connectCorpChannel(
  workspaceId: string,
  payload: ConnectCorpChannelInput,
): Promise<CorpChannel> {
  const request = connectCorpChannelSchema.parse(payload);
  const { data } = await api.post<unknown>(channelsUrl(workspaceId), request);

  return corpChannelSchema.parse(data);
}

export async function deleteCorpChannel(
  workspaceId: string,
  channelId: string,
): Promise<void> {
  await api.delete(
    `${channelsUrl(workspaceId)}/${encodeURIComponent(channelId)}`,
  );
}

export type CorpChannelsErrorKind =
  | 'network'
  | 'unavailable'
  | 'invalid'
  | 'forbidden'
  | 'unknown';

export function getCorpChannelsErrorKind(
  error: unknown,
): CorpChannelsErrorKind {
  if (error instanceof z.ZodError) {
    return 'invalid';
  }

  if (isAxiosError(error)) {
    if (error.response === undefined) {
      return 'network';
    }

    if (error.response.status === 403) {
      return 'forbidden';
    }

    if (error.response.status === 404 || error.response.status === 501) {
      return 'unavailable';
    }
  }

  return 'unknown';
}

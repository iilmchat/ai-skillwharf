import { isAxiosError } from 'axios';
import { z } from 'zod';
import { api } from './api';

/**
 * Контракт подключения Telegram-каналов воркспейса (Sprint 39, OMNI-39.1).
 *
 * Токен и chat_id приходят из формы: разделители — запятая, пробел или
 * перенос строки. Всё валидируется Zod до отправки, чтобы не расходовать
 * запросы к API на заведомо некорректные данные.
 */
export const TELEGRAM_CHANNELS_ENDPOINT = '/channels/telegram';

export const telegramChannelSchema = z
  .object({
    id: z.string().min(1),
    workspaceId: z.string().min(1),
    botUsername: z.string().nullable().optional(),
    /** API Sprint 39 называет поле `tokenMasked`; поддерживаем оба имени. */
    maskedToken: z.string().optional(),
    tokenMasked: z.string().optional(),
    webhookUrl: z.string(),
    allowedChatIds: z.array(z.string()),
    isActive: z.boolean(),
    lastMessageAt: z.string().nullable().optional(),
    createdAt: z.string(),
  })
  .transform((wire) => ({
    id: wire.id,
    workspaceId: wire.workspaceId,
    botUsername: wire.botUsername,
    maskedToken: wire.maskedToken ?? wire.tokenMasked ?? '',
    webhookUrl: wire.webhookUrl,
    allowedChatIds: wire.allowedChatIds,
    isActive: wire.isActive,
    lastMessageAt: wire.lastMessageAt,
    createdAt: wire.createdAt,
  }));

export type TelegramChannel = z.infer<typeof telegramChannelSchema>;

/** Ответ API может быть массивом или обёрткой — приводим к массиву. */
export const telegramChannelListSchema = z
  .union([
    z.array(telegramChannelSchema),
    z.object({ items: z.array(telegramChannelSchema) }),
    z.object({ channels: z.array(telegramChannelSchema) }),
  ])
  .transform((value) =>
    Array.isArray(value)
      ? value
      : 'items' in value
        ? value.items
        : value.channels,
  );

export const telegramBotTokenSchema = z
  .string()
  .trim()
  .regex(/^\d{6,12}:[A-Za-z0-9_-]{30,}$/, {
    message: 'ожидается токен бота из @BotFather',
  });

const TELEGRAM_CHAT_ID = /^-?\d{1,20}$/;

/** Разбирает список chat_id из текстового поля формы. */
export function parseAllowedChatIds(value: string): string[] {
  return value
    .split(/[,;\s]+/)
    .map((item) => item.trim())
    .filter((item) => TELEGRAM_CHAT_ID.test(item));
}

export const connectTelegramChannelSchema = z
  .object({
    botToken: telegramBotTokenSchema,
    allowedChatIds: z
      .union([z.string(), z.array(z.string())])
      .transform((value) =>
        Array.isArray(value)
          ? value.map((item) => item.trim()).filter((item) => item !== '')
          : parseAllowedChatIds(value),
      )
      .refine(
        (ids) => ids.length > 0 && ids.every((id) => TELEGRAM_CHAT_ID.test(id)),
        { message: 'нужен хотя бы один числовой Telegram Chat ID' },
      ),
  })
  .transform((value) => ({
    botToken: value.botToken,
    allowedChatIds: value.allowedChatIds,
  }));

/** Тип формы: `allowedChatIds` может быть сырой строкой из textarea. */
export type ConnectTelegramChannelInput = z.input<
  typeof connectTelegramChannelSchema
>;

/** Ключ кэша списка каналов активного воркспейса. */
export const telegramChannelsQueryKey = (workspaceId: string) =>
  ['telegram', 'channels', workspaceId] as const;

function channelsUrl(workspaceId: string): string {
  return `/workspaces/${encodeURIComponent(workspaceId)}${TELEGRAM_CHANNELS_ENDPOINT}`;
}

export async function fetchTelegramChannels(
  workspaceId: string,
): Promise<TelegramChannel[]> {
  const { data } = await api.get<unknown>(channelsUrl(workspaceId));

  return telegramChannelListSchema.parse(data);
}

export async function connectTelegramChannel(
  workspaceId: string,
  payload: ConnectTelegramChannelInput,
): Promise<TelegramChannel> {
  const request = connectTelegramChannelSchema.parse(payload);
  const { data } = await api.post<unknown>(channelsUrl(workspaceId), request);

  return telegramChannelSchema.parse(data);
}

export async function deleteTelegramChannel(
  workspaceId: string,
  channelId: string,
): Promise<void> {
  await api.delete(
    `${channelsUrl(workspaceId)}/${encodeURIComponent(channelId)}`,
  );
}

export type TelegramChannelsErrorKind =
  | 'network'
  | 'unavailable'
  | 'invalid'
  | 'forbidden'
  | 'unknown';

export function getTelegramChannelsErrorKind(
  error: unknown,
): TelegramChannelsErrorKind {
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

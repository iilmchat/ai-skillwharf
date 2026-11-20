import { z } from 'zod';

/** POST /workspaces/:workspaceId/channels/telegram. */
export const createTelegramChannelSchema = z
  .object({
    botToken: z.string().trim().min(1).max(256),
    allowedChatIds: z
      .array(z.union([z.number().int(), z.string().min(1).max(64)]))
      .max(200)
      .optional(),
  })
  .strict();
export type CreateTelegramChannelInput = z.infer<
  typeof createTelegramChannelSchema
>;

/** GET-ответ: открытый токен и секрет NEVER возвращаются. */
export const telegramChannelViewSchema = z.object({
  id: z.string(),
  workspaceId: z.string(),
  userId: z.string(),
  botUsername: z.string().nullable(),
  tokenMasked: z.string(),
  webhookUrl: z.string(),
  allowedChatIds: z.array(z.string()),
  isActive: z.boolean(),
  lastMessageAt: z.string().nullable(),
  createdAt: z.string(),
});
export type TelegramChannelView = z.infer<typeof telegramChannelViewSchema>;

/** Секрет webhook возвращается один раз при создании канала. */
export const createdTelegramChannelSchema = telegramChannelViewSchema.extend({
  webhookSecret: z.string().min(1),
});
export type CreatedTelegramChannel = z.infer<
  typeof createdTelegramChannelSchema
>;

/** Callback-data inline-кнопки HITL (не более 64 символов Telegram). */
export const telegramHitlCallbackSchema = z
  .object({
    action: z.enum(['approve', 'reject']),
    runId: z.string().min(1).max(48),
  })
  .strict();

export function parseHitlCallback(
  data: string | undefined,
): z.infer<typeof telegramHitlCallbackSchema> | null {
  if (data === undefined) {
    return null;
  }

  const parts = data.split(':');

  if (parts.length !== 3 || parts[0] !== 'hitl') {
    return null;
  }

  const parsed = telegramHitlCallbackSchema.safeParse({
    action: parts[1],
    runId: parts[2],
  });

  return parsed.success ? parsed.data : null;
}

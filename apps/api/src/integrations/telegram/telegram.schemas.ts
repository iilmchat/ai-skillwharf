import { z } from 'zod';

/**
 * Zod-схемы Telegram Bot API.
 *
 * Telegram присылает много служебных полей, поэтому объекты не `.strict()`:
 * неизвестные ключи отбрасываются, а обязательные для маршрутизации —
 * проверяются.
 */

/** Идентификатор чата: Telegram отдаёт число, но принимает и строку. */
export const telegramChatIdSchema = z.union([
  z.number().int(),
  z.string().min(1).max(128),
]);

/** Нормализованный chat_id для БД и вызовов API. */
export function normalizeChatId(chatId: number | string): string {
  return String(chatId);
}

/** Кнопка inline-клавиатуры: либо URL, либо callback_data. */
export const telegramButtonSchema = z
  .object({
    text: z.string().min(1).max(64),
    url: z.url().max(2_048).optional(),
    callbackData: z.string().min(1).max(64).optional(),
  })
  .refine(
    (button) =>
      (button.url === undefined) !== (button.callbackData === undefined),
    'кнопка должна содержать ровно одно из полей url или callbackData',
  );

export type TelegramButton = z.infer<typeof telegramButtonSchema>;

/** Клавиатура, которую сервис разворачивает в `inline_keyboard` (по кнопке в ряд). */
export const telegramButtonsSchema = z
  .array(telegramButtonSchema)
  .max(8)
  .optional();

/** Чат обновления: id обязателен, остальное — для ответа и логов. */
export const telegramChatSchema = z.object({
  id: telegramChatIdSchema,
  type: z.string().optional(),
  title: z.string().optional(),
  username: z.string().optional(),
});

export type TelegramChat = z.infer<typeof telegramChatSchema>;

/** Входящее сообщение. */
export const telegramMessageSchema = z.object({
  message_id: z.number().int(),
  date: z.number().int().optional(),
  chat: telegramChatSchema,
  from: z
    .object({
      id: z.number().int(),
      is_bot: z.boolean().optional(),
      username: z.string().optional(),
      first_name: z.string().optional(),
    })
    .optional(),
  text: z.string().optional(),
  caption: z.string().optional(),
});

export type TelegramMessage = z.infer<typeof telegramMessageSchema>;

/** Нажатие inline-кнопки. */
export const telegramCallbackQuerySchema = z.object({
  id: z.string().min(1),
  from: z.object({ id: z.number().int() }),
  data: z.string().optional(),
  message: z
    .object({
      message_id: z.number().int(),
      chat: telegramChatSchema,
    })
    .optional(),
});

export type TelegramCallbackQuery = z.infer<
  typeof telegramCallbackQuerySchema
>;

/** Update от Telegram: сообщение, callback или служебное обновление. */
export const telegramUpdateSchema = z.object({
  update_id: z.number().int(),
  message: telegramMessageSchema.optional(),
  edited_message: telegramMessageSchema.optional(),
  callback_query: telegramCallbackQuerySchema.optional(),
});

export type TelegramUpdate = z.infer<typeof telegramUpdateSchema>;

/** Успешный ответ sendMessage. */
export const telegramSendMessageResultSchema = z.object({
  ok: z.literal(true),
  result: z.object({
    message_id: z.number().int(),
    date: z.number().int().optional(),
    chat: telegramChatSchema,
    text: z.string().optional(),
  }),
});

/** Ответ answerCallbackQuery/setWebhook. */
export const telegramOkResultSchema = z.object({
  ok: z.literal(true),
  result: z.union([z.boolean(), z.record(z.string(), z.unknown())]),
});

/** Ответ getMe: бот, которому принадлежит токен. */
export const telegramGetMeSchema = z.object({
  ok: z.literal(true),
  result: z.object({
    id: z.number().int(),
    is_bot: z.boolean(),
    first_name: z.string(),
    username: z.string().optional(),
  }),
});

/** Ошибка Telegram (используется при разборе в provider-http). */
export const telegramErrorSchema = z.object({
  ok: z.literal(false),
  error_code: z.number().int().optional(),
  description: z.string().optional(),
  parameters: z
    .object({ retry_after: z.number().optional() })
    .optional(),
});

/** Текст сообщения: либо text, либо caption (для медиа). */
export function messageText(message: TelegramMessage): string | null {
  const text = message.text ?? message.caption;

  return text === undefined || text.trim() === '' ? null : text;
}

import { z } from 'zod';
import {
  assertProviderResponse,
  hitlButtons,
  parseCorpHitlData,
  resolveBaseUrl,
  type CorpIncomingMessage,
  type CorpSendInput,
  ICorpMessengerAdapter,
} from './corp-messenger.types.js';

const vkChatId = z.union([z.string().min(1), z.number().int()]);

const vkNewMessageSchema = z.object({
  type: z.literal('newMessage'),
  chat: z.object({ chatId: vkChatId }),
  text: z.string().optional(),
  payload: z.object({ text: z.string().optional() }).optional(),
});

const vkCallbackSchema = z.object({
  type: z.literal('callbackQuery'),
  chat: z.object({ chatId: vkChatId }).optional(),
  chat_id: vkChatId.optional(),
  callback_data: z.string().min(1),
});

const vkUpdateSchema = z.discriminatedUnion('type', [
  vkNewMessageSchema,
  vkCallbackSchema,
]);

const VK_TEAMS_DEFAULT_BASE_URL = 'https://mail.ru';

/** Адаптер VK Teams (OMNI-40.2). */
export class VkTeamsAdapter implements ICorpMessengerAdapter {
  readonly provider = 'vk_teams' as const;

  constructor(private readonly fetchFn: typeof fetch = fetch) {}

  parseIncomingWebhook(
    payload: unknown,
    _headers: Readonly<Record<string, string>>,
  ): CorpIncomingMessage | null {
    const parsed = vkUpdateSchema.safeParse(payload);

    if (!parsed.success) {
      return null;
    }

    const update = parsed.data;

    if (update.type === 'callbackQuery') {
      const chatId = update.chat?.chatId ?? update.chat_id;

      if (chatId === undefined) {
        return null;
      }

      const hitl = parseCorpHitlData(update.callback_data);

      return hitl === null
        ? null
        : { chatId: String(chatId), text: '', hitl };
    }

    const text = update.text ?? update.payload?.text;

    return text === undefined || text.trim() === ''
      ? null
      : { chatId: String(update.chat.chatId), text };
  }

  async sendTextMessage(input: CorpSendInput): Promise<void> {
    const buttons =
      input.hitlRunId === undefined ? undefined : hitlButtons(input.hitlRunId);
    const response = await this.fetchFn(
      `${resolveBaseUrl(input.baseUrl, VK_TEAMS_DEFAULT_BASE_URL)}/messages/sendText`,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          Authorization: `Bearer ${input.token}`,
        },
        body: JSON.stringify({
          chatId: input.chatId,
          text: input.text,
          ...(buttons === undefined
            ? {}
            : {
                inlineKeyboardMarkup: [
                  buttons.map((button) => ({
                    text: button.text,
                    callbackData: button.callbackData,
                  })),
                ],
              }),
        }),
        signal: AbortSignal.timeout(15_000),
      },
    );

    await assertProviderResponse(response, this.provider);
  }
}

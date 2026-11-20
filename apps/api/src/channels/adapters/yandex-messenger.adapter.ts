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

const yandexChatId = z.union([z.string().min(1), z.number().int()]);

const yandexUpdateItemSchema = z.object({
  type: z.enum(['text', 'button', 'callback']),
  chat_id: yandexChatId.optional(),
  text: z.string().optional(),
  callback_data: z.string().optional(),
});

const yandexUpdateSchema = z.object({
  type: z.literal('updates'),
  updates: z.array(yandexUpdateItemSchema).min(1),
});

const YANDEX_DEFAULT_BASE_URL = 'https://yandex.net';

/** Адаптер Яндекс Мессенджера (OMNI-40.4). */
export class YandexMessengerAdapter implements ICorpMessengerAdapter {
  readonly provider = 'yandex_messenger' as const;

  constructor(private readonly fetchFn: typeof fetch = fetch) {}

  parseIncomingWebhook(
    payload: unknown,
    _headers: Readonly<Record<string, string>>,
  ): CorpIncomingMessage | null {
    const parsed = yandexUpdateSchema.safeParse(payload);

    if (!parsed.success) {
      return null;
    }

    const item = parsed.data.updates[0]!;

    if (item.chat_id === undefined) {
      return null;
    }

    const chatId = String(item.chat_id);

    if (item.type !== 'text') {
      const hitl = parseCorpHitlData(item.callback_data);

      return hitl === null ? null : { chatId, text: '', hitl };
    }

    return item.text === undefined || item.text.trim() === ''
      ? null
      : { chatId, text: item.text };
  }

  async sendTextMessage(input: CorpSendInput): Promise<void> {
    const buttons =
      input.hitlRunId === undefined ? undefined : hitlButtons(input.hitlRunId);
    const response = await this.fetchFn(
      `${resolveBaseUrl(input.baseUrl, YANDEX_DEFAULT_BASE_URL)}/messages/sendText/`,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          Authorization: `OAuth ${input.token}`,
        },
        body: JSON.stringify({
          chat_id: input.chatId,
          text: input.text,
          ...(buttons === undefined
            ? {}
            : {
                inline_keyboard: [
                  buttons.map((button) => ({
                    text: button.text,
                    callback_data: button.callbackData,
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

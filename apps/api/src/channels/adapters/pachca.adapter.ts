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

const pachcaChatId = z.union([z.string().min(1), z.number().int()]);

const pachcaMessageSchema = z.object({
  type: z.literal('message'),
  chat_id: pachcaChatId.optional(),
  message: z
    .object({
      chat_id: pachcaChatId.optional(),
      content: z.string().optional(),
      text: z.string().optional(),
    })
    .optional(),
  content: z.string().optional(),
  text: z.string().optional(),
});

const pachcaButtonSchema = z.object({
  type: z.literal('button'),
  chat_id: pachcaChatId.optional(),
  callback_data: z.string().optional(),
  data: z.object({ callback_data: z.string().optional() }).optional(),
});

const pachcaUpdateSchema = z.discriminatedUnion('type', [
  pachcaMessageSchema,
  pachcaButtonSchema,
]);

const PACHCA_DEFAULT_BASE_URL = 'https://pachca.com';

/** Адаптер Пачки (OMNI-40.3). */
export class PachcaAdapter implements ICorpMessengerAdapter {
  readonly provider = 'pachca' as const;

  constructor(private readonly fetchFn: typeof fetch = fetch) {}

  parseIncomingWebhook(
    payload: unknown,
    _headers: Readonly<Record<string, string>>,
  ): CorpIncomingMessage | null {
    const parsed = pachcaUpdateSchema.safeParse(payload);

    if (!parsed.success) {
      return null;
    }

    const update = parsed.data;

    if (update.type === 'button') {
      const chatId = update.chat_id;

      if (chatId === undefined) {
        return null;
      }

      const hitl = parseCorpHitlData(
        update.callback_data ?? update.data?.callback_data,
      );

      return hitl === null
        ? null
        : { chatId: String(chatId), text: '', hitl };
    }

    const chatId = update.chat_id ?? update.message?.chat_id;
    const text = update.content ?? update.text ?? update.message?.content ?? update.message?.text;

    if (chatId === undefined || text === undefined || text.trim() === '') {
      return null;
    }

    return { chatId: String(chatId), text };
  }

  async sendTextMessage(input: CorpSendInput): Promise<void> {
    const buttons =
      input.hitlRunId === undefined ? undefined : hitlButtons(input.hitlRunId);
    const response = await this.fetchFn(
      `${resolveBaseUrl(input.baseUrl, PACHCA_DEFAULT_BASE_URL)}/messages`,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          Authorization: `Bearer ${input.token}`,
        },
        body: JSON.stringify({
          chat_id: input.chatId,
          content: input.text,
          ...(buttons === undefined
            ? {}
            : {
                actions: buttons.map((button) => ({
                  text: button.text,
                  callback_data: button.callbackData,
                })),
              }),
        }),
        signal: AbortSignal.timeout(15_000),
      },
    );

    await assertProviderResponse(response, this.provider);
  }
}

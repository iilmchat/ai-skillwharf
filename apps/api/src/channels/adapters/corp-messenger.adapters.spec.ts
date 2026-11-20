import { describe, expect, it, vi } from 'vitest';
import { PachcaAdapter } from './pachca.adapter.js';
import { VkTeamsAdapter } from './vk-teams.adapter.js';
import { YandexMessengerAdapter } from './yandex-messenger.adapter.js';

const RUN_ID = 'run-123';

function fetchMock() {
  return vi.fn(async () => ({ ok: true, status: 200 }));
}

function requestOf(mock: ReturnType<typeof vi.fn>) {
  const [url, init] = mock.mock.calls[0] as unknown as [string, RequestInit];

  return { url, init, body: JSON.parse(init.body as string) as Record<string, unknown> };
}

describe('VkTeamsAdapter (OMNI-40.2)', () => {
  const adapter = new VkTeamsAdapter();

  it('парсит newMessage и callbackQuery', () => {
    expect(
      adapter.parseIncomingWebhook(
        {
          type: 'newMessage',
          chat: { chatId: 100 },
          payload: { text: 'привет' },
        },
        {},
      ),
    ).toEqual({ chatId: '100', text: 'привет' });
    expect(
      adapter.parseIncomingWebhook(
        {
          type: 'callbackQuery',
          chat_id: 100,
          callback_data: `hitl:approve:${RUN_ID}`,
        },
        {},
      ),
    ).toEqual({ chatId: '100', text: '', hitl: { action: 'approve', runId: RUN_ID } });
    expect(adapter.parseIncomingWebhook({ unknown: true }, {})).toBeNull();
  });

  it('отправляет sendText с inlineKeyboardMarkup при HITL', async () => {
    const fetch = fetchMock();

    await new VkTeamsAdapter(fetch as unknown as typeof fetch).sendTextMessage({
      baseUrl: 'https://vk.example.com/',
      token: 'vk-token',
      chatId: '100',
      text: 'Одобрить?',
      hitlRunId: RUN_ID,
    });

    const { url, body, init } = requestOf(fetch);

    expect(url).toBe('https://vk.example.com/messages/sendText');
    expect((init.headers as Record<string, string>).Authorization).toBe(
      'Bearer vk-token',
    );
    const keyboard = body.inlineKeyboardMarkup as Array<
      Array<{ callbackData: string }>
    >;

    expect(keyboard[0]?.map((button) => button.callbackData)).toEqual([
      `hitl:approve:${RUN_ID}`,
      `hitl:reject:${RUN_ID}`,
    ]);
  });
});

describe('PachcaAdapter (OMNI-40.3)', () => {
  const adapter = new PachcaAdapter();

  it('парсит message и button', () => {
    expect(
      adapter.parseIncomingWebhook(
        { type: 'message', chat_id: 42, message: { content: 'накладная' } },
        {},
      ),
    ).toEqual({ chatId: '42', text: 'накладная' });
    expect(
      adapter.parseIncomingWebhook(
        {
          type: 'button',
          chat_id: 42,
          data: { callback_data: `hitl:reject:${RUN_ID}` },
        },
        {},
      ),
    ).toEqual({ chatId: '42', text: '', hitl: { action: 'reject', runId: RUN_ID } });
  });

  it('отправляет POST /messages с Bearer и actions', async () => {
    const fetch = fetchMock();

    await new PachcaAdapter(fetch as unknown as typeof fetch).sendTextMessage({
      baseUrl: null,
      token: 'pachca-token',
      chatId: '42',
      text: 'Отчёт',
      hitlRunId: RUN_ID,
    });

    const { url, body, init } = requestOf(fetch);

    expect(url).toBe('https://pachca.com/messages');
    expect((init.headers as Record<string, string>).Authorization).toBe(
      'Bearer pachca-token',
    );
    expect(body.content).toBe('Отчёт');
    expect(body.actions).toBeDefined();
  });
});

describe('YandexMessengerAdapter (OMNI-40.4)', () => {
  const adapter = new YandexMessengerAdapter();

  it('парсит updates text и button', () => {
    expect(
      adapter.parseIncomingWebhook(
        { type: 'updates', updates: [{ type: 'text', chat_id: 'c1', text: 'заказ' }] },
        {},
      ),
    ).toEqual({ chatId: 'c1', text: 'заказ' });
    expect(
      adapter.parseIncomingWebhook(
        {
          type: 'updates',
          updates: [
            { type: 'button', chat_id: 'c1', callback_data: `hitl:approve:${RUN_ID}` },
          ],
        },
        {},
      ),
    ).toEqual({ chatId: 'c1', text: '', hitl: { action: 'approve', runId: RUN_ID } });
  });

  it('отправляет OAuth и inline_keyboard', async () => {
    const fetch = fetchMock();

    await new YandexMessengerAdapter(
      fetch as unknown as typeof fetch,
    ).sendTextMessage({
      baseUrl: 'https://ym.example.com',
      token: 'yam-token',
      chatId: 'c1',
      text: 'Готово',
      hitlRunId: RUN_ID,
    });

    const { url, body, init } = requestOf(fetch);

    expect(url).toBe('https://ym.example.com/messages/sendText/');
    expect((init.headers as Record<string, string>).Authorization).toBe(
      'OAuth yam-token',
    );
    expect(body.inline_keyboard).toBeDefined();
  });
});

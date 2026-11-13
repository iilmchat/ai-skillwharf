import nock from 'nock';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ApiException } from '../../common/api-error.js';
import { ERROR_KEYS } from '../../i18n/error-keys.js';
import { TelegramConfig } from './telegram.config.js';
import type { ProviderRetryPolicy } from '../provider-http.js';
import {
  TelegramService,
  TELEGRAM_MESSAGE_LIMIT,
  splitTelegramText,
} from './telegram.service.js';

const BASE = 'https://api.telegram.org';
const BOT_TOKEN = '123456:TEST-TOKEN';

const RETRY: ProviderRetryPolicy = {
  maxAttempts: 3,
  baseDelayMs: 1,
  maxDelayMs: 2,
  maxRetryAfterMs: 1_000,
};

function createService(): TelegramService {
  return new TelegramService(
    new TelegramConfig(BOT_TOKEN, 'webhook-secret', BASE),
    RETRY,
  );
}

function sendMessageResponse(messageId: number, chatId: number): unknown {
  return {
    ok: true,
    result: {
      message_id: messageId,
      date: 1_700_000_000,
      chat: { id: chatId, type: 'private' },
      text: 'ok',
    },
  };
}

describe('TelegramService (Telegram Bot API)', () => {
  beforeEach(() => {
    nock.disableNetConnect();
    delete process.env.OUTBOUND_ALLOWLIST;
    delete process.env.API_OUTBOUND_ALLOWLIST;
  });

  afterEach(() => {
    nock.cleanAll();
    nock.enableNetConnect();
  });

  it('отправляет сообщение и возвращает message_id/chat_id', async () => {
    const scope = nock(BASE)
      .post(`/bot${BOT_TOKEN}/sendMessage`, (body: unknown) => {
        const record = body as Record<string, unknown>;

        expect(record.chat_id).toBe('42');
        expect(record.text).toBe('привет');
        expect(record.disable_web_page_preview).toBe(true);

        return true;
      })
      .reply(200, sendMessageResponse(7, 42));

    const result = await createService().sendMessage({
      chatId: 42,
      text: 'привет',
    });

    expect(result).toEqual({ messageId: 7, chatId: '42' });
    expect(scope.isDone()).toBe(true);
  });

  it('превращает кнопки в inline_keyboard', async () => {
    let keyboard: unknown;

    nock(BASE)
      .post(`/bot${BOT_TOKEN}/sendMessage`, (body: unknown) => {
        keyboard = (body as Record<string, unknown>).reply_markup;

        return true;
      })
      .reply(200, sendMessageResponse(1, 42));

    await createService().sendMessage({
      chatId: 42,
      text: 'выбор',
      buttons: [
        { text: 'Сайт', url: 'https://example.com' },
        { text: 'Ок', callbackData: 'ok' },
      ],
    });

    expect(keyboard).toEqual({
      inline_keyboard: [
        [{ text: 'Сайт', url: 'https://example.com' }],
        [{ text: 'Ок', callback_data: 'ok' }],
      ],
    });
  });

  it('повторяет запрос после 429 и учитывает retry_after', async () => {
    nock(BASE)
      .post(`/bot${BOT_TOKEN}/sendMessage`)
      .reply(429, {
        ok: false,
        error_code: 429,
        description: 'Too Many Requests: retry after 0',
        parameters: { retry_after: 0 },
      });
    nock(BASE)
      .post(`/bot${BOT_TOKEN}/sendMessage`)
      .reply(200, sendMessageResponse(9, 42));

    const result = await createService().sendMessage({
      chatId: 42,
      text: 'после лимита',
    });

    expect(result.messageId).toBe(9);
  });

  it('после исчерпания повторов отдаёт 429 provider_rate_limited', async () => {
    nock(BASE)
      .post(`/bot${BOT_TOKEN}/sendMessage`)
      .times(3)
      .reply(429, {
        ok: false,
        error_code: 429,
        description: 'Too Many Requests',
        parameters: { retry_after: 0 },
      });

    const error: unknown = await createService()
      .sendMessage({ chatId: 42, text: 'x' })
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ApiException);
    expect((error as ApiException).getResponse()).toMatchObject({
      statusCode: 429,
      code: ERROR_KEYS.providerRateLimited,
    });
  });

  it('401 от Telegram превращается в provider_auth_required', async () => {
    nock(BASE)
      .post(`/bot${BOT_TOKEN}/sendMessage`)
      .reply(401, {
        ok: false,
        error_code: 401,
        description: 'Unauthorized',
      });

    const error: unknown = await createService()
      .sendMessage({ chatId: 42, text: 'x' })
      .catch((caught: unknown) => caught);

    expect((error as ApiException).getResponse()).toMatchObject({
      statusCode: 502,
      code: ERROR_KEYS.providerAuthRequired,
    });
  });

  it('400 (например, chat not found) не ретраится', async () => {
    const scope = nock(BASE)
      .post(`/bot${BOT_TOKEN}/sendMessage`)
      .reply(400, {
        ok: false,
        error_code: 400,
        description: 'Bad Request: chat not found',
      });

    const error: unknown = await createService()
      .sendMessage({ chatId: 42, text: 'x' })
      .catch((caught: unknown) => caught);

    expect((error as ApiException).getResponse()).toMatchObject({
      statusCode: 400,
      code: ERROR_KEYS.invalidRequest,
    });
    expect(scope.isDone()).toBe(true);
  });

  it('getMe проверяет токен бота', async () => {
    nock(BASE)
      .get(`/bot${BOT_TOKEN}/getMe`)
      .reply(200, {
        ok: true,
        result: {
          id: 1,
          is_bot: true,
          first_name: 'Wharf',
          username: 'wharf_bot',
        },
      });

    await expect(createService().getMe()).resolves.toEqual({
      id: 1,
      name: 'Wharf',
      username: 'wharf_bot',
    });
  });

  it('без токена не делает сетевых запросов', async () => {
    const service = new TelegramService(
      new TelegramConfig(null, null, BASE),
      RETRY,
    );
    const error: unknown = await service
      .sendMessage({ chatId: 1, text: 'x' })
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ApiException);
    expect((error as ApiException).getResponse()).toMatchObject({
      statusCode: 503,
      code: ERROR_KEYS.providerNotConfigured,
    });
  });

  it('sendText режет длинный ответ на части', async () => {
    const long = 'a'.repeat(TELEGRAM_MESSAGE_LIMIT + 10);
    const scope = nock(BASE)
      .post(`/bot${BOT_TOKEN}/sendMessage`)
      .times(2)
      .reply(200, sendMessageResponse(1, 42));

    await createService().sendText(42, long);

    expect(scope.isDone()).toBe(true);
  });
});

describe('splitTelegramText', () => {
  it('не режет короткий текст', () => {
    expect(splitTelegramText('привет')).toEqual(['привет']);
  });

  it('делит по строкам и словам без потери содержания', () => {
    const text = ['первая строка', 'вторая строка', 'x'.repeat(30)].join('\n');

    const parts = splitTelegramText(text, 20);

    expect(parts.length).toBeGreaterThan(1);
    expect(parts.join('').replace(/\s/g, '')).toBe(
      text.replace(/\s/g, ''),
    );
    expect(parts.every((part) => part.length <= 20)).toBe(true);
  });

  it('пустой текст — пустой список', () => {
    expect(splitTelegramText('   ')).toEqual([]);
  });
});

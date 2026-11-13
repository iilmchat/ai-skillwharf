import { UnauthorizedException } from '@nestjs/common';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ChatService } from '../../chat/chat.service.js';
import type { TelegramLinkService } from './telegram-link.service.js';
import { TelegramConfig } from './telegram.config.js';
import {
  TELEGRAM_WEBHOOK_RATE_LIMIT,
  TelegramWebhookService,
  resolveTelegramWebhookRateLimit,
  safeEqual,
} from './telegram-webhook.service.js';
import type { TelegramService } from './telegram.service.js';

const SECRET = 'secret-token';

const update = {
  update_id: 1,
  message: {
    message_id: 10,
    date: 1_700_000_000,
    chat: { id: 42, type: 'private' },
    text: 'привет',
  },
};

function setup(
  options: { linked?: boolean; reply?: string } = {},
): {
  service: TelegramWebhookService;
  sendText: ReturnType<typeof vi.fn>;
  handleMessage: ReturnType<typeof vi.fn>;
} {
  const sendText = vi.fn(async () => ({ messageId: 1, chatId: '42' }));
  const handleMessage = vi.fn(async () => ({
    conversationId: 'c1',
    reply: options.reply ?? 'ответ',
  }));
  const links = {
    findByChatId: vi.fn(async () =>
      options.linked === false
        ? null
        : {
            chatId: '42',
            userId: 'u1',
            conversationId: 'c1',
            createdAt: new Date(),
          },
    ),
  };
  const service = new TelegramWebhookService(
    { sendText, answerCallbackQuery: vi.fn() } as unknown as TelegramService,
    links as unknown as TelegramLinkService,
    { handleMessage } as unknown as ChatService,
    new TelegramConfig('bot-token', SECRET, 'https://api.telegram.org'),
  );

  return { service, sendText, handleMessage };
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('TelegramWebhookService', () => {
  it('принимает update с правильным секретом', async () => {
    const { service, handleMessage, sendText } = setup();

    await expect(service.handle(SECRET, update)).resolves.toEqual({ ok: true });
    expect(handleMessage).toHaveBeenCalledWith('u1', 'c1', 'привет');
    expect(sendText).toHaveBeenCalledWith('42', 'ответ');
  });

  it('отклоняет отсутствующий и неверный секрет', async () => {
    const { service } = setup();

    await expect(service.handle(undefined, update)).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
    await expect(service.handle('wrong', update)).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
  });

  it('не принимает update без настроенного секрета (fail closed)', async () => {
    const { service } = setup();
    const unconfigured = new TelegramWebhookService(
      { sendText: vi.fn(), answerCallbackQuery: vi.fn() } as unknown as TelegramService,
      { findByChatId: vi.fn() } as unknown as TelegramLinkService,
      { handleMessage: vi.fn() } as unknown as ChatService,
      new TelegramConfig('bot-token', null, 'https://api.telegram.org'),
    );

    await expect(unconfigured.handle(undefined, update)).rejects.toThrow(
      /TELEGRAM_WEBHOOK_SECRET/,
    );
    expect(service).toBeDefined();
  });

  it('подсказывает привязать чат для неизвестного chat_id', async () => {
    const { service, sendText, handleMessage } = setup({ linked: false });

    await service.handle(SECRET, update);

    expect(handleMessage).not.toHaveBeenCalled();
    expect(sendText).toHaveBeenCalledWith(
      '42',
      expect.stringContaining('не привязан'),
    );
  });

  it('сравнивает секреты constant-time и не падает на разной длине', () => {
    expect(safeEqual(SECRET, SECRET)).toBe(true);
    expect(safeEqual(SECRET, 'other')).toBe(false);
    expect(safeEqual('short', 'longer-secret')).toBe(false);
  });

  it('читает лимит webhook из env', () => {
    expect(resolveTelegramWebhookRateLimit({ TELEGRAM_WEBHOOK_RATE_LIMIT: '7' })).toBe(7);
    expect(TELEGRAM_WEBHOOK_RATE_LIMIT).toBeGreaterThan(0);
  });
});

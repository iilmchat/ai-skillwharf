import type { Request } from 'express';
import { describe, expect, it, vi } from 'vitest';
import { IntegrationsController } from './integrations.controller.js';
import type { TelegramBotService } from './telegram/telegram-bot.service.js';
import type { TelegramLinkService } from './telegram/telegram-link.service.js';
import type { GoogleOAuthService } from './google/google-oauth.service.js';

type MockFn = ReturnType<typeof vi.fn>;

interface Harness {
  controller: IntegrationsController;
  bots: { describe: MockFn; connect: MockFn; disconnect: MockFn };
  links: { listForUser: MockFn; unlink: MockFn };
  google: { status: MockFn };
}

function request(userId = 'user-1'): Request {
  return { user: { userId, email: 'u@example.com', role: 'user' } } as unknown as Request;
}

function createHarness(): Harness {
  const bots = {
    describe: vi.fn(async () => ({
      status: 'active' as const,
      botName: 'Wharf',
      botUsername: 'wharf_bot',
    })),
    connect: vi.fn(async () => ({
      id: 1,
      name: 'Wharf',
      username: 'wharf_bot',
    })),
    disconnect: vi.fn(async () => true),
  };
  const links = {
    listForUser: vi.fn(async () => [
      { chatId: '42', userId: 'user-1', conversationId: 'c1', createdAt: new Date() },
    ]),
    unlink: vi.fn(async () => true),
  };
  const google = {
    status: vi.fn(async () => ({
      configured: true,
      connected: true,
      email: 'user@example.com',
    })),
  };
  const controller = new IntegrationsController(
    bots as unknown as TelegramBotService,
    links as unknown as TelegramLinkService,
    google as unknown as GoogleOAuthService,
  );

  return { controller, bots, links, google };
}

describe('IntegrationsController (контракт UI)', () => {
  it('GET /integrations отдаёт состояние обоих провайдеров', async () => {
    const { controller } = createHarness();

    await expect(controller.status(request())).resolves.toEqual({
      telegram: {
        status: 'active',
        botName: 'Wharf',
        botUsername: 'wharf_bot',
      },
      google: {
        status: 'active',
        email: 'user@example.com',
      },
    });
  });

  it('POST /integrations/telegram проверяет токен и возвращает бота', async () => {
    const { controller, bots } = createHarness();

    await expect(
      controller.connectTelegram(request(), { botToken: '123:abc' }),
    ).resolves.toEqual({
      status: 'active',
      botName: 'Wharf',
      botUsername: 'wharf_bot',
    });
    expect(bots.connect).toHaveBeenCalledWith('user-1', '123:abc');
  });

  it('POST /integrations/telegram требует botToken', async () => {
    const { controller } = createHarness();

    await expect(
      controller.connectTelegram(request(), {}),
    ).rejects.toMatchObject({ status: 400 });
  });

  it('DELETE /integrations/telegram удаляет бота и привязки чатов', async () => {
    const { controller, links, bots } = createHarness();

    await expect(controller.disconnectTelegram(request())).resolves.toEqual({
      disconnected: true,
    });
    expect(links.listForUser).toHaveBeenCalledWith('user-1');
    expect(links.unlink).toHaveBeenCalledWith('user-1', '42');
    expect(bots.disconnect).toHaveBeenCalledWith('user-1');
  });

  it('без пользователя отдаёт 401', async () => {
    const { controller } = createHarness();

    await expect(
      controller.status({} as unknown as Request),
    ).rejects.toMatchObject({ status: 401 });
  });
});

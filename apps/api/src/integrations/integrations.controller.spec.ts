import type { Request } from 'express';
import { describe, expect, it, vi } from 'vitest';
import { IntegrationsController } from './integrations.controller.js';
import type { TelegramBotService } from './telegram/telegram-bot.service.js';
import type { TelegramLinkService } from './telegram/telegram-link.service.js';
import type { GoogleOAuthService } from './google/google-oauth.service.js';
import type { ProviderKeysService } from './keys/provider-keys.service.js';

type MockFn = ReturnType<typeof vi.fn>;

interface Harness {
  controller: IntegrationsController;
  bots: { describe: MockFn; connect: MockFn; disconnect: MockFn };
  links: { listForUser: MockFn; unlink: MockFn };
  google: { status: MockFn };
  keys: {
    describe: MockFn;
    connectOzon: MockFn;
    connectWildberries: MockFn;
    connectMidjourney: MockFn;
    disconnect: MockFn;
  };
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
  const keys = {
    describe: vi.fn(async () => ({
      ozon: {
        status: 'active' as const,
        clientId: 'ozon-client-123',
        source: 'user' as const,
      },
      wildberries: {
        status: 'active' as const,
        tokenExpiresAt: '2027-05-12T12:00:00.000Z',
        source: 'user' as const,
      },
      midjourney: { status: 'disconnected' as const },
    })),
    connectOzon: vi.fn(async () => ({
      status: 'active' as const,
      clientId: 'ozon-client-123',
      source: 'user' as const,
    })),
    connectWildberries: vi.fn(async () => ({
      status: 'active' as const,
      tokenExpiresAt: '2027-05-12T12:00:00.000Z',
      source: 'user' as const,
    })),
    connectMidjourney: vi.fn(async () => ({
      status: 'active' as const,
      source: 'user' as const,
    })),
    disconnect: vi.fn(async () => true),
  };
  const controller = new IntegrationsController(
    bots as unknown as TelegramBotService,
    links as unknown as TelegramLinkService,
    google as unknown as GoogleOAuthService,
    keys as unknown as ProviderKeysService,
  );

  return { controller, bots, links, google, keys };
}

describe('IntegrationsController (контракт UI)', () => {
  it('GET /integrations отдаёт состояние всех провайдеров', async () => {
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
      ozon: {
        status: 'active',
        clientId: 'ozon-client-123',
        source: 'user',
      },
      wildberries: {
        status: 'active',
        tokenExpiresAt: '2027-05-12T12:00:00.000Z',
        source: 'user',
      },
      midjourney: { status: 'disconnected' },
    });
  });

  it('GET /integrations отдаёт disconnected, если ключей нет', async () => {
    const { controller, keys } = createHarness();

    keys.describe.mockResolvedValueOnce({
      ozon: { status: 'disconnected' },
      wildberries: { status: 'disconnected' },
      midjourney: { status: 'disconnected' },
    });

    const state = await controller.status(request());

    expect(state.ozon.status).toBe('disconnected');
    expect(state.wildberries.status).toBe('disconnected');
    expect(state.midjourney.status).toBe('disconnected');
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

  it('POST /integrations/ozon сохраняет ключи и возвращает статус', async () => {
    const { controller, keys } = createHarness();

    await expect(
      controller.connectOzon(request(), {
        clientId: 'ozon-client-123',
        apiKey: 'ozon-secret',
      }),
    ).resolves.toMatchObject({ status: 'active', clientId: 'ozon-client-123' });
    expect(keys.connectOzon).toHaveBeenCalledWith('user-1', {
      clientId: 'ozon-client-123',
      apiKey: 'ozon-secret',
    });
  });

  it('POST /integrations/ozon требует clientId и apiKey', async () => {
    const { controller, keys } = createHarness();

    await expect(
      controller.connectOzon(request(), { clientId: '123' }),
    ).rejects.toMatchObject({ status: 400 });
    expect(keys.connectOzon).not.toHaveBeenCalled();
  });

  it('POST /integrations/wildberries сохраняет токен и срок действия', async () => {
    const { controller, keys } = createHarness();

    await expect(
      controller.connectWildberries(request(), { apiToken: 'wb-token' }),
    ).resolves.toMatchObject({
      status: 'active',
      tokenExpiresAt: '2027-05-12T12:00:00.000Z',
    });
    expect(keys.connectWildberries).toHaveBeenCalledWith('user-1', {
      apiToken: 'wb-token',
    });
  });

  it('POST /integrations/midjourney сохраняет ключ TTAPI', async () => {
    const { controller, keys } = createHarness();

    await expect(
      controller.connectMidjourney(request(), { apiKey: 'tt-api-key' }),
    ).resolves.toMatchObject({ status: 'active' });
    expect(keys.connectMidjourney).toHaveBeenCalledWith('user-1', {
      apiKey: 'tt-api-key',
    });
  });

  it('DELETE /integrations/{provider} удаляет ключи только своего провайдера', async () => {
    const { controller, keys } = createHarness();

    await expect(controller.disconnectOzon(request())).resolves.toEqual({
      disconnected: true,
    });
    await expect(controller.disconnectWildberries(request())).resolves.toEqual({
      disconnected: true,
    });
    await expect(controller.disconnectMidjourney(request())).resolves.toEqual({
      disconnected: true,
    });

    expect(keys.disconnect.mock.calls).toEqual([
      ['user-1', 'ozon'],
      ['user-1', 'wildberries'],
      ['user-1', 'midjourney'],
    ]);
  });

  it('без пользователя отдаёт 401', async () => {
    const { controller } = createHarness();

    await expect(
      controller.status({} as unknown as Request),
    ).rejects.toMatchObject({ status: 401 });
    await expect(
      controller.connectOzon({} as unknown as Request, {
        clientId: '1',
        apiKey: '2',
      }),
    ).rejects.toMatchObject({ status: 401 });
    await expect(
      controller.disconnectMidjourney({} as unknown as Request),
    ).rejects.toMatchObject({ status: 401 });
  });
});

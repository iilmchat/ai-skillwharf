import { describe, expect, it, vi } from 'vitest';
// Реальная Zod-схема UI: импорт из `apps/web` допустим только в тесте
// (сборка API код web не тянет). При расхождении контракта тест падает.
import { integrationsSchema } from '../../../web/src/lib/integrations.js';
import type { Request } from 'express';
import { IntegrationsController } from './integrations.controller.js';
import type { GoogleOAuthService } from './google/google-oauth.service.js';
import type { ProviderKeysService } from './keys/provider-keys.service.js';
import type { TelegramBotService } from './telegram/telegram-bot.service.js';
import type { TelegramLinkService } from './telegram/telegram-link.service.js';

function request(userId = 'user-1'): Request {
  return {
    user: { userId, email: 'user@example.com', role: 'user' },
  } as unknown as Request;
}

function createController(keys: {
  describe: () => Promise<unknown>;
}): IntegrationsController {
  return new IntegrationsController(
    {
      describe: vi.fn(async () => ({ status: 'disconnected' })),
      connect: vi.fn(),
      disconnect: vi.fn(async () => false),
    } as unknown as TelegramBotService,
    {
      listForUser: vi.fn(async () => []),
      unlink: vi.fn(),
    } as unknown as TelegramLinkService,
    {
      status: vi.fn(async () => ({ configured: false, connected: false })),
    } as unknown as GoogleOAuthService,
    {
      describe: keys.describe,
    } as unknown as ProviderKeysService,
  );
}

describe('GET /integrations совместим с Zod-схемой UI', () => {
  it('все провайдеры отключены', async () => {
    const controller = createController({
      describe: async () => ({
        ozon: { status: 'disconnected' },
        wildberries: { status: 'disconnected' },
        midjourney: { status: 'disconnected' },
      }),
    });

    const state = await controller.status(request());

    expect(integrationsSchema.parse(state)).toMatchObject({
      telegram: { status: 'disconnected' },
      google: { status: 'disconnected' },
      ozon: { status: 'disconnected' },
      wildberries: { status: 'disconnected' },
      midjourney: { status: 'disconnected' },
    });
  });

  it('ключи подключены: active, clientId и срок токена WB проходят схему', async () => {
    const controller = createController({
      describe: async () => ({
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
        midjourney: { status: 'active', source: 'user' },
      }),
    });

    const parsed = integrationsSchema.parse(await controller.status(request()));

    expect(parsed.ozon).toMatchObject({
      status: 'active',
      clientId: 'ozon-client-123',
    });
    expect(parsed.wildberries.status).toBe('active');
    expect(parsed.wildberries.tokenExpiresAt).toBe('2027-05-12T12:00:00.000Z');
    expect(parsed.midjourney.status).toBe('active');
  });

  it('системные ключи и ошибки расшифровки тоже валидны для UI', async () => {
    const controller = createController({
      describe: async () => ({
        ozon: { status: 'active', source: 'env' },
        wildberries: {
          status: 'error',
          tokenExpiresAt: '2026-01-01T00:00:00.000Z',
          source: 'user',
          error: 'Срок действия токена Wildberries истёк',
        },
        midjourney: {
          status: 'error',
          error: 'Ключи сохранены, но не расшифровываются',
        },
      }),
    });

    const parsed = integrationsSchema.parse(await controller.status(request()));

    expect(parsed.ozon.status).toBe('active');
    expect(parsed.ozon.clientId).toBeUndefined();
    expect(parsed.wildberries.status).toBe('error');
    expect(parsed.wildberries.error).toContain('истёк');
    expect(parsed.midjourney.status).toBe('error');
  });
});

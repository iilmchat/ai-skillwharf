import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiException } from '../../common/api-error.js';
import { ERROR_KEYS } from '../../i18n/error-keys.js';
import type { ProviderKeysService } from '../../integrations/keys/provider-keys.service.js';
import { MarketplaceMcpService } from './marketplace-mcp.service.js';

type MockFn = ReturnType<typeof vi.fn>;

interface KeysMock {
  ozonKeys: MockFn;
  wildberriesToken: MockFn;
  bitrix24Webhook: MockFn;
  moyskladToken: MockFn;
}

function createKeysMock(): KeysMock {
  return {
    ozonKeys: vi.fn(async () => null),
    wildberriesToken: vi.fn(async () => null),
    bitrix24Webhook: vi.fn(async () => null),
    moyskladToken: vi.fn(async () => null),
  };
}

describe('MarketplaceMcpService: ключи из БД → env', () => {
  beforeEach(() => {
    delete process.env.OZON_CLIENT_ID;
    delete process.env.OZON_API_KEY;
    delete process.env.WB_API_TOKEN;
    delete process.env.OZON_MCP_URL;
    delete process.env.WB_MCP_URL;
    delete process.env.BITRIX24_WEBHOOK_URL;
    delete process.env.MOYSKLAD_TOKEN;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('берёт ключи Ozon подключения пользователя', async () => {
    const keys = createKeysMock();

    keys.ozonKeys.mockResolvedValueOnce({
      clientId: 'user-client',
      apiKey: 'user-secret',
      source: 'user',
    });

    const service = new MarketplaceMcpService(
      keys as unknown as ProviderKeysService,
    );

    await expect(service.credentialsFor('ozon', 'user-1')).resolves.toEqual({
      source: 'user',
      clientId: 'user-client',
      apiKey: 'user-secret',
    });
    expect(keys.ozonKeys).toHaveBeenCalledWith('user-1');
  });

  it('падает обратно на env, если подключения нет', async () => {
    process.env.OZON_CLIENT_ID = 'env-client';
    process.env.OZON_API_KEY = 'env-secret';

    const service = new MarketplaceMcpService(
      createKeysMock() as unknown as ProviderKeysService,
    );

    await expect(service.credentialsFor('ozon', 'user-1')).resolves.toEqual({
      source: 'env',
      clientId: 'env-client',
      apiKey: 'env-secret',
    });
  });

  it('Битрикс24/МойСклад: per-user креды из ProviderKeysService', async () => {
    const keys = createKeysMock();

    keys.bitrix24Webhook.mockResolvedValueOnce({
      webhookUrl: 'https://portal.bitrix24.ru/rest/1/token/',
      source: 'user',
    });
    keys.moyskladToken.mockResolvedValueOnce({
      token: 'moysklad-user-token',
      source: 'user',
    });

    const service = new MarketplaceMcpService(
      keys as unknown as ProviderKeysService,
    );

    await expect(service.credentialsFor('bitrix24', 'user-1')).resolves.toEqual({
      source: 'user',
      webhookUrl: 'https://portal.bitrix24.ru/rest/1/token/',
    });
    await expect(service.credentialsFor('moysklad', 'user-1')).resolves.toEqual({
      source: 'user',
      token: 'moysklad-user-token',
    });
  });

  it('WB: токен пользователя приоритетнее env', async () => {
    const keys = createKeysMock();

    keys.wildberriesToken.mockResolvedValueOnce({
      token: 'user-wb',
      source: 'user',
    });

    const service = new MarketplaceMcpService(
      keys as unknown as ProviderKeysService,
    );

    await expect(service.credentialsFor('wb', 'user-1')).resolves.toEqual({
      source: 'user',
      token: 'user-wb',
    });
  });

  it('нет ключей ни в БД, ни в env — null и 503 marketplace_unavailable', async () => {
    const service = new MarketplaceMcpService(
      createKeysMock() as unknown as ProviderKeysService,
    );

    await expect(service.credentialsFor('ozon', 'user-1')).resolves.toBeNull();

    const error: unknown = await service
      .call('ozon', 'ozon_cards_list', {})
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ApiException);
    expect((error as ApiException).getResponse()).toMatchObject({
      statusCode: 503,
      code: ERROR_KEYS.marketplaceUnavailable,
    });
    expect((error as Error).message).toContain('Интеграции');
  });

  it('per-user креды Ozon не требуют env-ключей и уходят заголовками', async () => {
    const keys = createKeysMock();
    const fetchMock = vi.fn(async () => {
      throw new Error('stop after headers');
    });
    vi.stubGlobal('fetch', fetchMock);

    keys.ozonKeys.mockResolvedValueOnce({
      clientId: 'user-client',
      apiKey: 'user-secret',
      source: 'user',
    });

    const service = new MarketplaceMcpService(
      keys as unknown as ProviderKeysService,
    );

    await service
      .call('ozon', 'ozon_cards_list', {}, {
        userId: 'user-1',
        endpoint: 'http://ozon-mcp.test',
      })
      .catch(() => undefined);

    expect(fetchMock).toHaveBeenCalled();
    expect(fetchMock.mock.calls[0]?.[1]?.headers).toMatchObject({
      'X-Ozon-Client-Id': 'user-client',
      'X-Ozon-Api-Key': 'user-secret',
    });
  });

  it('с env-ключами гейт пройден: без endpoint — mcp_unavailable', async () => {
    process.env.WB_API_TOKEN = 'env-wb';

    const service = new MarketplaceMcpService(
      createKeysMock() as unknown as ProviderKeysService,
    );

    const error: unknown = await service
      .call('wb', 'wb_cards_list', {}, { userId: 'user-1' })
      .catch((caught: unknown) => caught);

    expect((error as ApiException).getResponse()).toMatchObject({
      code: ERROR_KEYS.mcpUnavailable,
    });
  });
});

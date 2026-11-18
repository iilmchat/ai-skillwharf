import nock from 'nock';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ApiException } from '../../common/api-error.js';
import { ERROR_KEYS } from '../../i18n/error-keys.js';
import { TokenCipherService } from '../google/token-cipher.service.js';
import { ProviderKeysService } from './provider-keys.service.js';

interface Row {
  userId: string;
  provider: string;
  secret: string;
  metadata?: unknown;
}

type RowKey = string;

/** Минимальная in-memory реализация нужных методов Prisma. */
function createPrismaMock(): {
  prisma: unknown;
  rows: Map<RowKey, Row>;
} {
  const rows = new Map<RowKey, Row>();
  const keyOf = (userId: string, provider: string): string =>
    `${userId}::${provider}`;

  const prisma = {
    providerCredential: {
      upsert: async (args: {
        where: { userId_provider: { userId: string; provider: string } };
        create: Row;
        update: Partial<Row>;
      }): Promise<Row> => {
        const { userId, provider } = args.where.userId_provider;
        const key = keyOf(userId, provider);
        const existing = rows.get(key);
        const next: Row =
          existing === undefined
            ? { ...args.create }
            : { ...existing, ...args.update };

        rows.set(key, next);

        return next;
      },
      findUnique: async (args: {
        where: { userId_provider: { userId: string; provider: string } };
      }): Promise<Row | null> => {
        const { userId, provider } = args.where.userId_provider;

        return rows.get(keyOf(userId, provider)) ?? null;
      },
      findMany: async (args: {
        where: { userId: string };
      }): Promise<Row[]> =>
        [...rows.values()].filter((row) => row.userId === args.where.userId),
      deleteMany: async (args: {
        where: { userId: string; provider: string };
      }): Promise<{ count: number }> => {
        const existed = rows.delete(
          keyOf(args.where.userId, args.where.provider),
        );

        return { count: existed ? 1 : 0 };
      },
    },
  };

  return { prisma, rows };
}

interface Clock {
  value: Date;
}

function createHarness(
  options: { withCipher?: boolean; clock?: Clock } = {},
): {
  service: ProviderKeysService;
  rows: Map<RowKey, Row>;
  clock: Clock;
} {
  const { prisma, rows } = createPrismaMock();
  const cipher =
    options.withCipher === false
      ? new TokenCipherService(undefined)
      : new TokenCipherService(Buffer.alloc(32, 7));
  const clock = options.clock ?? {
    value: new Date('2026-11-13T12:00:00.000Z'),
  };
  const service = new ProviderKeysService(prisma as never, cipher, () => clock.value);

  return { service, rows, clock };
}

const OZON_KEYS = { clientId: 'ozon-client-123', apiKey: 'ozon-api-key-secret' };

describe('ProviderKeysService: хранение и шифрование', () => {
  beforeEach(() => {
    delete process.env.OZON_CLIENT_ID;
    delete process.env.OZON_API_KEY;
    delete process.env.WB_API_TOKEN;
    delete process.env.MIDJOURNEY_API_KEY;
    delete process.env.BITRIX24_WEBHOOK_URL;
    delete process.env.MOYSKLAD_TOKEN;
    // Live-проверку Битрикс24/МойСклада проверяет отдельный spec с nock.
    process.env.SKIP_INTEGRATION_LIVE_CHECK = 'true';
  });

  it('Ozon: секреты в БД зашифрованы envelope v1 и не содержат открытых значений', async () => {
    const { service, rows } = createHarness();

    const state = await service.connectOzon('user-1', OZON_KEYS);

    expect(state).toMatchObject({
      status: 'active',
      clientId: 'ozon-client-123',
      source: 'user',
    });

    const stored = [...rows.values()][0];

    expect(stored?.secret.startsWith('v1:')).toBe(true);
    expect(stored?.secret).not.toContain('ozon-client-123');
    expect(stored?.secret).not.toContain('ozon-api-key-secret');
    // Формат envelope: v1:<iv>:<tag>:<ciphertext>.
    expect(stored?.secret.split(':')).toHaveLength(4);
  });

  it('GET-состояние расшифровывает Client ID и показывает active', async () => {
    const { service } = createHarness();

    await service.connectOzon('user-1', OZON_KEYS);

    await expect(service.describe('user-1')).resolves.toMatchObject({
      ozon: { status: 'active', clientId: 'ozon-client-123', source: 'user' },
      wildberries: { status: 'disconnected' },
      midjourney: { status: 'disconnected' },
    });
  });

  it('Wildberries: срок действия токена — 180 дней с подключения', async () => {
    const { service } = createHarness();

    const state = await service.connectWildberries('user-1', {
      apiToken: 'wb-token',
    });

    expect(state.status).toBe('active');
    expect(state.tokenExpiresAt).toBe('2027-05-12T12:00:00.000Z');
    await expect(service.describe('user-1')).resolves.toMatchObject({
      wildberries: {
        status: 'active',
        tokenExpiresAt: '2027-05-12T12:00:00.000Z',
      },
    });
  });

  it('Wildberries: просроченный токен даёт error с причиной', async () => {
    const clock: Clock = { value: new Date('2026-11-13T12:00:00.000Z') };
    const { service } = createHarness({ clock });

    await service.connectWildberries('user-1', { apiToken: 'wb-token' });

    // Токен выдан на 180 дней: через 200 дней он просрочен.
    clock.value = new Date('2027-06-01T00:00:00.000Z');

    const state = await service.describe('user-1');

    expect(state.wildberries.status).toBe('error');
    expect(state.wildberries.error).toContain('истёк');
    expect(state.wildberries.tokenExpiresAt).toBe('2027-05-12T12:00:00.000Z');
  });

  it('Midjourney: ключ TTAPI сохраняется и не попадает в БД открытым', async () => {
    const { service, rows } = createHarness();

    await service.connectMidjourney('user-1', { apiKey: 'tt-api-key-secret' });

    expect(rows.get('user-1::midjourney')?.secret).not.toContain(
      'tt-api-key-secret',
    );
    await expect(service.describe('user-1')).resolves.toMatchObject({
      midjourney: { status: 'active', source: 'user' },
    });
  });

  it('Битрикс24: вебхук шифруется целиком и не попадает в БД открытым', async () => {
    const { service, rows } = createHarness();
    const webhookUrl = 'https://portal.bitrix24.ru/rest/1/secret-webhook-code/';

    const state = await service.connectBitrix24('user-1', { webhookUrl });

    expect(state).toEqual({ status: 'active', source: 'user' });

    const stored = rows.get('user-1::bitrix24');

    expect(stored?.secret.startsWith('v1:')).toBe(true);
    expect(stored?.secret).not.toContain('secret-webhook-code');
    // Сам вебхук — секрет: наружу отдаётся только статус.
    await expect(service.describe('user-1')).resolves.toEqual({
      ozon: { status: 'disconnected' },
      wildberries: { status: 'disconnected' },
      midjourney: { status: 'disconnected' },
      bitrix24: { status: 'active', source: 'user' },
      moysklad: { status: 'disconnected' },
    });
  });

  it('МойСклад: токен шифруется, статус active без раскрытия значения', async () => {
    const { service, rows } = createHarness();

    await service.connectMoysklad('user-1', {
      apiToken: 'moysklad-api-token-secret',
    });

    const stored = rows.get('user-1::moysklad');

    expect(stored?.secret.startsWith('v1:')).toBe(true);
    expect(stored?.secret).not.toContain('moysklad-api-token-secret');
    await expect(service.describe('user-1')).resolves.toMatchObject({
      moysklad: { status: 'active', source: 'user' },
    });
  });

  it('Битрикс24: небезопасный или чужой вебхук отклоняется до сохранения', async () => {
    const { service, rows } = createHarness();

    for (const webhookUrl of [
      'http://portal.bitrix24.ru/rest/1/token/',
      'https://example.com/rest/1/token/',
      'https://portal.bitrix24.ru/crm/deal/',
    ]) {
      await expect(
        service.connectBitrix24('user-1', { webhookUrl }),
      ).rejects.toThrow();
    }

    expect(rows.size).toBe(0);
  });

  it('МойСклад: слишком короткий токен отклоняется', async () => {
    const { service, rows } = createHarness();

    await expect(
      service.connectMoysklad('user-1', { apiToken: 'short' }),
    ).rejects.toThrow();
    expect(rows.size).toBe(0);
  });

  it('Битрикс24/МойСклад: статус из env, если подключения пользователя нет', async () => {
    const { service } = createHarness();

    process.env.BITRIX24_WEBHOOK_URL =
      'https://portal.bitrix24.ru/rest/1/token/';
    process.env.MOYSKLAD_TOKEN = 'moysklad-env-token';

    await expect(service.describe('user-1')).resolves.toMatchObject({
      bitrix24: { status: 'active', source: 'env' },
      moysklad: { status: 'active', source: 'env' },
    });
  });

  it('disconnect Битрикс24/МойСклада удаляет только свою запись', async () => {
    const { service } = createHarness();

    await service.connectBitrix24('user-1', {
      webhookUrl: 'https://portal.bitrix24.ru/rest/1/token/',
    });
    await service.connectMoysklad('user-1', {
      apiToken: 'moysklad-api-token-secret',
    });

    await expect(service.disconnect('user-1', 'bitrix24')).resolves.toBe(true);
    await expect(service.disconnect('user-1', 'moysklad')).resolves.toBe(true);
    await expect(service.disconnect('user-1', 'bitrix24')).resolves.toBe(false);
    await expect(service.describe('user-1')).resolves.toMatchObject({
      bitrix24: { status: 'disconnected' },
      moysklad: { status: 'disconnected' },
    });
  });

  it('без TOKEN_ENCRYPTION_KEY подключение отклоняется 503', async () => {
    const { service } = createHarness({ withCipher: false });

    const error: unknown = await service
      .connectOzon('user-1', OZON_KEYS)
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ApiException);
    expect((error as ApiException).getResponse()).toMatchObject({
      statusCode: 503,
      code: ERROR_KEYS.providerNotConfigured,
    });
  });

  it('disconnect удаляет только своего провайдера', async () => {
    const { service } = createHarness();

    await service.connectOzon('user-1', OZON_KEYS);
    await service.connectMidjourney('user-1', { apiKey: 'tt-api-key-secret' });

    await expect(service.disconnect('user-1', 'ozon')).resolves.toBe(true);
    await expect(service.disconnect('user-1', 'ozon')).resolves.toBe(false);
    await expect(service.describe('user-1')).resolves.toMatchObject({
      ozon: { status: 'disconnected' },
      midjourney: { status: 'active' },
    });
  });

  it('битый envelope даёт status error, а не падение GET', async () => {
    const { service, rows } = createHarness();

    await service.connectOzon('user-1', OZON_KEYS);
    const stored = rows.get('user-1::ozon');

    if (stored !== undefined) {
      stored.secret = 'v1:AAAA:BBBB:CCCC';
    }

    await expect(service.describe('user-1')).resolves.toMatchObject({
      ozon: { status: 'error' },
    });
  });
});

describe('ProviderKeysService: ключи для инструментов (БД → env)', () => {
  beforeEach(() => {
    delete process.env.OZON_CLIENT_ID;
    delete process.env.OZON_API_KEY;
    delete process.env.WB_API_TOKEN;
    delete process.env.MIDJOURNEY_API_KEY;
  });

  it('ozonKeys отдаёт подключение пользователя', async () => {
    const { service } = createHarness();

    await service.connectOzon('user-1', OZON_KEYS);

    await expect(service.ozonKeys('user-1')).resolves.toEqual({
      clientId: 'ozon-client-123',
      apiKey: 'ozon-api-key-secret',
      source: 'user',
    });
  });

  it('ozonKeys падает обратно на env, если подключения нет', async () => {
    const { service } = createHarness();

    process.env.OZON_CLIENT_ID = 'env-client';
    process.env.OZON_API_KEY = 'env-key';

    await expect(service.ozonKeys('user-1')).resolves.toEqual({
      clientId: 'env-client',
      apiKey: 'env-key',
      source: 'env',
    });
  });

  it('ozonKeys отдаёт null, если ключей нет ни в БД, ни в env', async () => {
    const { service } = createHarness();

    await expect(service.ozonKeys('user-1')).resolves.toBeNull();
    await expect(service.ozonKeys()).resolves.toBeNull();
  });

  it('ozonKeys другого пользователя не подмешиваются', async () => {
    const { service } = createHarness();

    await service.connectOzon('user-1', OZON_KEYS);

    await expect(service.ozonKeys('user-2')).resolves.toBeNull();
  });

  it('wildberriesToken и midjourneyKey: БД приоритетнее env', async () => {
    const { service } = createHarness();

    process.env.WB_API_TOKEN = 'env-wb';
    process.env.MIDJOURNEY_API_KEY = 'env-ttapi';

    await service.connectWildberries('user-1', { apiToken: 'user-wb' });
    await service.connectMidjourney('user-1', { apiKey: 'user-ttapi' });

    await expect(service.wildberriesToken('user-1')).resolves.toEqual({
      token: 'user-wb',
      source: 'user',
    });
    await expect(service.midjourneyKey('user-1')).resolves.toEqual({
      apiKey: 'user-ttapi',
      source: 'user',
    });
    await expect(service.wildberriesToken('user-2')).resolves.toEqual({
      token: 'env-wb',
      source: 'env',
    });
    await expect(service.midjourneyKey('user-2')).resolves.toEqual({
      apiKey: 'env-ttapi',
      source: 'env',
    });
  });

  it('битые ключи в БД не блокируют fallback на env', async () => {
    const { service, rows } = createHarness();

    await service.connectMidjourney('user-1', { apiKey: 'user-ttapi' });
    const stored = rows.get('user-1::midjourney');

    if (stored !== undefined) {
      stored.secret = 'v1:AAAA:BBBB:CCCC';
    }

    process.env.MIDJOURNEY_API_KEY = 'env-ttapi';

    await expect(service.midjourneyKey('user-1')).resolves.toEqual({
      apiKey: 'env-ttapi',
      source: 'env',
    });
  });

  it('Валидация тел запросов: лишние поля и пустые значения отклоняются', async () => {
    const { service } = createHarness();

    await expect(
      service.connectOzon('user-1', { clientId: '', apiKey: 'x' }),
    ).rejects.toThrow();
    await expect(
      service.connectOzon('user-1', {
        clientId: '123',
        apiKey: 'secret',
        extra: 'x',
      } as never),
    ).rejects.toThrow();
  });
});

describe('ProviderKeysService: live-проверка при подключении (KI-075)', () => {
  const BITRIX_API = 'https://portal.bitrix24.ru';
  const BITRIX_WEBHOOK = `${BITRIX_API}/rest/1/token/`;
  const MOYSKLAD_API = 'https://api.moysklad.ru';
  const MOYSKLAD_REMAP = '/api/remap/1.2';

  beforeEach(() => {
    delete process.env.SKIP_INTEGRATION_LIVE_CHECK;
    delete process.env.API_OUTBOUND_ALLOWLIST;
    delete process.env.MOYSKLAD_BASE_URL;
    // Детерминированный egress-allowlist независимо от .env разработчика.
    process.env.OUTBOUND_ALLOWLIST = '*.bitrix24.ru,*.moysklad.ru';
    nock.disableNetConnect();
  });

  afterEach(() => {
    nock.cleanAll();
    nock.enableNetConnect();
    delete process.env.OUTBOUND_ALLOWLIST;
    delete process.env.SKIP_INTEGRATION_LIVE_CHECK;
  });

  it('Битрикс24: profile.json подтверждает вебхук до сохранения', async () => {
    const { service, rows } = createHarness();
    const api = nock(BITRIX_API)
      .get('/rest/1/token/profile.json')
      .reply(200, { result: { ID: '1', NAME: 'Иван' } });

    await expect(
      service.connectBitrix24('user-1', { webhookUrl: BITRIX_WEBHOOK }),
    ).resolves.toEqual({ status: 'active', source: 'user' });
    expect(api.isDone()).toBe(true);
    expect(rows.has('user-1::bitrix24')).toBe(true);
  });

  it('Битрикс24: 401 даёт 400 provider_auth_required и не пишет в БД', async () => {
    const { service, rows } = createHarness();
    nock(BITRIX_API)
      .get('/rest/1/token/profile.json')
      .reply(401, { error: 'INVALID_CREDENTIALS' });

    const error: unknown = await service
      .connectBitrix24('user-1', { webhookUrl: BITRIX_WEBHOOK })
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ApiException);
    expect((error as ApiException).getResponse()).toMatchObject({
      statusCode: 400,
      code: ERROR_KEYS.providerAuthRequired,
    });
    expect(rows.size).toBe(0);
  });

  it('МойСклад: organization?limit=1 подтверждает токен до сохранения', async () => {
    const { service, rows } = createHarness();
    const api = nock(MOYSKLAD_API)
      .get(`${MOYSKLAD_REMAP}/entity/organization`)
      .query({ limit: '1' })
      .matchHeader('authorization', 'Bearer moysklad-api-token-secret')
      .reply(200, { rows: [{ id: 'organization-1' }] });

    await expect(
      service.connectMoysklad('user-1', {
        apiToken: 'moysklad-api-token-secret',
      }),
    ).resolves.toEqual({ status: 'active', source: 'user' });
    expect(api.isDone()).toBe(true);
    expect(rows.has('user-1::moysklad')).toBe(true);
  });

  it('МойСклад: 403 даёт 400 provider_auth_required и не пишет в БД', async () => {
    const { service, rows } = createHarness();
    nock(MOYSKLAD_API)
      .get(`${MOYSKLAD_REMAP}/entity/organization`)
      .query({ limit: '1' })
      .reply(403, { errors: [{ error: 'Access denied' }] });

    const error: unknown = await service
      .connectMoysklad('user-1', {
        apiToken: 'moysklad-api-token-secret',
      })
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ApiException);
    expect((error as ApiException).getResponse()).toMatchObject({
      statusCode: 400,
      code: ERROR_KEYS.providerAuthRequired,
    });
    expect(rows.size).toBe(0);
  });

  it('SKIP_INTEGRATION_LIVE_CHECK=true пропускает live-проверку', async () => {
    const { service, rows } = createHarness();
    process.env.SKIP_INTEGRATION_LIVE_CHECK = 'true';

    await expect(
      service.connectBitrix24('user-1', { webhookUrl: BITRIX_WEBHOOK }),
    ).resolves.toEqual({ status: 'active', source: 'user' });
    expect(rows.has('user-1::bitrix24')).toBe(true);
  });

  it('таймаут/сеть live-проверки даёт 502 provider_unavailable', async () => {
    const { service, rows } = createHarness();
    nock(BITRIX_API)
      .get('/rest/1/token/profile.json')
      .replyWithError(new Error('socket hang up'));

    const error: unknown = await service
      .connectBitrix24('user-1', { webhookUrl: BITRIX_WEBHOOK })
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ApiException);
    expect((error as ApiException).getResponse()).toMatchObject({
      statusCode: 502,
      code: ERROR_KEYS.providerUnavailable,
    });
    expect(rows.size).toBe(0);
  });

  it('5xx live-проверки Битрикс24 даёт 502 provider_unavailable', async () => {
    const { service, rows } = createHarness();
    nock(BITRIX_API)
      .get('/rest/1/token/profile.json')
      .reply(500, { error: 'internal' });

    const error: unknown = await service
      .connectBitrix24('user-1', { webhookUrl: BITRIX_WEBHOOK })
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ApiException);
    expect((error as ApiException).getResponse()).toMatchObject({
      statusCode: 502,
      code: ERROR_KEYS.providerUnavailable,
    });
    expect(rows.size).toBe(0);
  });
});

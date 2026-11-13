import { beforeEach, describe, expect, it } from 'vitest';
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

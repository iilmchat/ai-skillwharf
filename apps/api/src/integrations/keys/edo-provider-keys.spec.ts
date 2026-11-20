import { describe, expect, it, vi } from 'vitest';
import type { PrismaService } from '../../prisma/prisma.service.js';
import type { TokenCipherService } from '../google/token-cipher.service.js';
import { ProviderKeysService } from './provider-keys.service.js';

const USER_ID = 'user-1';
const DIADOC = { apiKey: 'api-key-secret', boxId: 'box-1', token: 'diadoc-token' };
const SBIS = { token: 'sbis-token', boxId: 'box-2' };

function createHarness() {
  const store = new Map<string, Record<string, unknown>>();
  const prisma = {
    providerCredential: {
      upsert: vi.fn(async ({ where, create }: {
        where: { userId_provider: { userId: string; provider: string } };
        create: Record<string, unknown>;
      }) => {
        const key = `${where.userId_provider.userId}:${where.userId_provider.provider}`;

        store.set(key, { ...create, userId: where.userId_provider.userId, provider: where.userId_provider.provider });
      }),
      findUnique: vi.fn(async ({ where }: {
        where: { userId_provider: { userId: string; provider: string } };
      }) =>
        store.get(`${where.userId_provider.userId}:${where.userId_provider.provider}`) ?? null,
      ),
      findMany: vi.fn(async ({ where }: { where: { userId: string } }) =>
        [...store.values()].filter((row) => row.userId === where.userId),
      ),
      deleteMany: vi.fn(async () => ({ count: 0 })),
    },
  };
  const cipher = {
    encrypt: vi.fn((value: string) => `v2:enc:${value}`),
    decrypt: vi.fn((value: string) => value.replace('v2:enc:', '')),
  };
  const service = new ProviderKeysService(
    prisma as unknown as PrismaService,
    cipher as unknown as TokenCipherService,
  );

  return { service, prisma, cipher, store };
}

describe('ProviderKeysService — ЭДО (EDO-41.2)', () => {
  it('шифрует diadoc целиком и маскирует секреты в GET', async () => {
    const { service, cipher, store } = createHarness();

    const state = await service.connectDiadoc(USER_ID, DIADOC);

    expect(state).toEqual({
      status: 'active',
      boxId: 'box-1',
      source: 'user',
    });
    expect(JSON.stringify(state)).not.toContain(DIADOC.token);
    expect(cipher.encrypt).toHaveBeenCalledWith(JSON.stringify(DIADOC));
    expect(store.get(`${USER_ID}:diadoc`)?.secret).toBe(
      `v2:enc:${JSON.stringify(DIADOC)}`,
    );

    const described = await service.describe(USER_ID);

    expect(described.diadoc).toMatchObject({ status: 'active', boxId: 'box-1' });
    expect(JSON.stringify(described)).not.toContain(DIADOC.apiKey);
    expect(JSON.stringify(described)).not.toContain(DIADOC.token);
  });

  it('возвращает расшифрованные креды только внутренним вызывающим', async () => {
    const { service } = createHarness();

    await service.connectDiadoc(USER_ID, DIADOC);
    await service.connectSbis(USER_ID, SBIS);

    await expect(service.edoKeys(USER_ID, 'diadoc')).resolves.toEqual({
      provider: 'diadoc',
      apiKey: DIADOC.apiKey,
      token: DIADOC.token,
      boxId: DIADOC.boxId,
      source: 'user',
    });
    await expect(service.edoKeys(USER_ID, 'sbis')).resolves.toEqual({
      provider: 'sbis',
      token: SBIS.token,
      boxId: SBIS.boxId,
      source: 'user',
    });
  });

  it('валидирует тело подключения через Zod', async () => {
    const { service } = createHarness();

    await expect(
      service.connectDiadoc(USER_ID, { ...DIADOC, apiKey: '' }),
    ).rejects.toThrow();
    await expect(
      service.connectSbis(USER_ID, { token: 'x' }),
    ).rejects.toThrow();
  });
});

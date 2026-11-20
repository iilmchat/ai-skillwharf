import { describe, expect, it, vi } from 'vitest';
import type { PrismaService } from '../../prisma/prisma.service.js';
import type { TokenCipherService } from '../google/token-cipher.service.js';
import {
  maskInn,
  ProviderKeysService,
} from './provider-keys.service.js';
import { innSchema } from './provider-keys.schemas.js';

const USER_ID = 'user-1';
const KEYS = { token: 'marking-token', inn: '7700000000' };

function createHarness() {
  const store = new Map<string, Record<string, unknown>>();
  const prisma = {
    providerCredential: {
      upsert: vi.fn(async ({ where, create }: {
        where: { userId_provider: { userId: string; provider: string } };
        create: Record<string, unknown>;
      }) => {
        store.set(
          `${where.userId_provider.userId}:${where.userId_provider.provider}`,
          { ...create, userId: where.userId_provider.userId, provider: where.userId_provider.provider },
        );
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

  return { service, cipher, store };
}

describe('ИНН (MARK-42.2)', () => {
  it('принимает 10 и 12 цифр и отклоняет прочее', () => {
    expect(innSchema.safeParse('7700000000').success).toBe(true);
    expect(innSchema.safeParse('770000000012').success).toBe(true);
    for (const bad of ['123', '7700000000a', '7700000000000', '']) {
      expect(innSchema.safeParse(bad).success).toBe(false);
    }
  });

  it('маскирует ИНН', () => {
    expect(maskInn('7700000000')).toBe('77****00');
  });
});

describe('ProviderKeysService — Честный ЗНАК', () => {
  it('шифрует токен и маскирует ИНН в GET', async () => {
    const { service, cipher, store } = createHarness();

    const state = await service.connectChestnyZnak(USER_ID, KEYS);

    expect(state).toEqual({
      status: 'active',
      innMasked: '77****00',
      source: 'user',
    });
    expect(JSON.stringify(state)).not.toContain(KEYS.token);
    expect(JSON.stringify(state)).not.toContain(KEYS.inn);
    expect(cipher.encrypt).toHaveBeenCalledWith(JSON.stringify(KEYS));
    expect(store.get(`${USER_ID}:chestny_znak`)?.secret).toBe(
      `v2:enc:${JSON.stringify(KEYS)}`,
    );

    const described = await service.describe(USER_ID);

    expect(described.chestnyZnak).toMatchObject({
      status: 'active',
      innMasked: '77****00',
    });
    expect(JSON.stringify(described)).not.toContain(KEYS.token);
    expect(JSON.stringify(described)).not.toContain(KEYS.inn);
  });

  it('возвращает токен только внутренним вызывающим', async () => {
    const { service } = createHarness();

    await service.connectChestnyZnak(USER_ID, KEYS);

    await expect(service.markingKeys(USER_ID)).resolves.toEqual({
      token: KEYS.token,
      inn: KEYS.inn,
      source: 'user',
    });
  });

  it('отверждает невалидный ИНН через Zod', async () => {
    const { service } = createHarness();

    await expect(
      service.connectChestnyZnak(USER_ID, { ...KEYS, inn: '77abc' }),
    ).rejects.toThrow();
  });
});

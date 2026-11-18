import { randomBytes } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import type { PrismaService } from '../../prisma/prisma.service.js';
import { LocalAesGcmKms, TokenCipherService } from '../google/token-cipher.service.js';
import { CredentialRotationService } from './credential-rotation.service.js';

const NEW_KEY = randomBytes(32);
const OLD_KEY = randomBytes(32);

function legacyEnvelope(plaintext: string): string {
  const payload = new LocalAesGcmKms(OLD_KEY, 'local-v0').encrypt(
    Buffer.from(plaintext, 'utf8'),
  );

  return ['v1', ...[payload.iv, payload.tag, payload.ciphertext].map((part) =>
    part.toString('base64'),
  )].join(':');
}

function currentEnvelope(plaintext: string, cipher: TokenCipherService): string {
  return cipher.encrypt(plaintext);
}

interface FakeData {
  providers: Array<{ userId: string; provider: string; secret: string }>;
  google: Array<{ userId: string; accessToken: string; refreshToken: string | null }>;
  telegram: Array<{ userId: string; token: string }>;
}

function fakePrisma(data: FakeData): {
  prisma: PrismaService;
  updates: () => number;
} {
  let updates = 0;
  const tx = {
    providerCredential: {
      update: vi.fn(async () => {
        updates += 1;
      }),
    },
    googleCredential: {
      update: vi.fn(async () => {
        updates += 1;
      }),
    },
    telegramBot: {
      update: vi.fn(async () => {
        updates += 1;
      }),
    },
  };
  const prisma = {
    providerCredential: {
      findMany: async () => data.providers,
      ...tx.providerCredential,
    },
    googleCredential: {
      findMany: async () => data.google,
      ...tx.googleCredential,
    },
    telegramBot: {
      findMany: async () => data.telegram,
      ...tx.telegramBot,
    },
    $transaction: async (
      callback: (transaction: typeof tx) => Promise<unknown>,
    ) => callback(tx),
  };

  return { prisma: prisma as unknown as PrismaService, updates: () => updates };
}

describe('CredentialRotationService', () => {
  it('перешифровывает v1 и v2 старого keyId в активный ключ', async () => {
    const current = new TokenCipherService(NEW_KEY, {
      keyId: 'local-v2',
      previousKeys: new Map([['local-v0', OLD_KEY]]),
    });
    const oldV2 = new TokenCipherService(OLD_KEY, { keyId: 'local-v0' });
    const data: FakeData = {
      providers: [
        { userId: 'u1', provider: 'ozon', secret: legacyEnvelope('ozon-key') },
      ],
      google: [
        {
          userId: 'u2',
          accessToken: oldV2.encrypt('access'),
          refreshToken: oldV2.encrypt('refresh'),
        },
      ],
      telegram: [
        { userId: 'u3', token: currentEnvelope('bot-token', current) },
      ],
    };
    const fake = fakePrisma(data);
    const service = new CredentialRotationService(fake.prisma, current);

    const report = await service.rotateAllCredentials();

    expect(report).toEqual({
      providerCredentials: 1,
      googleCredentials: 1,
      telegramBots: 0,
      total: 2,
    });
    expect(fake.updates()).toBe(2);
    expect(current.decrypt(legacyEnvelope('ozon-key'))).toBe('ozon-key');
    expect(current.needsRotation(oldV2.encrypt('access'))).toBe(true);
    expect(current.encrypt('access').startsWith('v2:local-v2:')).toBe(true);
  });

  it('fail closed: ошибка расшифровки откатывает всю ротацию', async () => {
    const current = new TokenCipherService(NEW_KEY, { keyId: 'local-v2' });
    const data: FakeData = {
      providers: [
        {
          userId: 'u1',
          provider: 'ozon',
          secret: ['v2', 'unknown-key', 'AAAA', 'AAAA', 'AAAA'].join(':'),
        },
      ],
      google: [],
      telegram: [],
    };
    const fake = fakePrisma(data);
    const service = new CredentialRotationService(fake.prisma, current);

    await expect(service.rotateAllCredentials()).rejects.toThrow(/keyId/);
    expect(fake.updates()).toBe(0);
  });

  it('без активного ключа ротация недоступна', async () => {
    const fake = fakePrisma({ providers: [], google: [], telegram: [] });
    const service = new CredentialRotationService(
      fake.prisma,
      new TokenCipherService(undefined, { env: {} }),
    );

    await expect(service.rotateAllCredentials()).rejects.toThrow(
      /TOKEN_ENCRYPTION_KEY/,
    );
  });
});

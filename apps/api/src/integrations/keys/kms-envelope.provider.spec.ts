import { randomBytes } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import type { PrismaService } from '../../prisma/prisma.service.js';
import {
  LocalAesGcmKms,
  LocalAesKmsProvider,
  TokenCipherService,
} from '../google/token-cipher.service.js';
import { CredentialRotationService } from './credential-rotation.service.js';
import {
  readKmsConfig,
  VaultTransitKmsProvider,
  YandexCloudKmsProvider,
} from './kms-envelope.provider.js';

const LOCAL_KEY = randomBytes(32);

function legacy(plaintext: string): string {
  const payload = new LocalAesGcmKms(LOCAL_KEY, 'local-v1').encrypt(
    Buffer.from(plaintext, 'utf8'),
  );

  return [
    'v2',
    'local-v1',
    payload.iv.toString('base64'),
    payload.tag.toString('base64'),
    payload.ciphertext.toString('base64'),
  ].join(':');
}

function legacyProvider(): LocalAesKmsProvider {
  const kms = new LocalAesGcmKms(LOCAL_KEY, 'local-v1');

  return new LocalAesKmsProvider(kms, new Map([['local-v1', kms]]));
}

describe('VaultTransitKmsProvider (KMS-34.1)', () => {
  const config = readKmsConfig({
    KMS_PROVIDER: 'vault',
    VAULT_ADDR: 'https://vault.example.com',
    VAULT_TOKEN: 'vault-token',
    VAULT_TRANSIT_KEY: 'skillwharf',
  });

  it('шифрует и кладёт конверт kms:vault:<key>:<ciphertext>', async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ data: { ciphertext: 'vault:v1:abc' } }),
    })) as unknown as typeof fetch;
    const provider = new VaultTransitKmsProvider({ config, legacy: legacyProvider(), fetch: fetchMock });

    const envelope = await provider.encrypt('secret-value');

    expect(envelope).toBe('kms:vault:skillwharf:vault:v1:abc');
    const [url, init] = (fetchMock as unknown as { mock: { calls: unknown[][] } }).mock
      .calls[0] as [string, RequestInit];

    expect(url).toBe('https://vault.example.com/v1/transit/encrypt/skillwharf');
    expect((init.headers as Record<string, string>)['X-Vault-Token']).toBe('vault-token');
  });

  it('расшифровывает kms:vault и старый v2 через локальный delegate', async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        data: { plaintext: Buffer.from('from-vault').toString('base64') },
      }),
    })) as unknown as typeof fetch;
    const provider = new VaultTransitKmsProvider({ config, legacy: legacyProvider(), fetch: fetchMock });

    await expect(
      provider.decrypt('kms:vault:skillwharf:vault:v1:abc'),
    ).resolves.toBe('from-vault');
    await expect(provider.decrypt(legacy('old-secret'))).resolves.toBe('old-secret');
  });

  it('отвергает невалидный ответ Vault через Zod', async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ data: {} }),
    })) as unknown as typeof fetch;
    const provider = new VaultTransitKmsProvider({ config, legacy: legacyProvider(), fetch: fetchMock });

    await expect(provider.encrypt('x')).rejects.toThrow(/некорректный ответ/);
  });
});

describe('YandexCloudKmsProvider (KMS-34.1)', () => {
  const config = readKmsConfig({
    KMS_PROVIDER: 'yandex-kms',
    YANDEX_KMS_KEY_ID: 'abjxxxxxxxxxxxx',
    YANDEX_KMS_IAM_TOKEN: 'iam-token',
  });

  it('шифрует через https://yandex.net<keyId>:encrypt и bearer-токен', async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ ciphertext: 'yamled-cipher' }),
    })) as unknown as typeof fetch;
    const provider = new YandexCloudKmsProvider({ config, legacy: legacyProvider(), fetch: fetchMock });

    const envelope = await provider.encrypt('secret');

    expect(envelope).toBe('kms:yandex:abjxxxxxxxxxxxx:yamled-cipher');
    const [url, init] = (fetchMock as unknown as { mock: { calls: unknown[][] } }).mock
      .calls[0] as [string, RequestInit];

    expect(url).toBe('https://yandex.netabjxxxxxxxxxxxx:encrypt');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer iam-token');
  });

  it('расшифровывает и поддерживает legacy v2', async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        plaintext: Buffer.from('decrypted').toString('base64'),
      }),
    })) as unknown as typeof fetch;
    const provider = new YandexCloudKmsProvider({ config, legacy: legacyProvider(), fetch: fetchMock });

    await expect(
      provider.decrypt('kms:yandex:abjxxxxxxxxxxxx:cipher'),
    ).resolves.toBe('decrypted');
    await expect(provider.decrypt(legacy('old'))).resolves.toBe('old');
  });
});

describe('миграция конверта v2 → kms:vault', () => {
  it('CredentialRotationService перешифровывает запись на активный Vault-ключ', async () => {
    const fetchMock = vi.fn(async (url: string) => ({
      ok: true,
      status: 200,
      json: async () =>
        url.includes('/encrypt/')
          ? { data: { ciphertext: 'vault:v1:new' } }
          : { data: { plaintext: '' } },
    })) as unknown as typeof fetch;
    const vaultConfig = readKmsConfig({
      KMS_PROVIDER: 'vault',
      VAULT_ADDR: 'https://vault.example.com',
      VAULT_TOKEN: 'token',
      VAULT_TRANSIT_KEY: 'skillwharf',
    });
    const cipher = new TokenCipherService(
      LOCAL_KEY,
      { keyId: 'local-v1', env: { KMS_PROVIDER: 'local' } },
    );
    // Переключаем активного провайдера на Vault, сохраняя локальный delegate.
    Object.assign(cipher, {
      kms: new VaultTransitKmsProvider({
        config: vaultConfig,
        legacy: legacyProvider(),
        fetch: fetchMock,
      }),
    });

    const stored = { secret: legacy('provider-secret') };
    const prisma = {
      providerCredential: {
        findMany: async () => [{ userId: 'u1', provider: 'ozon', secret: stored.secret }],
        update: vi.fn(async ({ data }: { data: { secret: string } }) => {
          stored.secret = data.secret;
        }),
      },
      googleCredential: { findMany: async () => [] },
      telegramBot: { findMany: async () => [] },
      $transaction: async (cb: (tx: unknown) => Promise<unknown>) => cb(prisma),
    };
    const service = new CredentialRotationService(
      prisma as unknown as PrismaService,
      cipher,
    );

    const report = await service.rotateAllCredentials();

    expect(report.providerCredentials).toBe(1);
    expect(stored.secret).toBe('kms:vault:skillwharf:vault:v1:new');
  });
});

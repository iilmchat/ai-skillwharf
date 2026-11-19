import { z } from 'zod';

/**
 * Провайдер envelope-шифрования секретов (KMS-34.1/34.2, KI-053).
 *
 * Контракт асинхронный: Vault Transit и Yandex Cloud KMS — сетевые API.
 * Локальный AES-256-GCM остаётся дефолтом и полной backward-совместимостью
 * с форматами `v1:`/`v2:`.
 */
export interface IKmsEnvelopeProvider {
  readonly providerName: 'local' | 'vault' | 'yandex-kms';
  encrypt(plaintext: string): Promise<string>;
  decrypt(envelope: string): Promise<string>;
  /** Нужна ли перешифровка записи на текущий активный ключ. */
  needsRotation(envelope: string): boolean;
}

const kmsConfigSchema = z
  .object({
    provider: z.enum(['local', 'vault', 'yandex-kms']),
    vaultAddr: z.string().default(''),
    vaultToken: z.string().default(''),
    vaultTransitKey: z.string().max(128).default(''),
    yandexKeyId: z.string().max(256).default(''),
    yandexIamToken: z.string().default(''),
  })
  .superRefine((config, context) => {
    if (config.provider === 'vault') {
      for (const field of ['vaultAddr', 'vaultToken', 'vaultTransitKey'] as const) {
        if (config[field].trim() === '') {
          context.addIssue({
            code: z.ZodIssueCode.custom,
            path: [field],
            message: `KMS_PROVIDER=vault требует ${field}`,
          });
        }
      }
    }

    if (config.provider === 'yandex-kms') {
      for (const field of ['yandexKeyId', 'yandexIamToken'] as const) {
        if (config[field].trim() === '') {
          context.addIssue({
            code: z.ZodIssueCode.custom,
            path: [field],
            message: `KMS_PROVIDER=yandex-kms требует ${field}`,
          });
        }
      }
    }
  });

export type KmsConfig = z.infer<typeof kmsConfigSchema>;

export function readKmsConfig(env: NodeJS.ProcessEnv = process.env): KmsConfig {
  return kmsConfigSchema.parse({
    provider: (env.KMS_PROVIDER ?? 'local').trim().toLowerCase(),
    vaultAddr: env.VAULT_ADDR?.trim() ?? '',
    vaultToken: env.VAULT_TOKEN?.trim() ?? '',
    vaultTransitKey: env.VAULT_TRANSIT_KEY?.trim() ?? '',
    yandexKeyId: env.YANDEX_KMS_KEY_ID?.trim() ?? '',
    yandexIamToken: env.YANDEX_KMS_IAM_TOKEN?.trim() ?? '',
  });
}

/** Ответ Vault Transit: зашифрованный/расшифрованный ciphertext. */
export const vaultEncryptResponseSchema = z.object({
  data: z.object({ ciphertext: z.string().min(1) }),
});
export const vaultDecryptResponseSchema = z.object({
  data: z.object({ plaintext: z.string().min(1) }),
});

/** Ответ Yandex Cloud KMS: ciphertext/plaintext в base64. */
export const yandexEncryptResponseSchema = z.object({
  ciphertext: z.string().min(1),
});
export const yandexDecryptResponseSchema = z.object({
  plaintext: z.string().min(1),
});

export const LEGACY_ENVELOPE_PREFIXES = ['v1:', 'v2:'] as const;

export function isLegacyEnvelope(envelope: string): boolean {
  return LEGACY_ENVELOPE_PREFIXES.some((prefix) => envelope.startsWith(prefix));
}

/** Делегат локального шифра: используется для чтения старых v1/v2. */
export interface LegacyCipher {
  decrypt(envelope: string): Promise<string>;
  needsRotation(envelope: string): boolean;
  readonly keyId: string;
}

async function postJson(
  url: string,
  body: Record<string, string>,
  headers: Record<string, string>,
  fetchFn: typeof fetch,
): Promise<unknown> {
  const response = await fetchFn(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(10_000),
  });

  if (!response.ok) {
    throw new Error(`KMS HTTP ${response.status}`);
  }

  const raw: unknown = await response.json().catch(() => null);

  return raw;
}

/** Фабрика провайдера по `KMS_PROVIDER`. */
export function createKmsEnvelopeProvider(
  config: KmsConfig,
  legacy: LegacyCipher & IKmsEnvelopeProvider,
  fetchFn?: typeof fetch,
): IKmsEnvelopeProvider {
  switch (config.provider) {
    case 'local':
      return legacy;
    case 'vault':
      return new VaultTransitKmsProvider({ config, legacy, ...(fetchFn ? { fetch: fetchFn } : {}) });
    case 'yandex-kms':
      return new YandexCloudKmsProvider({ config, legacy, ...(fetchFn ? { fetch: fetchFn } : {}) });
  }
}

export interface VaultProviderOptions {
  readonly config: KmsConfig;
  readonly legacy: LegacyCipher;
  readonly fetch?: typeof fetch;
}

export class VaultTransitKmsProvider implements IKmsEnvelopeProvider {
  readonly providerName = 'vault' as const;
  private readonly fetchFn: typeof fetch;

  constructor(private readonly options: VaultProviderOptions) {
    this.fetchFn = options.fetch ?? fetch;
  }

  async encrypt(plaintext: string): Promise<string> {
    const url = `${this.options.config.vaultAddr.replace(/\/+$/, '')}/v1/transit/encrypt/${encodeURIComponent(this.options.config.vaultTransitKey)}`;
    const raw = await postJson(
      url,
      { plaintext: Buffer.from(plaintext, 'utf8').toString('base64') },
      { 'X-Vault-Token': this.options.config.vaultToken },
      this.fetchFn,
    );
    const parsed = vaultEncryptResponseSchema.safeParse(raw);

    if (!parsed.success) {
      throw new Error('Vault Transit вернул некорректный ответ encrypt');
    }

    return `kms:vault:${this.options.config.vaultTransitKey}:${parsed.data.data.ciphertext}`;
  }

  async decrypt(envelope: string): Promise<string> {
    // ciphertext Vault содержит ':' (например `vault:v1:...`) — ограничиваем
    // число частей, чтобы он попал целиком в последний элемент.
    const parts = envelope.split(':', 4);

    if (parts[0] !== 'kms' || parts[1] !== 'vault' || parts.length !== 4) {
      if (isLegacyEnvelope(envelope)) {
        return await this.options.legacy.decrypt(envelope);
      }
      throw new Error('Некорректный Vault envelope');
    }

    const keyName = z.string().min(1).max(128).parse(parts[2]);
    const ciphertext = z.string().min(1).parse(parts[3]);
    const url = `${this.options.config.vaultAddr.replace(/\/+$/, '')}/v1/transit/decrypt/${encodeURIComponent(keyName)}`;
    const raw = await postJson(
      url,
      { ciphertext },
      { 'X-Vault-Token': this.options.config.vaultToken },
      this.fetchFn,
    );
    const parsed = vaultDecryptResponseSchema.safeParse(raw);

    if (!parsed.success) {
      throw new Error('Vault Transit вернул некорректный ответ decrypt');
    }

    return Buffer.from(parsed.data.data.plaintext, 'base64').toString('utf8');
  }

  needsRotation(envelope: string): boolean {
    const parts = envelope.split(':');

    if (parts[0] === 'kms' && parts[1] === 'vault') {
      return parts[2] !== this.options.config.vaultTransitKey;
    }

    // При активном облачном KMS локальные v1/v2 всегда мигрируют в KMS.
    return isLegacyEnvelope(envelope);
  }
}

export interface YandexProviderOptions {
  readonly config: KmsConfig;
  readonly legacy: LegacyCipher;
  readonly fetch?: typeof fetch;
}

export class YandexCloudKmsProvider implements IKmsEnvelopeProvider {
  readonly providerName = 'yandex-kms' as const;
  private readonly fetchFn: typeof fetch;

  constructor(private readonly options: YandexProviderOptions) {
    this.fetchFn = options.fetch ?? fetch;
  }

  private endpoint(action: 'encrypt' | 'decrypt'): string {
    return `https://yandex.net${this.options.config.yandexKeyId}:${action}`;
  }

  async encrypt(plaintext: string): Promise<string> {
    const raw = await postJson(
      this.endpoint('encrypt'),
      { plaintext: Buffer.from(plaintext, 'utf8').toString('base64') },
      { Authorization: `Bearer ${this.options.config.yandexIamToken}` },
      this.fetchFn,
    );
    const parsed = yandexEncryptResponseSchema.safeParse(raw);

    if (!parsed.success) {
      throw new Error('Yandex Cloud KMS вернул некорректный ответ encrypt');
    }

    return `kms:yandex:${this.options.config.yandexKeyId}:${parsed.data.ciphertext}`;
  }

  async decrypt(envelope: string): Promise<string> {
    const parts = envelope.split(':', 4);

    if (parts[0] !== 'kms' || parts[1] !== 'yandex' || parts.length !== 4) {
      if (isLegacyEnvelope(envelope)) {
        return await this.options.legacy.decrypt(envelope);
      }
      throw new Error('Некорректный Yandex KMS envelope');
    }

    const keyId = z.string().min(1).max(256).parse(parts[2]);
    const ciphertext = z.string().min(1).parse(parts[3]);
    const raw = await postJson(
      `https://yandex.net${keyId}:decrypt`,
      { ciphertext },
      { Authorization: `Bearer ${this.options.config.yandexIamToken}` },
      this.fetchFn,
    );
    const parsed = yandexDecryptResponseSchema.safeParse(raw);

    if (!parsed.success) {
      throw new Error('Yandex Cloud KMS вернул некорректный ответ decrypt');
    }

    return Buffer.from(parsed.data.plaintext, 'base64').toString('utf8');
  }

  needsRotation(envelope: string): boolean {
    const parts = envelope.split(':');

    if (parts[0] === 'kms' && parts[1] === 'yandex') {
      return parts[2] !== this.options.config.yandexKeyId;
    }

    return isLegacyEnvelope(envelope);
  }
}

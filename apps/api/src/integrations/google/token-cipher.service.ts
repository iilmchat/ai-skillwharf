import { Injectable, Optional } from '@nestjs/common';
import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
} from 'node:crypto';
import { z } from 'zod';
import { providerNotConfiguredError } from '../../common/api-error.js';

const ALGORITHM = 'aes-256-gcm';
const KEY_BYTES = 32;
const VERSION_V2 = 'v2';
const VERSION_V1 = 'v1';
const IV_BYTES = 12;
const TAG_BYTES = 16;

const INVALID_ENVELOPE = 'Некорректный формат зашифрованного токена';

/** `keyId` из envelope: только символы, безопасные для разделителя `:`. */
const keyIdSchema = z.string().min(1).max(128).regex(/^[A-Za-z0-9._-]+$/);

/** Ключ AES-256 в base64; валидируется через Zod до создания KMS. */
const keyMaterialSchema = z
  .string()
  .min(1)
  .refine((value) => Buffer.from(value, 'base64').length === KEY_BYTES, {
    message: 'ключ должен быть base64-строкой из 32 байт',
  });

/** Зашифрованный блок KMS-провайдера. */
export interface EncryptedPayload {
  readonly iv: Buffer;
  readonly tag: Buffer;
  readonly ciphertext: Buffer;
}

/**
 * Абстракция KMS/secret-провайдера для OAuth-токенов.
 *
 * Локальная реализация — AES-256-GCM с ключом из env. Yandex KMS/Vault
 * подключаются заменой провайдера; формат ciphertext и вызывающий код
 * (`GoogleOAuthService`) при этом не меняются.
 */
export interface KeyManagementService {
  readonly keyId: string;
  encrypt(plaintext: Buffer): EncryptedPayload;
  decrypt(payload: EncryptedPayload): Buffer;
}

/** Локальный KMS-провайдер на AES-256-GCM. */
export class LocalAesGcmKms implements KeyManagementService {
  constructor(
    private readonly key: Buffer,
    readonly keyId: string,
  ) {
    if (key.length !== KEY_BYTES) {
      throw new Error('KMS: ключ AES-256 должен быть длиной 32 байта');
    }
  }

  encrypt(plaintext: Buffer): EncryptedPayload {
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv(ALGORITHM, this.key, iv, {
      authTagLength: TAG_BYTES,
    });
    const ciphertext = Buffer.concat([
      cipher.update(plaintext),
      cipher.final(),
    ]);

    return { iv, tag: cipher.getAuthTag(), ciphertext };
  }

  decrypt(payload: EncryptedPayload): Buffer {
    const decipher = createDecipheriv(ALGORITHM, this.key, payload.iv, {
      authTagLength: TAG_BYTES,
    });

    decipher.setAuthTag(payload.tag);

    return Buffer.concat([
      decipher.update(payload.ciphertext),
      decipher.final(),
    ]);
  }
}

export interface TokenCipherOptions {
  /** Переопределяет `TOKEN_ENCRYPTION_KEY_ID` (для тестов и миграций). */
  readonly keyId?: string;
  /** Переопределяет `TOKEN_ENCRYPTION_PREVIOUS_KEYS`. */
  readonly previousKeys?: ReadonlyMap<string, Buffer>;
  readonly env?: NodeJS.ProcessEnv;
}

const previousKeysJsonSchema = z.union([
  z
    .record(keyIdSchema, keyMaterialSchema)
    .transform((record) =>
      Object.entries(record).map(([keyId, key]) => ({ keyId, key })),
    ),
  z.array(z.object({ keyId: keyIdSchema, key: keyMaterialSchema })),
]);

const previousKeysListSchema = z.array(
  z.object({ keyId: keyIdSchema, key: keyMaterialSchema }),
);

/**
 * Читает предыдущие ключи из `TOKEN_ENCRYPTION_PREVIOUS_KEYS`.
 *
 * Два формата: JSON (`{"local-v0":"<base64>"}` или массив
 * `[{"keyId":"local-v0","key":"<base64>"}]`) и CSV
 * (`local-v0:<base64>,backup-2025:<base64>`). Невалидный формат — ошибка:
 * ротация не должна молча терять доступ к старым данным.
 */
export function parsePreviousKeys(
  raw: string | undefined = process.env.TOKEN_ENCRYPTION_PREVIOUS_KEYS,
): ReadonlyMap<string, Buffer> {
  const source = (raw ?? '').trim();

  if (source === '') {
    return new Map<string, Buffer>();
  }

  let entries: ReadonlyArray<{ keyId: string; key: string }>;

  if (source.startsWith('{') || source.startsWith('[')) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(source) as unknown;
    } catch {
      throw new Error('TOKEN_ENCRYPTION_PREVIOUS_KEYS: некорректный JSON');
    }

    const result = previousKeysJsonSchema.safeParse(parsed);

    if (!result.success) {
      throw new Error(
        `TOKEN_ENCRYPTION_PREVIOUS_KEYS: ${result.error.issues.map((issue) => issue.message).join('; ')}`,
      );
    }

    entries = result.data;
  } else {
    const candidates = source.split(',').map((item) => {
      const separator = item.indexOf(':');

      return {
        keyId: item.slice(0, separator),
        key: item.slice(separator + 1),
      };
    });
    const result = previousKeysListSchema.safeParse(candidates);

    if (!result.success) {
      throw new Error(
        `TOKEN_ENCRYPTION_PREVIOUS_KEYS: ${result.error.issues.map((issue) => issue.message).join('; ')}`,
      );
    }

    entries = result.data;
  }

  return new Map(
    entries.map((entry) => [entry.keyId, Buffer.from(entry.key, 'base64')]),
  );
}

function decodeEnvelopeParts(
  ivPart: string,
  tagPart: string,
  dataPart: string,
): EncryptedPayload {
  const parts = z
    .array(z.string().min(1))
    .safeParse([ivPart, tagPart, dataPart]);

  if (!parts.success) {
    throw new Error(INVALID_ENVELOPE);
  }

  const [iv, tag, ciphertext] = parts.data.map((part) =>
    Buffer.from(part, 'base64'),
  );

  if (
    iv === undefined ||
    tag === undefined ||
    ciphertext === undefined ||
    iv.length !== IV_BYTES ||
    tag.length !== TAG_BYTES ||
    ciphertext.length === 0
  ) {
    throw new Error(INVALID_ENVELOPE);
  }

  return { iv, tag, ciphertext };
}

/**
 * Шифрование секретов в БД (AES-256-GCM).
 *
 * Формат записи: `v2:<keyId>:<iv>:<tag>:<ciphertext>` (все части, кроме
 * `keyId`, — base64). Старые записи `v1:<iv>:<tag>:<ciphertext>` читаются
 * через активный или один из предыдущих ключей. Ключ — `TOKEN_ENCRYPTION_KEY`
 * (base64, 32 байта); без него шифрование недоступно
 * (`errors.provider_not_configured`).
 */
@Injectable()
export class TokenCipherService {
  private readonly current: KeyManagementService | null;
  private readonly keys: ReadonlyMap<string, KeyManagementService>;

  constructor(@Optional() key?: Buffer, options: TokenCipherOptions = {}) {
    const env = options.env ?? process.env;
    const activeKey = key ?? readKeyFromEnv(env);
    const keyId = keyIdSchema.parse(options.keyId ?? readKeyIdFromEnv(env));
    const previous =
      options.previousKeys ?? parsePreviousKeys(env.TOKEN_ENCRYPTION_PREVIOUS_KEYS);
    const available = new Map<string, KeyManagementService>();

    for (const [previousId, material] of previous) {
      available.set(previousId, new LocalAesGcmKms(material, previousId));
    }

    if (activeKey !== null) {
      this.current = new LocalAesGcmKms(activeKey, keyId);
      // Активный ключ перекрывает previous с тем же keyId.
      available.set(keyId, this.current);
    } else {
      this.current = null;
    }

    this.keys = available;
  }

  isConfigured(): boolean {
    return this.current !== null;
  }

  /** Идентификатор активного ключа (для аудита и ротации). */
  get keyId(): string | null {
    return this.current?.keyId ?? null;
  }

  encrypt(plaintext: string): string {
    const kms = this.requireKms();
    const payload = kms.encrypt(Buffer.from(plaintext, 'utf8'));

    return [
      VERSION_V2,
      kms.keyId,
      payload.iv.toString('base64'),
      payload.tag.toString('base64'),
      payload.ciphertext.toString('base64'),
    ].join(':');
  }

  decrypt(envelope: string): string {
    const parts = envelope.split(':');
    const version = parts[0];

    if (version === VERSION_V1 && parts.length === 4) {
      const data = decodeEnvelopeParts(parts[1] ?? '', parts[2] ?? '', parts[3] ?? '');

      // v1 не содержит keyId: пробуем активный, затем previous keys.
      for (const kms of this.orderedKeys()) {
        const decrypted = tryDecrypt(kms, data);

        if (decrypted !== null) {
          return decrypted.toString('utf8');
        }
      }

      throw new Error(INVALID_ENVELOPE);
    }

    if (version === VERSION_V2 && parts.length === 5) {
      const parsedKeyId = keyIdSchema.safeParse(parts[1]);

      if (!parsedKeyId.success) {
        throw new Error(INVALID_ENVELOPE);
      }

      const kms = this.keys.get(parsedKeyId.data);

      if (kms === undefined) {
        throw new Error(`Неизвестный keyId в зашифрованном токене: ${parsedKeyId.data}`);
      }

      const data = decodeEnvelopeParts(parts[2] ?? '', parts[3] ?? '', parts[4] ?? '');
      const decrypted = tryDecrypt(kms, data);

      if (decrypted === null) {
        throw new Error(INVALID_ENVELOPE);
      }

      return decrypted.toString('utf8');
    }

    throw new Error(INVALID_ENVELOPE);
  }

  /**
   * true, если запись нужно перешифровать: старый v1 или v2 с чужим keyId.
   * Используется `CredentialRotationService` и CLI `keys:rotate`.
   */
  needsRotation(envelope: string): boolean {
    const parts = envelope.split(':');

    return !(
      parts[0] === VERSION_V2 &&
      parts.length === 5 &&
      parts[1] === this.current?.keyId
    );
  }

  /** Ключи в порядке попытки расшифровки v1: активный, затем previous. */
  private orderedKeys(): readonly KeyManagementService[] {
    const all = [...this.keys.values()];

    if (this.current === null) {
      return all;
    }

    return [this.current, ...all.filter((kms) => kms !== this.current)];
  }

  private requireKms(): KeyManagementService {
    if (this.current === null) {
      throw providerNotConfiguredError(
        'Шифрование токенов не настроено: задайте TOKEN_ENCRYPTION_KEY (base64, 32 байта)',
      );
    }

    return this.current;
  }
}

function tryDecrypt(
  kms: KeyManagementService,
  payload: EncryptedPayload,
): Buffer | null {
  try {
    return kms.decrypt(payload);
  } catch {
    return null;
  }
}

function readKeyFromEnv(env: NodeJS.ProcessEnv): Buffer | null {
  const raw = env.TOKEN_ENCRYPTION_KEY?.trim() ?? '';

  if (raw === '') {
    return null;
  }

  const parsed = keyMaterialSchema.safeParse(raw);

  if (!parsed.success) {
    throw new Error(
      'TOKEN_ENCRYPTION_KEY должен быть base64-строкой из 32 байт',
    );
  }

  return Buffer.from(parsed.data, 'base64');
}

function readKeyIdFromEnv(env: NodeJS.ProcessEnv): string {
  return keyIdSchema.parse(env.TOKEN_ENCRYPTION_KEY_ID?.trim() || 'local-v1');
}

import { Injectable, Optional } from '@nestjs/common';
import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
} from 'node:crypto';
import { providerNotConfiguredError } from '../../common/api-error.js';

const ALGORITHM = 'aes-256-gcm';
const KEY_BYTES = 32;
const VERSION = 'v1';
const IV_BYTES = 12;
const TAG_BYTES = 16;

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

/**
 * Шифрование OAuth-токенов в БД (AES-256-GCM).
 *
 * Refresh-token Google — долгоживущий секрет: хранить его открытым текстом
 * нельзя. Формат строки: `v1:<iv>:<tag>:<ciphertext>` (base64).
 * Ключ — `TOKEN_ENCRYPTION_KEY` (base64, 32 байта); без него подключение
 * Google не сохраняется (`errors.provider_not_configured`).
 */
@Injectable()
export class TokenCipherService {
  private readonly kms: KeyManagementService | null;

  constructor(@Optional() key?: Buffer) {
    this.kms =
      key === undefined
        ? createKmsFromEnv()
        : new LocalAesGcmKms(key, readKeyIdFromEnv());
  }

  isConfigured(): boolean {
    return this.kms !== null;
  }

  /** Идентификатор ключа для аудита/будущей ротации. */
  get keyId(): string | null {
    return this.kms?.keyId ?? null;
  }

  encrypt(plaintext: string): string {
    const kms = this.requireKms();
    const payload = kms.encrypt(Buffer.from(plaintext, 'utf8'));

    return [
      VERSION,
      payload.iv.toString('base64'),
      payload.tag.toString('base64'),
      payload.ciphertext.toString('base64'),
    ].join(':');
  }

  decrypt(payload: string): string {
    const kms = this.requireKms();
    const parts = payload.split(':');

    if (parts.length !== 4 || parts[0] !== VERSION) {
      throw new Error('Некорректный формат зашифрованного токена');
    }

    const iv = Buffer.from(parts[1] ?? '', 'base64');
    const tag = Buffer.from(parts[2] ?? '', 'base64');
    const data = Buffer.from(parts[3] ?? '', 'base64');

    if (iv.length !== IV_BYTES || tag.length !== TAG_BYTES || data.length === 0) {
      throw new Error('Некорректный формат зашифрованного токена');
    }

    return kms
      .decrypt({ iv, tag, ciphertext: data })
      .toString('utf8');
  }

  private requireKms(): KeyManagementService {
    if (this.kms === null) {
      throw providerNotConfiguredError(
        'Шифрование токенов не настроено: задайте TOKEN_ENCRYPTION_KEY (base64, 32 байта)',
      );
    }

    return this.kms;
  }
}

function createKmsFromEnv(): KeyManagementService | null {
  const key = readKeyFromEnv();

  return key === null ? null : new LocalAesGcmKms(key, readKeyIdFromEnv());
}

function readKeyFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): Buffer | null {
  const raw = env.TOKEN_ENCRYPTION_KEY?.trim() ?? '';

  if (raw === '') {
    return null;
  }

  const key = Buffer.from(raw, 'base64');

  if (key.length !== KEY_BYTES) {
    throw new Error(
      'TOKEN_ENCRYPTION_KEY должен быть base64-строкой из 32 байт',
    );
  }

  return key;
}

function readKeyIdFromEnv(env: NodeJS.ProcessEnv = process.env): string {
  return env.TOKEN_ENCRYPTION_KEY_ID?.trim() || 'local-v1';
}

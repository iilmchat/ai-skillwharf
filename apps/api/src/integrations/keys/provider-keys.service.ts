import { Injectable, Logger, Optional } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service.js';
import { TokenCipherService } from '../google/token-cipher.service.js';
import {
  WB_TOKEN_TTL_DAYS,
  midjourneyKeysSchema,
  midjourneySecretSchema,
  ozonKeysSchema,
  ozonSecretSchema,
  providerMetadataSchema,
  wildberriesKeysSchema,
  wildberriesSecretSchema,
  type KeyProvider,
  type MidjourneyKeys,
  type OzonKeys,
  type WildberriesKeys,
} from './provider-keys.schemas.js';

/** Статус интеграции в терминах UI (`integrationStatusSchema`). */
export type ProviderIntegrationStatus = 'active' | 'disconnected' | 'error';

export interface OzonIntegrationState {
  readonly status: ProviderIntegrationStatus;
  readonly clientId?: string;
  /** Источник ключей: подключение пользователя или env (системные ключи). */
  readonly source?: 'user' | 'env';
  readonly error?: string;
}

export interface WildberriesIntegrationState {
  readonly status: ProviderIntegrationStatus;
  readonly tokenExpiresAt?: string;
  readonly source?: 'user' | 'env';
  readonly error?: string;
}

export interface MidjourneyIntegrationState {
  readonly status: ProviderIntegrationStatus;
  readonly source?: 'user' | 'env';
  readonly error?: string;
}

export interface ProviderIntegrationStates {
  readonly ozon: OzonIntegrationState;
  readonly wildberries: WildberriesIntegrationState;
  readonly midjourney: MidjourneyIntegrationState;
}

/** Ключи провайдера и источник, из которого они получены. */
export interface ResolvedOzonKeys extends OzonKeys {
  readonly source: 'user' | 'env';
}

export interface ResolvedWildberriesToken {
  readonly token: string;
  readonly source: 'user' | 'env';
}

export interface ResolvedMidjourneyKey {
  readonly apiKey: string;
  readonly source: 'user' | 'env';
}

const CIPHER_ERROR =
  'Ключи сохранены, но не расшифровываются: проверьте TOKEN_ENCRYPTION_KEY или подключите интеграцию заново';

/**
 * Хранение ключей Ozon/Wildberries/Midjourney.
 *
 * Секреты шифруются `TokenCipherService` (AES-256-GCM) и попадают в
 * `ProviderCredential.secret` только в виде envelope
 * `v1:<iv>:<tag>:<ciphertext>`. Инструменты (`MarketplaceMcpService`,
 * `MidjourneyService`) читают ключи по `userId` и падают обратно на env
 * (системные ключи для ботов/локальной разработки).
 */
@Injectable()
export class ProviderKeysService {
  private readonly logger = new Logger(ProviderKeysService.name);
  private readonly now: () => Date;

  constructor(
    private readonly prisma: PrismaService,
    private readonly cipher: TokenCipherService,
    @Optional() now?: () => Date,
  ) {
    this.now = now ?? (() => new Date());
  }

  /** Сохраняет ключи Ozon (Client ID + API Key) зашифрованными. */
  async connectOzon(
    userId: string,
    keys: OzonKeys,
  ): Promise<OzonIntegrationState> {
    const parsed = ozonKeysSchema.parse(keys);

    await this.save(userId, 'ozon', parsed);
    this.logger.log(
      JSON.stringify({ event: 'integration.ozon_connected', userId }),
    );

    return { status: 'active', clientId: parsed.clientId, source: 'user' };
  }

  /**
   * Сохраняет токен Wildberries.
   *
   * Продавец выдаёт токен на 180 дней, поэтому дата истечения считается при
   * подключении и хранится в `metadata` (неконфиденциально) — UI показывает
   * предупреждение заранее.
   */
  async connectWildberries(
    userId: string,
    keys: WildberriesKeys,
  ): Promise<WildberriesIntegrationState> {
    const parsed = wildberriesKeysSchema.parse(keys);
    const tokenExpiresAt = this.wbExpiry();

    await this.save(
      userId,
      'wildberries',
      parsed,
      { tokenExpiresAt } satisfies Prisma.InputJsonValue,
    );
    this.logger.log(
      JSON.stringify({
        event: 'integration.wildberries_connected',
        userId,
        tokenExpiresAt,
      }),
    );

    return { status: 'active', tokenExpiresAt, source: 'user' };
  }

  /** Сохраняет ключ TTAPI (Midjourney) зашифрованным. */
  async connectMidjourney(
    userId: string,
    keys: MidjourneyKeys,
  ): Promise<MidjourneyIntegrationState> {
    const parsed = midjourneyKeysSchema.parse(keys);

    await this.save(userId, 'midjourney', parsed);
    this.logger.log(
      JSON.stringify({ event: 'integration.midjourney_connected', userId }),
    );

    return { status: 'active', source: 'user' };
  }

  /** Удаляет ключи провайдера; `true` — если запись действительно была. */
  async disconnect(userId: string, provider: KeyProvider): Promise<boolean> {
    const { count } = await this.prisma.providerCredential.deleteMany({
      where: { userId, provider },
    });

    if (count > 0) {
      this.logger.log(
        JSON.stringify({
          event: 'integration.provider_disconnected',
          userId,
          provider,
        }),
      );
    }

    return count > 0;
  }

  /** Состояние трёх провайдеров для `GET /integrations`. */
  async describe(userId: string): Promise<ProviderIntegrationStates> {
    const rows = await this.prisma.providerCredential.findMany({
      where: { userId },
      select: { provider: true, secret: true, metadata: true },
    });
    const byProvider = new Map(rows.map((row) => [row.provider, row]));
    const ozonRow = byProvider.get('ozon');
    const wbRow = byProvider.get('wildberries');
    const mjRow = byProvider.get('midjourney');

    return {
      ozon: this.describeOzon(ozonRow),
      wildberries: this.describeWildberries(wbRow),
      midjourney: this.describeMidjourney(mjRow),
    };
  }

  /** Ключи Ozon: подключение пользователя → env (системные ключи). */
  async ozonKeys(userId?: string): Promise<ResolvedOzonKeys | null> {
    const row = await this.find(userId, 'ozon');

    if (row !== null) {
      const secret = this.decrypt(row.secret, 'ozon');
      const parsed =
        secret === null ? null : ozonSecretSchema.safeParse(secret);

      if (parsed !== null && parsed.success) {
        return { ...parsed.data, source: 'user' };
      }
    }

    return envOzonKeys();
  }

  /** Токен WB: подключение пользователя → env. */
  async wildberriesToken(
    userId?: string,
  ): Promise<ResolvedWildberriesToken | null> {
    const row = await this.find(userId, 'wildberries');

    if (row !== null) {
      const secret = this.decrypt(row.secret, 'wildberries');
      const parsed =
        secret === null ? null : wildberriesSecretSchema.safeParse(secret);

      if (parsed !== null && parsed.success) {
        return { token: parsed.data.apiToken, source: 'user' };
      }
    }

    const envToken = readEnv('WB_API_TOKEN');

    return envToken === null ? null : { token: envToken, source: 'env' };
  }

  /** Ключ TTAPI: подключение пользователя → env. */
  async midjourneyKey(userId?: string): Promise<ResolvedMidjourneyKey | null> {
    const row = await this.find(userId, 'midjourney');

    if (row !== null) {
      const secret = this.decrypt(row.secret, 'midjourney');
      const parsed =
        secret === null ? null : midjourneySecretSchema.safeParse(secret);

      if (parsed !== null && parsed.success) {
        return { apiKey: parsed.data.apiKey, source: 'user' };
      }
    }

    const envKey = readEnv('MIDJOURNEY_API_KEY');

    return envKey === null ? null : { apiKey: envKey, source: 'env' };
  }

  private async save(
    userId: string,
    provider: KeyProvider,
    payload: object,
    metadata?: Prisma.InputJsonValue,
  ): Promise<void> {
    // Шифруем весь payload целиком: в БД нет ни Client ID, ни ключей.
    const secret = this.cipher.encrypt(JSON.stringify(payload));

    await this.prisma.providerCredential.upsert({
      where: { userId_provider: { userId, provider } },
      create: {
        userId,
        provider,
        secret,
        ...(metadata === undefined ? {} : { metadata }),
      },
      update: {
        secret,
        ...(metadata === undefined ? {} : { metadata }),
      },
    });
  }

  private async find(
    userId: string | undefined,
    provider: KeyProvider,
  ): Promise<{ secret: string; metadata: Prisma.JsonValue } | null> {
    if (userId === undefined) {
      return null;
    }

    return this.prisma.providerCredential.findUnique({
      where: { userId_provider: { userId, provider } },
      select: { secret: true, metadata: true },
    });
  }

  private decrypt(secret: string, provider: KeyProvider): unknown | null {
    try {
      const plaintext = this.cipher.decrypt(secret);

      return JSON.parse(plaintext) as unknown;
    } catch (error) {
      this.logger.warn(
        JSON.stringify({
          event: 'integration.provider_decrypt_failed',
          provider,
          message: error instanceof Error ? error.message : String(error),
        }),
      );

      return null;
    }
  }

  private describeOzon(
    row: { secret: string } | undefined,
  ): OzonIntegrationState {
    if (row === undefined) {
      return envOzonKeys() === null
        ? { status: 'disconnected' }
        : { status: 'active', source: 'env' };
    }

    const secret = this.decrypt(row.secret, 'ozon');
    const parsed = secret === null ? null : ozonSecretSchema.safeParse(secret);

    if (parsed === null || !parsed.success) {
      return { status: 'error', error: CIPHER_ERROR };
    }

    return {
      status: 'active',
      clientId: parsed.data.clientId,
      source: 'user',
    };
  }

  private describeWildberries(
    row: { secret: string; metadata: Prisma.JsonValue } | undefined,
  ): WildberriesIntegrationState {
    if (row === undefined) {
      return readEnv('WB_API_TOKEN') === null
        ? { status: 'disconnected' }
        : { status: 'active', source: 'env' };
    }

    const secret = this.decrypt(row.secret, 'wildberries');

    if (
      secret === null ||
      !wildberriesSecretSchema.safeParse(secret).success
    ) {
      return { status: 'error', error: CIPHER_ERROR };
    }

    const metadata = providerMetadataSchema.safeParse(row.metadata ?? {});
    const tokenExpiresAt = metadata.success
      ? metadata.data.tokenExpiresAt
      : undefined;

    if (tokenExpiresAt !== undefined && Date.parse(tokenExpiresAt) <= this.now().getTime()) {
      return {
        status: 'error',
        tokenExpiresAt,
        source: 'user',
        error:
          'Срок действия токена Wildberries истёк — получите новый токен в кабинете продавца',
      };
    }

    return {
      status: 'active',
      ...(tokenExpiresAt === undefined ? {} : { tokenExpiresAt }),
      source: 'user',
    };
  }

  private describeMidjourney(
    row: { secret: string } | undefined,
  ): MidjourneyIntegrationState {
    if (row === undefined) {
      return readEnv('MIDJOURNEY_API_KEY') === null
        ? { status: 'disconnected' }
        : { status: 'active', source: 'env' };
    }

    const secret = this.decrypt(row.secret, 'midjourney');

    if (secret === null || !midjourneySecretSchema.safeParse(secret).success) {
      return { status: 'error', error: CIPHER_ERROR };
    }

    return { status: 'active', source: 'user' };
  }

  private wbExpiry(): string {
    const expires = new Date(this.now().getTime());

    expires.setUTCDate(expires.getUTCDate() + WB_TOKEN_TTL_DAYS);

    return expires.toISOString();
  }
}

function readEnv(name: string): string | null {
  const value = process.env[name]?.trim() ?? '';

  return value === '' ? null : value;
}

function envOzonKeys(): ResolvedOzonKeys | null {
  const clientId = readEnv('OZON_CLIENT_ID');
  const apiKey = readEnv('OZON_API_KEY');

  return clientId === null || apiKey === null
    ? null
    : { clientId, apiKey, source: 'env' };
}

import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';

/**
 * Короткоживущие подписанные токены для внутреннего канала api <-> llm-worker
 * (Sprint 26 / SEC-26.1, KI-045).
 *
 * Общий секрет `INTERNAL_API_TOKEN` остаётся источником ключа HMAC-SHA256, но
 * по проводу передаётся не он, а JWT на 60 секунд с жёстко зафиксированными
 * направлением (`iss`/`aud`) и одноразовым `jti`. Статический токен принимается
 * только при явном `ALLOW_LEGACY_INTERNAL_TOKEN=true` и только вне production.
 */

/** TTL внутреннего JWT (секунды). */
export const INTERNAL_JWT_TTL_SECONDS = 60;

/** Минимальная длина секрета во внутреннем контуре production. */
export const MIN_INTERNAL_SECRET_LENGTH = 32;

export const internalIssuerSchema = z.enum([
  'skillwharf-api',
  'skillwharf-worker',
]);
export const internalAudienceSchema = z.enum(['internal-worker', 'internal-api']);

export type InternalIssuer = z.infer<typeof internalIssuerSchema>;
export type InternalAudience = z.infer<typeof internalAudienceSchema>;

/** Направление вызова:API → worker или worker → API. */
export type InternalJwtDirection = 'api-to-worker' | 'worker-to-api';

const DIRECTIONS: Readonly<
  Record<InternalJwtDirection, { iss: InternalIssuer; aud: InternalAudience }>
> = {
  'api-to-worker': { iss: 'skillwharf-api', aud: 'internal-worker' },
  'worker-to-api': { iss: 'skillwharf-worker', aud: 'internal-api' },
};

export const internalJwtHeaderSchema = z
  .object({
    alg: z.literal('HS256'),
    typ: z.literal('JWT'),
  })
  .strict();

export const internalJwtClaimsSchema = z
  .object({
    iss: internalIssuerSchema,
    aud: internalAudienceSchema,
    jti: z.string().uuid(),
    iat: z.number().int().nonnegative(),
    exp: z.number().int().nonnegative(),
  })
  .strict();

export type InternalJwtClaims = z.infer<typeof internalJwtClaimsSchema>;

/** Ошибка верификации внутреннего токена. Не содержит значения токена. */
export class InternalAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InternalAuthError';
  }
}

const booleanFlagSchema = z.enum(['true', 'false']).catch('false');

export interface InternalAuthConfig {
  /** Ключ HMAC; пустой допустим только вне production (dev-режим без auth). */
  readonly secret: string;
  /** Исторический dev-режим: внутренние эндпоинты открыты. */
  readonly authDisabled: boolean;
  /** Разрешён только вне production и только при явном флаге. */
  readonly legacyToken: string | null;
}

/**
 * Читает и валидирует конфигурацию внутреннего канала через Zod.
 *
 * `NODE_ENV=production` + пустой/короткий `INTERNAL_API_TOKEN` — ошибка:
 * сервис не стартует (fail closed). В dev пустой токен сохраняет прежнее
 * поведение (проверка выключена), а короткий токен работает только как JWT-key.
 */
export function readInternalAuthConfig(
  env: NodeJS.ProcessEnv = process.env,
): InternalAuthConfig {
  const raw = (env.INTERNAL_API_TOKEN ?? '').trim();
  const isProduction = z.literal('production').safeParse(env.NODE_ENV).success;
  const allowLegacy =
    booleanFlagSchema.parse(
      (env.ALLOW_LEGACY_INTERNAL_TOKEN ?? 'false').trim().toLowerCase(),
    ) === 'true' && !isProduction;

  if (isProduction) {
    const secret = z
      .string()
      .min(
        MIN_INTERNAL_SECRET_LENGTH,
        `INTERNAL_API_TOKEN в production должен быть не короче ${MIN_INTERNAL_SECRET_LENGTH} символов`,
      )
      .safeParse(raw);

    if (!secret.success) {
      throw new InternalAuthError(
        `INTERNAL_API_TOKEN в production обязателен (минимум ${MIN_INTERNAL_SECRET_LENGTH} символов)`,
      );
    }

    // В production legacy-токен запрещён даже при включённом флаге.
    return { secret: secret.data, authDisabled: false, legacyToken: null };
  }

  if (raw === '') {
    return { secret: '', authDisabled: true, legacyToken: null };
  }

  const secret = z.string().min(1).parse(raw);

  return {
    secret,
    authDisabled: false,
    legacyToken: allowLegacy ? secret : null,
  };
}

/** Вызывается при старте api/llm-worker: невалидная prod-конфигурация = exit. */
export function assertInternalAuthConfig(
  env: NodeJS.ProcessEnv = process.env,
): void {
  readInternalAuthConfig(env);
}

function encodeBase64Url(value: string): string {
  return Buffer.from(value, 'utf8').toString('base64url');
}

function decodeBase64Url(value: string, field: string): string {
  const parsed = z
    .string()
    .regex(/^[A-Za-z0-9_-]+$/)
    .safeParse(value);

  if (!parsed.success) {
    throw new InternalAuthError(`некорректный ${field} внутреннего JWT`);
  }

  return Buffer.from(value, 'base64url').toString('utf8');
}

function parseJsonLike(value: string, field: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    throw new InternalAuthError(`некорректный ${field} внутреннего JWT`);
  }
}

function sign(encodedHeader: string, encodedPayload: string, secret: string): string {
  return createHmac('sha256', secret)
    .update(`${encodedHeader}.${encodedPayload}`)
    .digest('base64url');
}

export interface IssueInternalJwtOptions {
  readonly direction: InternalJwtDirection;
  readonly nowSeconds?: number;
  readonly ttlSeconds?: number;
}

/** Выпускает JWT на 60 секунд с уникальным `jti`. */
export function issueInternalJwt(
  secret: string,
  options: IssueInternalJwtOptions,
): string {
  const key = z.string().min(1).parse(secret);
  const ttl = z
    .number()
    .int()
    .positive()
    .max(INTERNAL_JWT_TTL_SECONDS)
    .parse(options.ttlSeconds ?? INTERNAL_JWT_TTL_SECONDS);
  const now = options.nowSeconds ?? Math.floor(Date.now() / 1000);
  const direction = DIRECTIONS[options.direction];
  const claims = internalJwtClaimsSchema.parse({
    ...direction,
    jti: randomUUID(),
    iat: z.number().int().nonnegative().parse(now),
    exp: now + ttl,
  });
  const header = internalJwtHeaderSchema.parse({ alg: 'HS256', typ: 'JWT' });
  const encodedHeader = encodeBase64Url(JSON.stringify(header));
  const encodedPayload = encodeBase64Url(JSON.stringify(claims));

  return `${encodedHeader}.${encodedPayload}.${sign(encodedHeader, encodedPayload, key)}`;
}

/**
 * Проверяет подпись, claims, направление и срок жизни. Возвращает claims.
 * Любое нарушение — `InternalAuthError` (значение токена в сообщение не попадает).
 */
export function verifyInternalJwt(
  token: string,
  secret: string,
  expectedAudience: InternalAudience,
  nowSeconds: number = Math.floor(Date.now() / 1000),
): InternalJwtClaims {
  const raw = z.string().min(1).safeParse(token);

  if (!raw.success) {
    throw new InternalAuthError('внутренний токен отсутствует');
  }

  const parts = raw.data.split('.');

  if (parts.length !== 3) {
    throw new InternalAuthError('некорректная структура внутреннего JWT');
  }

  const [encodedHeader, encodedPayload, signature] = parts as [string, string, string];
  const header = internalJwtHeaderSchema.safeParse(
    parseJsonLike(decodeBase64Url(encodedHeader, 'header'), 'header'),
  );
  const claims = internalJwtClaimsSchema.safeParse(
    parseJsonLike(decodeBase64Url(encodedPayload, 'payload'), 'payload'),
  );

  if (!header.success || !claims.success) {
    throw new InternalAuthError('некорректные claims внутреннего JWT');
  }

  const expectedIssuer: InternalIssuer =
    expectedAudience === 'internal-api' ? 'skillwharf-worker' : 'skillwharf-api';

  if (claims.data.aud !== expectedAudience || claims.data.iss !== expectedIssuer) {
    throw new InternalAuthError('неверное направление внутреннего JWT');
  }

  const lifetime = claims.data.exp - claims.data.iat;
  const ttl = z
    .number()
    .int()
    .positive()
    .max(INTERNAL_JWT_TTL_SECONDS)
    .safeParse(lifetime);

  if (!ttl.success || claims.data.exp <= nowSeconds || claims.data.iat > nowSeconds + 5) {
    throw new InternalAuthError('срок действия внутреннего JWT истёк или некорректен');
  }

  const expected = Buffer.from(sign(encodedHeader, encodedPayload, secret), 'base64url');
  const actual = Buffer.from(signature, 'base64url');

  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
    throw new InternalAuthError('неверная подпись внутреннего JWT');
  }

  return claims.data;
}

/** Единая точка выпуска/проверки для api и llm-worker. */
export class InternalTokenAuth {
  private readonly config: InternalAuthConfig;

  constructor(env: NodeJS.ProcessEnv = process.env) {
    this.config = readInternalAuthConfig(env);
  }

  issue(direction: InternalJwtDirection, nowSeconds?: number): string | null {
    if (this.config.authDisabled) {
      return null;
    }

    return issueInternalJwt(this.config.secret, { direction, nowSeconds });
  }

  /**
   * Проверяет входящий токен. Пустой secret в dev сохраняет старый open-режим;
   * legacy-токен принимается только с явным флагом вне production.
   */
  verify(
    token: string | undefined,
    expectedAudience: InternalAudience,
    nowSeconds?: number,
  ): void {
    if (this.config.authDisabled) {
      return;
    }

    const raw = (token ?? '').trim();

    if (raw === '') {
      throw new InternalAuthError('внутренний токен отсутствует');
    }

    if (this.config.legacyToken !== null) {
      const expected = Buffer.from(this.config.legacyToken, 'utf8');
      const actual = Buffer.from(raw, 'utf8');

      if (actual.length === expected.length && timingSafeEqual(actual, expected)) {
        return;
      }
    }

    verifyInternalJwt(raw, this.config.secret, expectedAudience, nowSeconds);
  }
}

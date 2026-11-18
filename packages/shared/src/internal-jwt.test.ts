import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  INTERNAL_JWT_TTL_SECONDS,
  InternalAuthError,
  InternalTokenAuth,
  issueInternalJwt,
  readInternalAuthConfig,
  verifyInternalJwt,
} from './internal-jwt.js';

const SECRET = 'x'.repeat(32);

/** Подписывает произвольные claims тем же secret (для негативных тестов). */
function forge(
  claims: Record<string, unknown>,
  secret: string = SECRET,
): string {
  const header = Buffer.from(
    JSON.stringify({ alg: 'HS256', typ: 'JWT' }),
  ).toString('base64url');
  const payload = Buffer.from(JSON.stringify(claims)).toString('base64url');
  const signature = createHmac('sha256', secret)
    .update(`${header}.${payload}`)
    .digest('base64url');

  return `${header}.${payload}.${signature}`;
}

const validClaims = (overrides: Record<string, unknown> = {}) => ({
  iss: 'skillwharf-api',
  aud: 'internal-worker',
  jti: '550e8400-e29b-41d4-a716-446655440000',
  iat: 1_000_000,
  exp: 1_000_000 + INTERNAL_JWT_TTL_SECONDS,
  ...overrides,
});

describe('внутренний JWT (SEC-26.1)', () => {
  it('выпускает токен на 60 секунд с iss/aud/jti/iat/exp', () => {
    const token = issueInternalJwt(SECRET, {
      direction: 'api-to-worker',
      nowSeconds: 1_000_000,
    });
    const payload = token.split('.')[1] ?? '';
    const claims = JSON.parse(
      Buffer.from(payload, 'base64url').toString('utf8'),
    ) as Record<string, unknown>;

    expect(claims.iss).toBe('skillwharf-api');
    expect(claims.aud).toBe('internal-worker');
    expect(claims.iat).toBe(1_000_000);
    expect(claims.exp).toBe(1_000_000 + INTERNAL_JWT_TTL_SECONDS);
    expect(claims.jti).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('принимает токены обоих направлений', () => {
    const toWorker = issueInternalJwt(SECRET, {
      direction: 'api-to-worker',
      nowSeconds: 1_000_000,
    });
    const toApi = issueInternalJwt(SECRET, {
      direction: 'worker-to-api',
      nowSeconds: 1_000_000,
    });

    expect(() =>
      verifyInternalJwt(toWorker, SECRET, 'internal-worker', 1_000_001),
    ).not.toThrow();
    expect(() =>
      verifyInternalJwt(toApi, SECRET, 'internal-api', 1_000_001),
    ).not.toThrow();
  });

  it('отвергает неверную аудиторию', () => {
    const token = issueInternalJwt(SECRET, {
      direction: 'api-to-worker',
      nowSeconds: 1_000_000,
    });

    expect(() =>
      verifyInternalJwt(token, SECRET, 'internal-api', 1_000_001),
    ).toThrow(InternalAuthError);
  });

  it('отвергает неверного издателя при правильной аудитории', () => {
    const token = forge(validClaims({ iss: 'skillwharf-api', aud: 'internal-api' }));

    expect(() =>
      verifyInternalJwt(token, SECRET, 'internal-api', 1_000_001),
    ).toThrow(/направление/);
  });

  it('отвергает истёкший exp и слишком длинный TTL', () => {
    const token = issueInternalJwt(SECRET, {
      direction: 'api-to-worker',
      nowSeconds: 1_000_000,
    });

    expect(() =>
      verifyInternalJwt(token, SECRET, 'internal-worker', 1_000_061),
    ).toThrow(/истёк/);
    expect(() =>
      verifyInternalJwt(
        forge(validClaims({ exp: 1_000_000 + 3600 })),
        SECRET,
        'internal-worker',
        1_000_001,
      ),
    ).toThrow(/истёк/);
  });

  it('отвергает неверную подпись и невалидные claims', () => {
    const token = issueInternalJwt(SECRET, {
      direction: 'api-to-worker',
      nowSeconds: 1_000_000,
    });
    const parts = token.split('.');
    const broken = `${parts[0]}.${parts[1]}.${'A'.repeat(parts[2]?.length ?? 0)}`;

    expect(() =>
      verifyInternalJwt(broken, SECRET, 'internal-worker', 1_000_001),
    ).toThrow(/подпись/);
    expect(() =>
      verifyInternalJwt(forge(validClaims({ jti: 'not-a-uuid' })), SECRET, 'internal-worker', 1_000_001),
    ).toThrow(/claims/);
    expect(() => verifyInternalJwt('', SECRET, 'internal-worker')).toThrow(
      InternalAuthError,
    );
  });

  it('fail closed: production без короткого/пустого секрета', () => {
    expect(() =>
      readInternalAuthConfig({ NODE_ENV: 'production', INTERNAL_API_TOKEN: '' }),
    ).toThrow(/INTERNAL_API_TOKEN/);
    expect(() =>
      readInternalAuthConfig({
        NODE_ENV: 'production',
        INTERNAL_API_TOKEN: 'too-short',
        ALLOW_LEGACY_INTERNAL_TOKEN: 'true',
      }),
    ).toThrow(/INTERNAL_API_TOKEN/);

    const config = readInternalAuthConfig({
      NODE_ENV: 'production',
      INTERNAL_API_TOKEN: SECRET,
      ALLOW_LEGACY_INTERNAL_TOKEN: 'true',
    });

    expect(config.legacyToken).toBeNull();
    expect(config.authDisabled).toBe(false);
  });

  it('legacy-токен принимается только с явным флагом вне production', () => {
    const withLegacy = new InternalTokenAuth({
      NODE_ENV: 'development',
      INTERNAL_API_TOKEN: 'dev-secret',
      ALLOW_LEGACY_INTERNAL_TOKEN: 'true',
    });

    expect(() =>
      withLegacy.verify('dev-secret', 'internal-worker'),
    ).not.toThrow();
    expect(() =>
      withLegacy.verify('other', 'internal-worker'),
    ).toThrow(InternalAuthError);

    const withoutLegacy = new InternalTokenAuth({
      NODE_ENV: 'test',
      INTERNAL_API_TOKEN: 'dev-secret',
    });

    expect(() =>
      withoutLegacy.verify('dev-secret', 'internal-worker'),
    ).toThrow(InternalAuthError);
  });

  it('dev без секрета сохраняет прежний открытый режим', () => {
    const auth = new InternalTokenAuth({ NODE_ENV: 'development' });

    expect(auth.issue('api-to-worker')).toBeNull();
    expect(() => auth.verify(undefined, 'internal-worker')).not.toThrow();
  });
});

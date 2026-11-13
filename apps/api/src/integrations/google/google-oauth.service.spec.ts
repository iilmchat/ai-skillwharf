import nock from 'nock';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiException } from '../../common/api-error.js';
import { ERROR_KEYS } from '../../i18n/error-keys.js';
import type { PrismaService } from '../../prisma/prisma.service.js';
import { GoogleConfig } from './google.config.js';
import {
  GoogleOAuthService,
  emailFromIdToken,
  signOAuthState,
  verifyOAuthState,
} from './google-oauth.service.js';
import { TokenCipherService } from './token-cipher.service.js';

const KEY = Buffer.alloc(32, 7);
const NOW = new Date('2026-11-13T10:00:00Z');
const STATE_SECRET = 'state-secret';

function config(): GoogleConfig {
  return new GoogleConfig(
    'client-id',
    'client-secret',
    'https://api.example.com/api/v1/integrations/google/callback',
    ['scope-sheets', 'scope-docs'],
    'primary',
    STATE_SECRET,
    KEY.toString('base64'),
  );
}

interface CredentialRow {
  userId: string;
  accessToken: string;
  refreshToken: string | null;
  scope: string;
  email: string | null;
  expiresAt: Date;
}

interface PrismaMock {
  googleCredential: {
    findUnique: ReturnType<typeof vi.fn>;
    upsert: ReturnType<typeof vi.fn>;
    update: ReturnType<typeof vi.fn>;
    deleteMany: ReturnType<typeof vi.fn>;
  };
}

function createService(): {
  service: GoogleOAuthService;
  prisma: PrismaMock;
  cipher: TokenCipherService;
} {
  const prisma: PrismaMock = {
    googleCredential: {
      findUnique: vi.fn(async () => null),
      upsert: vi.fn(async () => ({})),
      update: vi.fn(async () => ({})),
      deleteMany: vi.fn(async () => ({ count: 1 })),
    },
  };
  const cipher = new TokenCipherService(KEY);
  const service = new GoogleOAuthService(
    prisma as unknown as PrismaService,
    cipher,
    config(),
    { maxAttempts: 2, baseDelayMs: 1, maxDelayMs: 2, maxRetryAfterMs: 100 },
    () => NOW,
  );

  return { service, prisma, cipher };
}

function idToken(email: string): string {
  const payload = Buffer.from(JSON.stringify({ email }), 'utf8').toString(
    'base64url',
  );

  return `header.${payload}.signature`;
}

function credentialRow(overrides: Partial<CredentialRow> = {}): CredentialRow {
  const cipher = new TokenCipherService(KEY);

  return {
    userId: 'user-1',
    accessToken: cipher.encrypt('access-old'),
    refreshToken: cipher.encrypt('refresh-1'),
    scope: 'scope-sheets',
    email: 'user@example.com',
    expiresAt: new Date(NOW.getTime() + 3_600_000),
    ...overrides,
  };
}

describe('GoogleOAuthService', () => {
  beforeEach(() => {
    nock.disableNetConnect();
    delete process.env.OUTBOUND_ALLOWLIST;
    delete process.env.API_OUTBOUND_ALLOWLIST;
  });

  afterEach(() => {
    nock.cleanAll();
    nock.enableNetConnect();
    vi.restoreAllMocks();
  });

  it('строит URL согласия с client_id, scopes и подписанным state', () => {
    const { service } = createService();
    const { url, state } = service.buildAuthUrl('user-1');
    const parsed = new URL(url);

    expect(parsed.origin).toBe('https://accounts.google.com');
    expect(parsed.searchParams.get('client_id')).toBe('client-id');
    expect(parsed.searchParams.get('redirect_uri')).toBe(
      'https://api.example.com/api/v1/integrations/google/callback',
    );
    expect(parsed.searchParams.get('scope')).toBe('scope-sheets scope-docs');
    expect(parsed.searchParams.get('access_type')).toBe('offline');
    expect(parsed.searchParams.get('prompt')).toBe('consent');
    expect(parsed.searchParams.get('state')).toBe(state);
    expect(verifyOAuthState(state, STATE_SECRET, NOW).sub).toBe('user-1');
  });

  it('обменивает code на токены и сохраняет их зашифрованными', async () => {
    const { service, prisma, cipher } = createService();
    const state = signOAuthState(
      { sub: 'user-1', exp: NOW.getTime() + 60_000, n: 'nonce' },
      STATE_SECRET,
    );

    nock('https://oauth2.googleapis.com')
      .post('/token')
      .reply(200, {
        access_token: 'access-new',
        expires_in: 3600,
        refresh_token: 'refresh-new',
        scope: 'scope-sheets scope-docs',
        token_type: 'Bearer',
        id_token: idToken('google-user@example.com'),
      });

    const result = await service.handleCallback('code-1', state);
    const create = prisma.googleCredential.upsert.mock.calls[0]?.[0] as {
      create: {
        accessToken: string;
        refreshToken: string;
        email: string;
      };
    };

    expect(result.userId).toBe('user-1');
    expect(result.scope).toBe('scope-sheets scope-docs');
    expect(result.expiresAt.getTime()).toBe(NOW.getTime() + 3_600_000);
    expect(create.create.accessToken).not.toBe('access-new');
    expect(cipher.decrypt(create.create.accessToken)).toBe('access-new');
    expect(cipher.decrypt(create.create.refreshToken)).toBe('refresh-new');
    expect(create.create.email).toBe('google-user@example.com');
  });

  it('возвращает свежий access-token без refresh', async () => {
    const { service, prisma } = createService();
    prisma.googleCredential.findUnique.mockResolvedValue(credentialRow());

    await expect(service.getAccessToken('user-1')).resolves.toBe('access-old');
    expect(prisma.googleCredential.update).not.toHaveBeenCalled();
  });

  it('обновляет истёкший access-token по refresh_token', async () => {
    const { service, prisma, cipher } = createService();
    prisma.googleCredential.findUnique.mockResolvedValue(
      credentialRow({ expiresAt: new Date(NOW.getTime() + 10_000) }),
    );

    nock('https://oauth2.googleapis.com')
      .post('/token')
      .reply(200, {
        access_token: 'access-refreshed',
        expires_in: 3600,
      });

    await expect(service.getAccessToken('user-1')).resolves.toBe(
      'access-refreshed',
    );

    const update = prisma.googleCredential.update.mock.calls[0]?.[0] as {
      data: { accessToken: string; refreshToken: string; expiresAt: Date };
    };

    expect(cipher.decrypt(update.data.accessToken)).toBe('access-refreshed');
    // Google не прислал новый refresh_token — старый сохраняется.
    expect(cipher.decrypt(update.data.refreshToken)).toBe('refresh-1');
    expect(update.data.expiresAt.getTime()).toBe(NOW.getTime() + 3_600_000);
  });

  it('forceRefresh обновляет токен даже при свежем expiresAt', async () => {
    const { service, prisma } = createService();
    prisma.googleCredential.findUnique.mockResolvedValue(credentialRow());

    nock('https://oauth2.googleapis.com')
      .post('/token')
      .reply(200, { access_token: 'forced', expires_in: 3600 });

    await expect(
      service.getAccessToken('user-1', { forceRefresh: true }),
    ).resolves.toBe('forced');
  });

  it('без подключения отдаёт provider_auth_required', async () => {
    const { service } = createService();
    const error: unknown = await service
      .getAccessToken('user-1')
      .catch((caught: unknown) => caught);

    expect((error as ApiException).getResponse()).toMatchObject({
      statusCode: 502,
      code: ERROR_KEYS.providerAuthRequired,
    });
  });

  it('без refresh_token и истёкшем токене просит переподключить Google', async () => {
    const { service, prisma } = createService();
    prisma.googleCredential.findUnique.mockResolvedValue(
      credentialRow({
        refreshToken: null,
        expiresAt: new Date(NOW.getTime() - 1_000),
      }),
    );

    const error: unknown = await service
      .getAccessToken('user-1')
      .catch((caught: unknown) => caught);

    expect((error as ApiException).getResponse()).toMatchObject({
      code: ERROR_KEYS.providerAuthRequired,
    });
  });

  it('status не раскрывает токены', async () => {
    const { service, prisma } = createService();
    prisma.googleCredential.findUnique.mockResolvedValue({
      scope: 'scope-sheets',
      email: 'user@example.com',
      expiresAt: new Date(NOW.getTime() + 60_000),
    });

    await expect(service.status('user-1')).resolves.toEqual({
      configured: true,
      connected: true,
      scope: 'scope-sheets',
      email: 'user@example.com',
      expiresAt: new Date(NOW.getTime() + 60_000).toISOString(),
    });
  });

  it('disconnect удаляет подключение', async () => {
    const { service, prisma } = createService();

    await expect(service.disconnect('user-1')).resolves.toBe(true);
    expect(prisma.googleCredential.deleteMany).toHaveBeenCalledWith({
      where: { userId: 'user-1' },
    });
  });

  it('подделанный или истёкший state отклоняется', () => {
    const valid = signOAuthState(
      { sub: 'user-1', exp: NOW.getTime() + 60_000, n: 'nonce' },
      STATE_SECRET,
    );
    const [body] = valid.split('.');

    expect(() =>
      verifyOAuthState(`${body}.forged`, STATE_SECRET, NOW),
    ).toThrow(/подпись/i);

    expect(() =>
      verifyOAuthState(
        signOAuthState(
          { sub: 'user-1', exp: NOW.getTime() - 1, n: 'nonce' },
          STATE_SECRET,
        ),
        STATE_SECRET,
        NOW,
      ),
    ).toThrow(/истёк/i);
  });
});

describe('emailFromIdToken', () => {
  it('достаёт email из payload', () => {
    expect(emailFromIdToken(idToken('a@b.c'))).toBe('a@b.c');
  });

  it('возвращает null для мусора', () => {
    expect(emailFromIdToken(undefined)).toBeNull();
    expect(emailFromIdToken('not-a-jwt')).toBeNull();
    expect(emailFromIdToken('a.%%%.b')).toBeNull();
  });
});

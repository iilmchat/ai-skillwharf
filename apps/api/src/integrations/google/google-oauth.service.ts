import { Injectable, Logger, Optional } from '@nestjs/common';
import {
  createHmac,
  randomUUID,
  timingSafeEqual,
} from 'node:crypto';
import {
  invalidRequestError,
  providerAuthRequiredError,
  providerNotConfiguredError,
  providerUnavailableError,
} from '../../common/api-error.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import {
  providerRequest,
  type ProviderRetryPolicy,
} from '../provider-http.js';
import {
  GoogleConfig,
  googleTokenResponseSchema,
  type GoogleTokenResponse,
} from './google.config.js';
import { TokenCipherService } from './token-cipher.service.js';

/** Authorization-endpoint Google OAuth 2.0. */
export const GOOGLE_AUTH_URL =
  'https://accounts.google.com/o/oauth2/v2/auth';

/** Token-endpoint Google OAuth 2.0 (обмен кода и refresh). */
export const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';

/** Срок жизни OAuth-state: 10 минут. */
export const OAUTH_STATE_TTL_MS = 10 * 60 * 1000;

/** Подписанный state: привязывает callback к пользователю без сессии. */
export interface OAuthStatePayload {
  /** userId, инициировавший подключение. */
  sub: string;
  /** Срок действия, epoch ms. */
  exp: number;
  /** Nonce: защита от повторного использования строки. */
  n: string;
}

/** Статус подключения Google для пользователя. */
export interface GoogleConnectionStatus {
  readonly configured: boolean;
  readonly connected: boolean;
  readonly scope?: string;
  readonly email?: string;
  readonly expiresAt?: string;
}

/**
 * OAuth-flow Google Workspace: выдача URL согласия, обмен кода, refresh токена.
 *
 * Токены в БД шифруются `TokenCipherService`; `state` подписан HMAC, поэтому
 * callback нельзя перенаправить на другого пользователя. Refresh выполняется
 * за минуту до истечения access-token'а.
 */
@Injectable()
export class GoogleOAuthService {
  private readonly logger = new Logger(GoogleOAuthService.name);
  private readonly config: GoogleConfig;
  private readonly retry: ProviderRetryPolicy | undefined;
  private readonly now: () => Date;

  constructor(
    private readonly prisma: PrismaService,
    private readonly cipher: TokenCipherService,
    @Optional() config?: GoogleConfig,
    @Optional() retry?: ProviderRetryPolicy,
    @Optional() now?: () => Date,
  ) {
    this.config = config ?? GoogleConfig.fromEnv();
    this.retry = retry;
    this.now = now ?? (() => new Date());
  }

  isConfigured(): boolean {
    return this.config.isOAuthConfigured() && this.cipher.isConfigured();
  }

  /** URL согласия Google и подписанный state для callback. */
  buildAuthUrl(userId: string): { url: string; state: string } {
    this.assertConfigured();

    const state = signOAuthState(
      {
        sub: userId,
        exp: this.now().getTime() + OAUTH_STATE_TTL_MS,
        n: randomUUID(),
      },
      this.requireStateSecret(),
    );
    const params = new URLSearchParams({
      client_id: this.config.clientId ?? '',
      redirect_uri: this.config.redirectUri ?? '',
      response_type: 'code',
      scope: this.config.scopes.join(' '),
      access_type: 'offline',
      include_granted_scopes: 'true',
      // prompt=consent гарантирует refresh_token при повторном подключении.
      prompt: 'consent',
      state,
    });

    return { url: `${GOOGLE_AUTH_URL}?${params.toString()}`, state };
  }

  /**
   * Обмен authorization code на токены и сохранение подключения.
   * `refresh_token` приходит только при `access_type=offline` + consent;
   * если Google его не прислал, сохраняем прежний.
   */
  async handleCallback(
    code: string,
    state: string,
  ): Promise<{ userId: string; scope: string; expiresAt: Date }> {
    this.assertConfigured();

    const payload = verifyOAuthState(
      state,
      this.requireStateSecret(),
      this.now(),
    );
    const tokens = await this.exchange({
      grant_type: 'authorization_code',
      code,
      client_id: this.config.clientId ?? '',
      client_secret: this.config.clientSecret ?? '',
      redirect_uri: this.config.redirectUri ?? '',
    });
    const expiresAt = new Date(
      this.now().getTime() + tokens.expires_in * 1_000,
    );
    const scope = tokens.scope?.trim() || this.config.scopes.join(' ');
    const existing = await this.prisma.googleCredential.findUnique({
      where: { userId: payload.sub },
      select: { refreshToken: true, email: true },
    });
    const existingRefreshToken =
      existing === null ? null : this.decryptRefreshToken(existing.refreshToken);
    const refreshToken = tokens.refresh_token ?? existingRefreshToken ?? null;
    const storedRefreshToken =
      refreshToken === null ? null : this.cipher.encrypt(refreshToken);
    const email = emailFromIdToken(tokens.id_token) ?? existing?.email ?? null;

    await this.prisma.googleCredential.upsert({
      where: { userId: payload.sub },
      create: {
        userId: payload.sub,
        accessToken: this.cipher.encrypt(tokens.access_token),
        refreshToken: storedRefreshToken,
        scope,
        email,
        expiresAt,
      },
      update: {
        accessToken: this.cipher.encrypt(tokens.access_token),
        refreshToken: storedRefreshToken,
        scope,
        email,
        expiresAt,
      },
    });

    this.logger.log(
      JSON.stringify({
        event: 'google.oauth.connected',
        userId: payload.sub,
        scope,
      }),
    );

    return { userId: payload.sub, scope, expiresAt };
  }

  /**
   * Access-token пользователя. За минуту до истечения обновляется по
   * refresh-token'у; `forceRefresh` нужен после 401 от Google API.
   */
  async getAccessToken(
    userId: string,
    options: { forceRefresh?: boolean } = {},
  ): Promise<string> {
    this.assertConfigured();

    const credential = await this.prisma.googleCredential.findUnique({
      where: { userId },
    });

    if (credential === null) {
      throw providerAuthRequiredError(
        'Google не подключён: пользователю нужно пройти OAuth',
      );
    }

    const expiresAt = credential.expiresAt.getTime();
    const freshEnough = expiresAt - this.now().getTime() > 60_000;

    if (!options.forceRefresh && freshEnough) {
      return this.decryptToken(credential.accessToken);
    }

    const refreshToken = this.decryptRefreshToken(credential.refreshToken);

    if (refreshToken === null) {
      throw providerAuthRequiredError(
        'Google refresh-token отсутствует: подключите Google заново',
      );
    }

    const tokens = await this.exchange({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      client_id: this.config.clientId ?? '',
      client_secret: this.config.clientSecret ?? '',
    });
    const nextExpiresAt = new Date(
      this.now().getTime() + tokens.expires_in * 1_000,
    );
    const nextRefreshToken = tokens.refresh_token ?? refreshToken;

    await this.prisma.googleCredential.update({
      where: { userId },
      data: {
        accessToken: this.cipher.encrypt(tokens.access_token),
        refreshToken: this.cipher.encrypt(nextRefreshToken),
        expiresAt: nextExpiresAt,
        ...(tokens.scope === undefined ? {} : { scope: tokens.scope }),
      },
    });

    return tokens.access_token;
  }

  /** Статус подключения без раскрытия токенов. */
  async status(userId: string): Promise<GoogleConnectionStatus> {
    const credential = await this.prisma.googleCredential.findUnique({
      where: { userId },
      select: { scope: true, email: true, expiresAt: true },
    });

    return {
      configured: this.isConfigured(),
      connected: credential !== null,
      ...(credential === null
        ? {}
        : {
            scope: credential.scope,
            ...(credential.email === null
              ? {}
              : { email: credential.email }),
            expiresAt: credential.expiresAt.toISOString(),
          }),
    };
  }

  /** Отзывает локальное подключение (токены удаляются из БД). */
  async disconnect(userId: string): Promise<boolean> {
    const { count } = await this.prisma.googleCredential.deleteMany({
      where: { userId },
    });

    return count > 0;
  }

  /** Обмен кода/refresh на токены с повторами на 429/5xx. */
  private async exchange(
    fields: Record<string, string>,
  ): Promise<GoogleTokenResponse> {
    return providerRequest({
      provider: 'google',
      method: 'POST',
      url: GOOGLE_TOKEN_URL,
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
      },
      data: new URLSearchParams(fields).toString(),
      schema: googleTokenResponseSchema,
      ...(this.retry === undefined ? {} : { retry: this.retry }),
      logger: this.logger,
    });
  }

  private decryptToken(encrypted: string): string {
    try {
      return this.cipher.decrypt(encrypted);
    } catch (error) {
      throw providerUnavailableError(
        `Не удалось расшифровать Google-токен: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  private decryptRefreshToken(encrypted: string | null): string | null {
    if (encrypted === null) {
      return null;
    }

    try {
      return this.cipher.decrypt(encrypted);
    } catch {
      throw providerAuthRequiredError(
        'Google refresh-token повреждён: подключите Google заново',
      );
    }
  }

  private assertConfigured(): void {
    if (!this.isConfigured()) {
      throw providerNotConfiguredError(
        'Google OAuth не настроен: задайте GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REDIRECT_URI, TOKEN_ENCRYPTION_KEY',
      );
    }
  }

  private requireStateSecret(): string {
    if (this.config.stateSecret === null) {
      throw providerNotConfiguredError(
        'OAuth-state не настроен: задайте GOOGLE_OAUTH_STATE_SECRET или TOKEN_ENCRYPTION_KEY',
      );
    }

    return this.config.stateSecret;
  }
}

/**
 * Email из id_token (JWT от Google).
 *
 * Подпись не проверяется: токен получен по TLS напрямую от token-endpoint
 * Google и используется только для отображения аккаунта в UI.
 */
export function emailFromIdToken(
  idToken: string | undefined,
): string | null {
  if (idToken === undefined) {
    return null;
  }

  const parts = idToken.split('.');

  if (parts.length < 2) {
    return null;
  }

  try {
    const raw = Buffer.from(parts[1] ?? '', 'base64url').toString('utf8');
    const parsed: unknown = JSON.parse(raw);

    if (parsed === null || typeof parsed !== 'object') {
      return null;
    }

    const email = (parsed as Record<string, unknown>).email;

    return typeof email === 'string' && email.includes('@') ? email : null;
  } catch {
    return null;
  }
}

/** Подпись state: `base64url(payload).base64url(hmac)`. */
export function signOAuthState(  payload: OAuthStatePayload,
  secret: string,
): string {
  const body = Buffer.from(
    JSON.stringify({ sub: payload.sub, exp: payload.exp, n: payload.n }),
    'utf8',
  ).toString('base64url');
  const signature = createHmac('sha256', secret).update(body).digest('base64url');

  return `${body}.${signature}`;
}

/** Проверка подписи и срока действия state; ошибка — 400 invalid_request. */
export function verifyOAuthState(
  state: string,
  secret: string,
  now: Date,
): OAuthStatePayload {
  const [body, signature, extra] = state.split('.');

  if (body === undefined || signature === undefined || extra !== undefined) {
    throw invalidRequestError('Google OAuth: некорректный state');
  }

  const expected = createHmac('sha256', secret).update(body).digest();
  const actual = Buffer.from(signature, 'base64url');

  if (
    actual.length !== expected.length ||
    !timingSafeEqual(actual, expected)
  ) {
    throw invalidRequestError('Google OAuth: подпись state не совпадает');
  }

  let parsed: unknown;

  try {
    parsed = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
  } catch {
    throw invalidRequestError('Google OAuth: state не разбирается');
  }

  if (parsed === null || typeof parsed !== 'object') {
    throw invalidRequestError('Google OAuth: state пустой');
  }

  const record = parsed as Record<string, unknown>;
  const sub = record.sub;
  const exp = record.exp;
  const nonce = record.n;

  if (
    typeof sub !== 'string' ||
    sub === '' ||
    typeof exp !== 'number' ||
    !Number.isFinite(exp) ||
    typeof nonce !== 'string'
  ) {
    throw invalidRequestError('Google OAuth: state неполный');
  }

  if (exp <= now.getTime()) {
    throw invalidRequestError('Google OAuth: state истёк');
  }

  return { sub, exp, n: nonce };
}

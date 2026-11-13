import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiException } from '../common/api-error.js';
import { assertProviderEgress } from './provider-http.js';

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('provider egress', () => {
  it('разрешает Telegram и Google из allowlist', () => {
    vi.stubEnv(
      'OUTBOUND_ALLOWLIST',
      'api.telegram.org,www.googleapis.com,oauth2.googleapis.com',
    );

    expect(() =>
      assertProviderEgress('https://api.telegram.org/bot/sendMessage'),
    ).not.toThrow();
    expect(() =>
      assertProviderEgress('https://oauth2.googleapis.com/token'),
    ).not.toThrow();
    expect(() =>
      assertProviderEgress('https://www.googleapis.com/oauth2/v3/userinfo'),
    ).not.toThrow();
  });

  it('блокирует неизвестный домен и внешний http', () => {
    vi.stubEnv('OUTBOUND_ALLOWLIST', 'api.telegram.org');

    expect(() => assertProviderEgress('https://evil.example/hook')).toThrow(
      ApiException,
    );
    expect(() =>
      assertProviderEgress('http://api.telegram.org/bot/sendMessage'),
    ).toThrow(ApiException);
  });

  it('разрешает локальный Telegram API для тестов/self-hosted', () => {
    vi.stubEnv('OUTBOUND_ALLOWLIST', 'api.telegram.org');

    expect(() =>
      assertProviderEgress('http://host.docker.internal:8081/bot/sendMessage'),
    ).not.toThrow();
  });
});

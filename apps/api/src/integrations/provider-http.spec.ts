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

  it('разрешает TTAPI, Ozon Performance и WB Pricing из default allowlist', () => {
    vi.stubEnv('OUTBOUND_ALLOWLIST', '');

    expect(() =>
      assertProviderEgress(
        'https://api.ttapi.io/midjourney/v1/fetch?jobId=test',
      ),
    ).not.toThrow();
    expect(() =>
      assertProviderEgress('https://api-performance.ozon.ru/api/client/campaign'),
    ).not.toThrow();
    expect(() =>
      assertProviderEgress('https://discounts-prices-api.wildberries.ru/ping'),
    ).not.toThrow();
    expect(() => assertProviderEgress('https://api.goapi.ai/hook')).toThrow(
      ApiException,
    );
  });

  it('разрешает локальный Telegram API для тестов/self-hosted', () => {
    vi.stubEnv('OUTBOUND_ALLOWLIST', 'api.telegram.org');

    expect(() =>
      assertProviderEgress('http://host.docker.internal:8081/bot/sendMessage'),
    ).not.toThrow();
  });
});

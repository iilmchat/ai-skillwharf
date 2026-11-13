import type { ErrorEvent } from '@sentry/nestjs';
import {
  isSentryEnabled,
  sanitizeBreadcrumb,
  sanitizeSentryEvent,
  sanitizeString,
} from './sentry.js';

describe('Sentry PII filtering', () => {
  it('по умолчанию выключен без DSN', () => {
    expect(isSentryEnabled()).toBe(false);
  });

  it('маскирует токены и секреты в строках', () => {
    expect(sanitizeString('Authorization: Bearer abc.def.ghi')).toBe(
      'Authorization: Bearer [REDACTED]',
    );
    expect(sanitizeString('api_key=sk-123456789012345678901234')).toContain(
      '[REDACTED]',
    );
    expect(sanitizeString('token=ghp_123456789012345678901234')).toContain(
      '[REDACTED]',
    );
    expect(sanitizeString('jwt eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.sig')).toBe(
      'jwt [REDACTED]',
    );
  });

  it('удаляет заголовки, тела, cookies, user и query из события', () => {
    const event = {
      request: {
        url: 'https://api.example.com/chat?token=secret',
        headers: { authorization: 'Bearer top-secret' },
        cookies: { session: 'cookie-secret' },
        data: { password: 'p@ssw0rd', apiKey: 'sk-123456789012345678901234' },
        query_string: 'token=secret',
      },
      user: { id: 'user-1', email: 'user@example.com' },
      contexts: { response: { body: 'sensitive' } },
      extra: { token: 'ghp_123456789012345678901234', note: 'ok' },
      message: 'failed with Bearer abc.def.ghi',
      breadcrumbs: [
        {
          category: 'http',
          message: 'GET /chat?token=secret',
          data: { body: 'secret-body' },
        },
      ],
      exception: {
        values: [
          {
            value: 'API key sk-123456789012345678901234 rejected',
            stacktrace: {
              frames: [{ vars: { password: 'p@ssw0rd' } }],
            },
          },
        ],
      },
    } as unknown as ErrorEvent;

    const sanitized = sanitizeSentryEvent(event);

    expect(sanitized.request?.headers).toEqual({});
    expect(sanitized.request?.data).toBeUndefined();
    expect(sanitized.request?.cookies).toBeUndefined();
    expect(sanitized.request?.query_string).toBeUndefined();
    expect(sanitized.request?.url).toBe('https://api.example.com/chat');
    expect(sanitized.user).toBeUndefined();
    expect(sanitized.contexts).toBeUndefined();
    expect(String(sanitized.extra?.token)).toContain('[REDACTED]');
    expect(sanitized.message).toContain('[REDACTED]');
    expect(sanitized.breadcrumbs?.[0]?.message).toContain('token=[REDACTED]');
    expect(sanitized.exception?.values?.[0]?.value).toContain('[REDACTED]');
    expect(
      sanitized.exception?.values?.[0]?.stacktrace?.frames?.[0]?.vars,
    ).toBeUndefined();
  });

  it('фильтрует данные breadcrumbs', () => {
    const breadcrumb = sanitizeBreadcrumb({
      category: 'http',
      message: 'POST /login?api_key=secret',
      data: { authorization: 'Bearer secret', body: 'password=secret' },
    });

    expect(breadcrumb.message).toContain('[REDACTED]');
    expect(String(breadcrumb.data?.authorization)).toContain('[REDACTED]');
  });
});

import nock from 'nock';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiException } from '../../common/api-error.js';
import { ERROR_KEYS } from '../../i18n/error-keys.js';
import type { ProviderRetryPolicy } from '../provider-http.js';
import {
  GOOGLE_CALENDAR_API,
  GOOGLE_DOCS_API,
  GOOGLE_SHEETS_API,
  GoogleApiService,
  normalizeRows,
} from './google-api.service.js';
import { GoogleConfig } from './google.config.js';
import type { GoogleOAuthService } from './google-oauth.service.js';

const RETRY: ProviderRetryPolicy = {
  maxAttempts: 3,
  baseDelayMs: 1,
  maxDelayMs: 2,
  maxRetryAfterMs: 1_000,
};

function config(calendarId = 'primary'): GoogleConfig {
  return new GoogleConfig(
    'client-id',
    'client-secret',
    'https://api.example.com/callback',
    ['scope-1'],
    calendarId,
    'state-secret',
    null,
  );
}

interface OAuthMock {
  getAccessToken: ReturnType<typeof vi.fn>;
}

function createService(): { service: GoogleApiService; oauth: OAuthMock } {
  const oauth: OAuthMock = {
    getAccessToken: vi.fn(async () => 'access-token'),
  };

  return {
    service: new GoogleApiService(
      oauth as unknown as GoogleOAuthService,
      config(),
      RETRY,
    ),
    oauth,
  };
}

describe('GoogleApiService', () => {
  beforeEach(() => {
    nock.disableNetConnect();
    delete process.env.OUTBOUND_ALLOWLIST;
    delete process.env.API_OUTBOUND_ALLOWLIST;
  });

  afterEach(() => {
    nock.cleanAll();
    nock.enableNetConnect();
  });

  it('добавляет строки в Google Sheets и возвращает диапазон', async () => {
    const scope = nock(GOOGLE_SHEETS_API)
      .post(
        '/v4/spreadsheets/sheet-1/values/A1:append',
        (body: unknown) => {
          expect(body).toEqual({
            values: [['a', 1, true], ['b']],
          });

          return true;
        },
      )
      .query({
        valueInputOption: 'USER_ENTERED',
        insertDataOption: 'INSERT_ROWS',
      })
      .matchHeader('authorization', 'Bearer access-token')
      .reply(200, {
        spreadsheetId: 'sheet-1',
        updates: {
          updatedRange: 'Sheet1!A1:B2',
          updatedRows: 1,
          updatedCells: 2,
        },
      });

    const result = await createService().service.appendSheetRows('user-1', {
      spreadsheetId: 'sheet-1',
      values: [['a', 1, true], 'b'],
    });

    expect(result).toEqual({
      spreadsheetId: 'sheet-1',
      updatedRange: 'Sheet1!A1:B2',
      updatedRows: 1,
      updatedCells: 2,
    });
    expect(scope.isDone()).toBe(true);
  });

  it('создаёт документ и вставляет текст через batchUpdate', async () => {
    nock(GOOGLE_DOCS_API)
      .post('/v1/documents', { title: 'Отчёт' })
      .reply(200, { documentId: 'doc-1', title: 'Отчёт' });
    const batch = nock(GOOGLE_DOCS_API)
      .post('/v1/documents/doc-1:batchUpdate', (body: unknown) => {
        expect(body).toMatchObject({
          requests: [
            {
              insertText: {
                location: { index: 1 },
                text: 'Текст отчёта',
              },
            },
          ],
        });

        return true;
      })
      .reply(200, { documentId: 'doc-1' });

    const document = await createService().service.createDocument('user-1', {
      title: 'Отчёт',
      content: 'Текст отчёта',
    });

    expect(document).toEqual({
      documentId: 'doc-1',
      title: 'Отчёт',
      url: 'https://docs.google.com/document/d/doc-1/edit',
    });
    expect(batch.isDone()).toBe(true);
  });

  it('создаёт событие календаря с attendees', async () => {
    let body: unknown;

    nock(GOOGLE_CALENDAR_API)
      .post('/calendars/primary/events', (raw: unknown) => {
        body = raw;

        return true;
      })
      .reply(200, {
        id: 'event-1',
        htmlLink: 'https://calendar.google.com/event-1',
        status: 'confirmed',
        start: { dateTime: '2026-11-20T10:00:00.000Z' },
        end: { dateTime: '2026-11-20T11:00:00.000Z' },
      });

    const event = await createService().service.createCalendarEvent('user-1', {
      summary: 'Встреча',
      start: '2026-11-20T13:00:00+03:00',
      end: '2026-11-20T14:00:00+03:00',
      attendees: ['guest@example.com'],
    });

    expect(body).toMatchObject({
      summary: 'Встреча',
      start: { dateTime: '2026-11-20T10:00:00.000Z' },
      end: { dateTime: '2026-11-20T11:00:00.000Z' },
      attendees: [{ email: 'guest@example.com' }],
    });
    expect(event).toEqual({
      eventId: 'event-1',
      htmlLink: 'https://calendar.google.com/event-1',
      status: 'confirmed',
      start: '2026-11-20T10:00:00.000Z',
      end: '2026-11-20T11:00:00.000Z',
    });
  });

  it('отклоняет событие с end <= start до сетевого вызова', async () => {
    const error: unknown = await createService()
      .service.createCalendarEvent('user-1', {
        summary: 'x',
        start: '2026-11-20T11:00:00Z',
        end: '2026-11-20T10:00:00Z',
      })
      .catch((caught: unknown) => caught);

    expect((error as ApiException).getResponse()).toMatchObject({
      statusCode: 400,
      code: ERROR_KEYS.invalidRequest,
    });
  });

  it('повторяет 429 и учитывает Retry-After', async () => {
    nock(GOOGLE_SHEETS_API)
      .post('/v4/spreadsheets/sheet-1/values/A1:append')
      .query(true)
      .reply(
        429,
        {
          error: {
            code: 429,
            message: 'Resource exhausted',
            status: 'RESOURCE_EXHAUSTED',
            details: [{ retryDelay: '0s' }],
          },
        },
        { 'retry-after': '0' },
      );
    nock(GOOGLE_SHEETS_API)
      .post('/v4/spreadsheets/sheet-1/values/A1:append')
      .query(true)
      .reply(200, {
        spreadsheetId: 'sheet-1',
        updates: { updatedRange: 'Sheet1!A1', updatedRows: 1 },
      });

    const result = await createService().service.appendSheetRows('user-1', {
      spreadsheetId: 'sheet-1',
      values: ['x'],
    });

    expect(result.updatedRange).toBe('Sheet1!A1');
  });

  it('после 429 отдаёт provider_rate_limited', async () => {
    nock(GOOGLE_SHEETS_API)
      .post('/v4/spreadsheets/sheet-1/values/A1:append')
      .query(true)
      .times(3)
      .reply(429, {
        error: {
          code: 429,
          message: 'Too many requests',
          details: [{ retryDelay: '0s' }],
        },
      });

    const error: unknown = await createService()
      .service.appendSheetRows('user-1', {
        spreadsheetId: 'sheet-1',
        values: ['x'],
      })
      .catch((caught: unknown) => caught);

    expect((error as ApiException).getResponse()).toMatchObject({
      statusCode: 429,
      code: ERROR_KEYS.providerRateLimited,
    });
  });

  it('при 401 обновляет токен через OAuth и повторяет вызов', async () => {
    nock(GOOGLE_SHEETS_API)
      .post('/v4/spreadsheets/sheet-1/values/A1:append')
      .query(true)
      .reply(401, { error: { message: 'Invalid Credentials' } });
    nock(GOOGLE_SHEETS_API)
      .post('/v4/spreadsheets/sheet-1/values/A1:append')
      .query(true)
      .matchHeader('authorization', 'Bearer refreshed-token')
      .reply(200, {
        spreadsheetId: 'sheet-1',
        updates: { updatedRange: 'Sheet1!A1' },
      });

    const { service, oauth } = createService();

    oauth.getAccessToken
      .mockResolvedValueOnce('access-token')
      .mockResolvedValueOnce('refreshed-token');

    const result = await service.appendSheetRows('user-1', {
      spreadsheetId: 'sheet-1',
      values: ['x'],
    });

    expect(result.spreadsheetId).toBe('sheet-1');
    expect(oauth.getAccessToken).toHaveBeenNthCalledWith(2, 'user-1', {
      forceRefresh: true,
    });
  });
});

describe('normalizeRows', () => {
  it('разворачивает примитивы в строки и сериализует объекты', () => {
    expect(normalizeRows(['a', 1, true, null, ['b', 2], { c: 3 }])).toEqual([
      ['a'],
      [1],
      [true],
      [null],
      ['b', 2],
      ['{"c":3}'],
    ]);
  });
});

import { Injectable, Logger, Optional } from '@nestjs/common';
import { z } from 'zod';
import {
  ApiException,
  invalidRequestError,
} from '../../common/api-error.js';
import { ERROR_KEYS } from '../../i18n/error-keys.js';
import {
  providerRequest,
  type ProviderRetryPolicy,
} from '../provider-http.js';
import {
  GoogleConfig,
  googleBatchUpdateSchema,
  googleCalendarEventSchema,
  googleDocumentSchema,
  googleSheetAppendSchema,
} from './google.config.js';
import { GoogleOAuthService } from './google-oauth.service.js';

/** Google Sheets API v4. */
export const GOOGLE_SHEETS_API = 'https://sheets.googleapis.com';

/** Google Docs API v1. */
export const GOOGLE_DOCS_API = 'https://docs.googleapis.com';

/** Google Calendar API v3. */
export const GOOGLE_CALENDAR_API = 'https://www.googleapis.com/calendar/v3';

/** Значение ячейки таблицы, которое принимает Sheets API. */
export type SheetCell = string | number | boolean | null;

/** Результат добавления строк. */
export interface SheetAppendResult {
  readonly spreadsheetId: string;
  readonly updatedRange?: string;
  readonly updatedRows?: number;
  readonly updatedCells?: number;
}

/** Результат создания документа. */
export interface CreatedDocument {
  readonly documentId: string;
  readonly title: string;
  readonly url: string;
}

/** Результат создания события. */
export interface CreatedCalendarEvent {
  readonly eventId: string;
  readonly htmlLink?: string;
  readonly status?: string;
  readonly start?: string;
  readonly end?: string;
}

/** Входные данные событий календаря (после Zod-валидации инструмента). */
export interface CalendarEventInput {
  readonly summary: string;
  readonly start: string;
  readonly end: string;
  readonly description?: string;
  readonly attendees?: readonly string[];
  readonly timeZone?: string;
}

const calendarBodySchema = z.object({
  summary: z.string().min(1),
  description: z.string().optional(),
  start: z.object({ dateTime: z.string(), timeZone: z.string().optional() }),
  end: z.object({ dateTime: z.string(), timeZone: z.string().optional() }),
  attendees: z.array(z.object({ email: z.string() })).optional(),
});

/**
 * Реальные вызовы Google Sheets/Docs/Calendar.
 *
 * Токен берётся из OAuth-подключения пользователя; при 401 Google токен
 * принудительно обновляется и запрос повторяется один раз. Все ответы
 * валидируются Zod, 429/5xx обрабатывает `providerRequest`.
 */
@Injectable()
export class GoogleApiService {
  private readonly logger = new Logger(GoogleApiService.name);
  private readonly calendarId: string;
  private readonly retry: ProviderRetryPolicy | undefined;

  constructor(
    private readonly oauth: GoogleOAuthService,
    @Optional() config?: GoogleConfig,
    @Optional() retry?: ProviderRetryPolicy,
  ) {
    this.calendarId = (config ?? GoogleConfig.fromEnv()).calendarId;
    this.retry = retry;
  }

  /**
   * Добавляет строки в конец таблицы. `values` — плоский список строк:
   * массив трактуется как готовая строка, примитив — как строка из одной
   * ячейки.
   */
  async appendSheetRows(
    userId: string,
    input: {
      spreadsheetId: string;
      range?: string;
      values: readonly unknown[];
    },
  ): Promise<SheetAppendResult> {
    const rows = normalizeRows(input.values);

    if (rows.length === 0) {
      throw invalidRequestError('Google Sheets: пустой список строк');
    }

    const range = input.range?.trim() || 'A1';
    const url = `${GOOGLE_SHEETS_API}/v4/spreadsheets/${encodeURIComponent(
      input.spreadsheetId,
    )}/values/${encodeURIComponent(range)}:append?valueInputOption=USER_ENTERED&insertDataOption=INSERT_ROWS`;

    const response = await this.withAccessToken(userId, (token) =>
      providerRequest({
        provider: 'google',
        method: 'POST',
        url,
        headers: {
          authorization: `Bearer ${token}`,
          'content-type': 'application/json',
        },
        data: { values: rows },
        schema: googleSheetAppendSchema,
        ...(this.retry === undefined ? {} : { retry: this.retry }),
        logger: this.logger,
      }),
    );

    return {
      spreadsheetId: response.spreadsheetId,
      ...(response.updates?.updatedRange === undefined
        ? {}
        : { updatedRange: response.updates.updatedRange }),
      ...(response.updates?.updatedRows === undefined
        ? {}
        : { updatedRows: response.updates.updatedRows }),
      ...(response.updates?.updatedCells === undefined
        ? {}
        : { updatedCells: response.updates.updatedCells }),
    };
  }

  /** Создаёт документ и вставляет текст (два вызова Docs API). */
  async createDocument(
    userId: string,
    input: { title: string; content: string },
  ): Promise<CreatedDocument> {
    const created = await this.withAccessToken(userId, (token) =>
      providerRequest({
        provider: 'google',
        method: 'POST',
        url: `${GOOGLE_DOCS_API}/v1/documents`,
        headers: {
          authorization: `Bearer ${token}`,
          'content-type': 'application/json',
        },
        data: { title: input.title },
        schema: googleDocumentSchema,
        ...(this.retry === undefined ? {} : { retry: this.retry }),
        logger: this.logger,
      }),
    );
    const content = input.content;

    if (content !== '') {
      await this.withAccessToken(userId, (token) =>
        providerRequest({
          provider: 'google',
          method: 'POST',
          url: `${GOOGLE_DOCS_API}/v1/documents/${encodeURIComponent(
            created.documentId,
          )}:batchUpdate`,
          headers: {
            authorization: `Bearer ${token}`,
            'content-type': 'application/json',
          },
          data: {
            requests: [
              {
                insertText: {
                  // Индекс 1 — начало тела документа (индекс 0 занят секцией).
                  location: { index: 1 },
                  text: content,
                },
              },
            ],
          },
          schema: googleBatchUpdateSchema,
          ...(this.retry === undefined ? {} : { retry: this.retry }),
          logger: this.logger,
        }),
      );
    }

    return {
      documentId: created.documentId,
      title: created.title ?? input.title,
      url: `https://docs.google.com/document/d/${created.documentId}/edit`,
    };
  }

  /** Создаёт событие в календаре (`primary` по умолчанию). */
  async createCalendarEvent(
    userId: string,
    input: CalendarEventInput,
  ): Promise<CreatedCalendarEvent> {
    const start = parseDateTime(input.start, 'start');
    const end = parseDateTime(input.end, 'end');

    if (end.getTime() <= start.getTime()) {
      throw invalidRequestError(
        'Google Calendar: end должен быть позже start',
      );
    }

    const body = calendarBodySchema.parse({
      summary: input.summary,
      ...(input.description === undefined
        ? {}
        : { description: input.description }),
      start: {
        dateTime: start.toISOString(),
        ...(input.timeZone === undefined ? {} : { timeZone: input.timeZone }),
      },
      end: {
        dateTime: end.toISOString(),
        ...(input.timeZone === undefined ? {} : { timeZone: input.timeZone }),
      },
      ...(input.attendees === undefined
        ? {}
        : { attendees: input.attendees.map((email) => ({ email })) }),
    });
    const url = `${GOOGLE_CALENDAR_API}/calendars/${encodeURIComponent(
      this.calendarId,
    )}/events`;

    const response = await this.withAccessToken(userId, (token) =>
      providerRequest({
        provider: 'google',
        method: 'POST',
        url,
        headers: {
          authorization: `Bearer ${token}`,
          'content-type': 'application/json',
        },
        data: body,
        schema: googleCalendarEventSchema,
        ...(this.retry === undefined ? {} : { retry: this.retry }),
        logger: this.logger,
      }),
    );

    return {
      eventId: response.id,
      ...(response.htmlLink === undefined
        ? {}
        : { htmlLink: response.htmlLink }),
      ...(response.status === undefined ? {} : { status: response.status }),
      ...(response.start?.dateTime === undefined
        ? {}
        : { start: response.start.dateTime }),
      ...(response.end?.dateTime === undefined
        ? {}
        : { end: response.end.dateTime }),
    };
  }

  /** Вызов с токеном; при 401 — один принудительный refresh и повтор. */
  private async withAccessToken<T>(
    userId: string,
    call: (token: string) => Promise<T>,
  ): Promise<T> {
    const token = await this.oauth.getAccessToken(userId);

    try {
      return await call(token);
    } catch (error) {
      if (!isAuthRequired(error)) {
        throw error;
      }

      const refreshed = await this.oauth.getAccessToken(userId, {
        forceRefresh: true,
      });

      return call(refreshed);
    }
  }
}

function isAuthRequired(error: unknown): boolean {
  return (
    error instanceof ApiException &&
    error.getResponse().code === ERROR_KEYS.providerAuthRequired
  );
}

/** Плоский список значений → строки таблицы. */
export function normalizeRows(values: readonly unknown[]): SheetCell[][] {
  return values.map((value) =>
    Array.isArray(value)
      ? value.map(toCell)
      : [toCell(value)],
  );
}

function toCell(value: unknown): SheetCell {
  if (
    typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'boolean' ||
    value === null
  ) {
    return value;
  }

  // Объекты/массивы в ячейке Sheets API не принимает: сериализуем в JSON.
  return JSON.stringify(value);
}

function parseDateTime(value: string, field: string): Date {
  const parsed = new Date(value);

  if (Number.isNaN(parsed.getTime())) {
    throw invalidRequestError(
      `Google Calendar: ${field} должен быть ISO 8601 датой/временем`,
    );
  }

  return parsed;
}

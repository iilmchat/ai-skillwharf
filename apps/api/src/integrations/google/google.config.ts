import { z } from 'zod';

/** Минимальные OAuth-scopes для инструментов Google Workspace. */
export const GOOGLE_DEFAULT_SCOPES = [
  'https://www.googleapis.com/auth/spreadsheets',
  'https://www.googleapis.com/auth/documents',
  'https://www.googleapis.com/auth/calendar.events',
] as const;

/** Google OAuth и API: конфигурация из окружения. */
export class GoogleConfig {
  constructor(
    readonly clientId: string | null,
    readonly clientSecret: string | null,
    readonly redirectUri: string | null,
    readonly scopes: readonly string[],
    readonly calendarId: string,
    /** Секрет HMAC для OAuth-state (по умолчанию — ключ шифрования токенов). */
    readonly stateSecret: string | null,
    /** Base64-ключ AES-256-GCM для токенов в БД. */
    readonly tokenEncryptionKey: string | null,
    /** Куда вернуть браузер после OAuth (`GOOGLE_OAUTH_SUCCESS_REDIRECT`). */
    readonly successRedirect: string | null = null,
  ) {}

  static fromEnv(env: NodeJS.ProcessEnv = process.env): GoogleConfig {
    const clientId = env.GOOGLE_CLIENT_ID?.trim() ?? '';
    const clientSecret = env.GOOGLE_CLIENT_SECRET?.trim() ?? '';
    const redirectUri = env.GOOGLE_REDIRECT_URI?.trim() ?? '';
    const rawScopes = env.GOOGLE_OAUTH_SCOPES?.trim() ?? '';
    const scopes =
      rawScopes === ''
        ? [...GOOGLE_DEFAULT_SCOPES]
        : rawScopes
            .split(/[\s,]+/)
            .map((scope) => scope.trim())
            .filter((scope) => scope !== '');
    const calendarId = env.GOOGLE_CALENDAR_ID?.trim() || 'primary';
    const tokenEncryptionKey = env.TOKEN_ENCRYPTION_KEY?.trim() ?? '';
    const stateSecret =
      env.GOOGLE_OAUTH_STATE_SECRET?.trim() || tokenEncryptionKey;
    const successRedirect =
      env.GOOGLE_OAUTH_SUCCESS_REDIRECT?.trim() ?? '';

    return new GoogleConfig(
      clientId === '' ? null : clientId,
      clientSecret === '' ? null : clientSecret,
      redirectUri === '' ? null : redirectUri,
      scopes,
      calendarId,
      stateSecret === '' ? null : stateSecret,
      tokenEncryptionKey === '' ? null : tokenEncryptionKey,
      successRedirect === '' ? null : successRedirect,
    );
  }

  isOAuthConfigured(): boolean {
    return (
      this.clientId !== null &&
      this.clientSecret !== null &&
      this.redirectUri !== null
    );
  }
}

/** Ответ token-endpoint Google. */
export const googleTokenResponseSchema = z.object({
  access_token: z.string().min(1),
  expires_in: z.number().int().positive(),
  refresh_token: z.string().min(1).optional(),
  scope: z.string().optional(),
  token_type: z.string().optional(),
  id_token: z.string().optional(),
});

export type GoogleTokenResponse = z.infer<typeof googleTokenResponseSchema>;

/** Ответ создания документа Google Docs. */
export const googleDocumentSchema = z.object({
  documentId: z.string().min(1),
  title: z.string().optional(),
  revisionId: z.string().optional(),
});

/** Ответ batchUpdate Google Docs. */
export const googleBatchUpdateSchema = z.object({
  documentId: z.string().min(1),
  replies: z.array(z.unknown()).optional(),
});

/** Ответ append Google Sheets v4. */
export const googleSheetAppendSchema = z.object({
  spreadsheetId: z.string().min(1),
  tableRange: z.string().optional(),
  updates: z
    .object({
      spreadsheetId: z.string().optional(),
      updatedRange: z.string().optional(),
      updatedRows: z.number().int().nonnegative().optional(),
      updatedColumns: z.number().int().nonnegative().optional(),
      updatedCells: z.number().int().nonnegative().optional(),
    })
    .optional(),
});

/** Дата/время Google Calendar. */
export const googleCalendarDateTimeSchema = z.object({
  dateTime: z.string().optional(),
  date: z.string().optional(),
  timeZone: z.string().optional(),
});

/** Ответ создания события Google Calendar. */
export const googleCalendarEventSchema = z.object({
  id: z.string().min(1),
  htmlLink: z.string().optional(),
  status: z.string().optional(),
  summary: z.string().optional(),
  start: googleCalendarDateTimeSchema.optional(),
  end: googleCalendarDateTimeSchema.optional(),
});

/** Код ошибки OAuth (`invalid_grant` и т.п.). */
export const googleOAuthErrorSchema = z.object({
  error: z.string(),
  error_description: z.string().optional(),
});

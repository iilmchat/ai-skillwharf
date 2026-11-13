import * as Sentry from '@sentry/nestjs';
import type { Breadcrumb, ErrorEvent } from '@sentry/nestjs';

const REDACTED = '[REDACTED]';

const SECRET_PATTERNS: ReadonlyArray<[RegExp, string]> = [
  [/Bearer\s+[A-Za-z0-9\-._~+/]+=*/gi, `Bearer ${REDACTED}`],
  [/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, REDACTED],
  [/\bgh[pousr]_[A-Za-z0-9]{20,}\b/g, REDACTED],
  [/\bsk-[A-Za-z0-9_-]{20,}\b/g, REDACTED],
  [/\bAKIA[0-9A-Z]{16}\b/g, REDACTED],
  [
    /((?:api[_-]?key|access[_-]?token|refresh[_-]?token|access[_-]?key|token|secret|password|authorization)\s*[:=]\s*)(?!\[REDACTED\]|Bearer\b)[^\s,;]+/gi,
    `$1${REDACTED}`,
  ],
];

/** Убирает токены/секреты из произвольной строки (сообщения, URL, breadcrumbs). */
export function sanitizeString(value: string): string {
  return SECRET_PATTERNS.reduce(
    (result, [pattern, replacement]) => result.replace(pattern, replacement),
    value,
  );
}

function sanitizeUnknown(value: unknown, depth = 0): unknown {
  if (depth > 4) {
    return '[Filtered]';
  }

  if (typeof value === 'string') {
    return sanitizeString(value);
  }

  if (Array.isArray(value)) {
    return value.map((item) => sanitizeUnknown(item, depth + 1));
  }

  if (typeof value === 'object' && value !== null) {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, item]) => [
        key,
        sanitizeUnknown(item, depth + 1),
      ]),
    );
  }

  return value;
}

function sanitizeUrl(url: string): string {
  const withoutQuery = url.split('?')[0] ?? url;
  return sanitizeString(withoutQuery);
}

/**
 * Финальная защита перед отправкой события в Sentry. Даже если интеграция
 * успела положить тело/заголовки, они удаляются; токены в тексте маскируются.
 */
export function sanitizeSentryEvent(event: ErrorEvent): ErrorEvent {
  if (event.request) {
    event.request.headers = {};
    event.request.cookies = undefined;
    event.request.data = undefined;
    event.request.query_string = undefined;

    if (event.request.url) {
      event.request.url = sanitizeUrl(event.request.url);
    }
  }

  event.user = undefined;
  event.contexts = undefined;
  event.extra = sanitizeUnknown(event.extra) as Record<string, unknown>;

  if (event.message) {
    event.message = sanitizeString(event.message);
  }

  if (event.transaction) {
    event.transaction = sanitizeString(event.transaction);
  }

  if (event.tags) {
    event.tags = sanitizeUnknown(event.tags) as Record<string, string>;
  }

  if (event.breadcrumbs) {
    event.breadcrumbs = event.breadcrumbs.map((breadcrumb) => ({
      ...breadcrumb,
      message: breadcrumb.message
        ? sanitizeString(breadcrumb.message)
        : breadcrumb.message,
      data: breadcrumb.data
        ? (sanitizeUnknown(breadcrumb.data) as Record<string, unknown>)
        : breadcrumb.data,
    }));
  }

  for (const exception of event.exception?.values ?? []) {
    if (exception.value) {
      exception.value = sanitizeString(exception.value);
    }

    for (const frame of exception.stacktrace?.frames ?? []) {
      delete frame.vars;
    }
  }

  return event;
}

/** Breadcrumbs тоже могут содержать URL с токенами или тела запросов. */
export function sanitizeBreadcrumb(breadcrumb: Breadcrumb): Breadcrumb {
  return {
    ...breadcrumb,
    message: breadcrumb.message
      ? sanitizeString(breadcrumb.message)
      : breadcrumb.message,
    data: breadcrumb.data
      ? (sanitizeUnknown(breadcrumb.data) as Record<string, unknown>)
      : breadcrumb.data,
  };
}

let sentryInitialized = false;

export function isSentryEnabled(): boolean {
  return sentryInitialized;
}

/**
 * Sentry включается только при наличии SENTRY_DSN. По умолчанию SDK не
 * регистрирует собственный OTel tracer provider, чтобы не конфликтовать с
 * @opentelemetry/sdk-node.
 */
export function initSentry(): boolean {
  const dsn = process.env.SENTRY_DSN?.trim();

  if (!dsn) {
    console.log('sentry: disabled (SENTRY_DSN is not set)');
    return false;
  }

  try {
    Sentry.init({
      dsn,
      environment: process.env.SENTRY_ENVIRONMENT?.trim() || 'development',
      release: process.env.SENTRY_RELEASE?.trim() || undefined,
      enableOpenTelemetrySetup: false,
      tracesSampleRate: 0,
      dataCollection: {
        userInfo: false,
        cookies: false,
        httpHeaders: false,
        httpBodies: [],
        urlQueryParams: false,
        graphQL: { document: false, variables: false },
        genAI: { inputs: false, outputs: false },
        mcp: { inputs: false, outputs: false },
        databaseQueryData: false,
        queues: false,
        stackFrameVariables: false,
      },
      beforeSend: sanitizeSentryEvent,
      beforeBreadcrumb: sanitizeBreadcrumb,
    });
  } catch (error) {
    console.error(
      `sentry: не удалось инициализировать: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    sentryInitialized = false;
    return false;
  }

  sentryInitialized = true;
  console.log('sentry: enabled');
  return true;
}

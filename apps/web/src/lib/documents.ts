import {
  isAxiosError,
  type AxiosProgressEvent,
  type AxiosRequestConfig,
} from 'axios';
import { z } from 'zod';
import { api } from './api';
import type { MessageTable } from './message-blocks';

/**
 * Контракт загрузки документов (Sprint 20).
 *
 * UI отправляет файл в `POST /api/v1/documents` как `multipart/form-data`
 * (поле `file`) и ждёт разобранный документ:
 *
 * ```json
 * {
 *   "id": "doc_1",
 *   "filename": "resume.pdf",
 *   "mimeType": "application/pdf",
 *   "size": 1024,
 *   "kind": "pdf",
 *   "text": "…",
 *   "tables": [{ "title": "Опыт", "columns": ["Год"], "rows": [["2024"]] }],
 *   "warnings": [],
 *   "createdAt": "2026-11-14T10:00:00.000Z"
 * }
 * ```
 *
 * Схема намеренно терпимая: парсер может отдать текст постранично
 * (`pages[].text`), таблицы без подписей колонок (`rows` + `page`) или не
 * прислать `kind` — UI нормализует ответ, чтобы карточки не ломались от
 * смены внутреннего формата OCR/PDF-парсера.
 */

/** Эндпоинт загрузки: единственное место, где задан путь. */
export const DOCUMENTS_ENDPOINT = '/documents';

/** Лимит файла совпадает с лимитом multipart на API — 15 МБ. */
export const MAX_DOCUMENT_BYTES = 15 * 1024 * 1024;

/** MIME-типы, которые принимает OCR/парсер. */
export const DOCUMENT_MIME_TYPES = [
  'application/pdf',
  'image/png',
  'image/jpeg',
  'image/webp',
] as const;

export type DocumentMimeType = (typeof DOCUMENT_MIME_TYPES)[number];

export type DocumentKind = 'pdf' | 'image';

/**
 * Расширения — резерв, если браузер не определил MIME (бывает на Windows
 * для PDF из «Проводника»): тип выводим из имени файла.
 */
const DOCUMENT_EXTENSIONS: Readonly<Record<string, DocumentMimeType>> = {
  '.pdf': 'application/pdf',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
};

/** Значение для `accept` у `<input type="file">`. */
export const DOCUMENT_ACCEPT = DOCUMENT_MIME_TYPES.join(',');

export interface DocumentFileMeta {
  name: string;
  size: number;
  type: string;
}

/**
 * Ключ i18n для ошибки загрузки. Компонент переводит его сам, поэтому
 * lib не зависит от react-i18next.
 */
export type DocumentErrorKey =
  | 'chat.upload.errors.type'
  | 'chat.upload.errors.size'
  | 'chat.upload.errors.empty'
  | 'chat.upload.errors.network'
  | 'chat.upload.errors.unavailable'
  | 'chat.upload.errors.tooLarge'
  | 'chat.upload.errors.unsupportedType'
  | 'chat.upload.errors.failed';

export type DocumentFileValidation =
  | { ok: true; mimeType: DocumentMimeType; kind: DocumentKind }
  | { ok: false; errorKey: DocumentErrorKey };

const documentFileMetaSchema = z.object({
  name: z.string().min(1),
  size: z.number().int().positive().max(MAX_DOCUMENT_BYTES),
  type: z.string(),
});

const isoDateTimeSchema = z
  .string()
  .refine((value) => !Number.isNaN(Date.parse(value)), {
    message: 'ожидается дата в формате ISO 8601',
  });

/** Таблица в ответе парсера: подписи колонок и страница необязательны. */
export const parsedDocumentTableSchema = z.object({
  title: z.string().optional(),
  page: z.number().int().nonnegative().optional(),
  columns: z.array(z.string()).optional(),
  rows: z.array(z.array(z.string())),
});

/** Сырой ответ `POST /documents` до нормализации. */
export const parsedDocumentSchema = z.object({
  id: z.string().min(1),
  filename: z.string().min(1),
  mimeType: z.string().min(1),
  size: z.number().int().nonnegative(),
  kind: z.enum(['pdf', 'image']).optional(),
  text: z.string().optional(),
  pages: z.array(z.object({ text: z.string() })).optional(),
  tables: z.array(parsedDocumentTableSchema).optional().default([]),
  warnings: z.array(z.string()).optional().default([]),
  /** Необязательное поле: старый API его не присылает. */
  createdAt: isoDateTimeSchema.optional(),
});

type ParsedDocumentWire = z.infer<typeof parsedDocumentSchema>;

/** Нормализованный документ, с которым работает UI. */
export interface ParsedDocument {
  id: string;
  filename: string;
  mimeType: string;
  size: number;
  kind: DocumentKind;
  text: string;
  tables: MessageTable[];
  warnings: string[];
  createdAt: string | null;
}

/** Заголовки без подписей: нейтральная нумерация колонок. */
function inferColumns(rows: string[][]): string[] {
  const width = rows[0]?.length ?? 0;

  return Array.from({ length: width }, (_, index) => String(index + 1));
}

function toMessageTable(
  table: z.infer<typeof parsedDocumentTableSchema>,
): MessageTable {
  return {
    columns: table.columns ?? inferColumns(table.rows),
    rows: table.rows,
    ...(table.title === undefined ? {} : { title: table.title }),
  };
}

function toDocumentKind(wire: ParsedDocumentWire): DocumentKind {
  if (wire.kind !== undefined) {
    return wire.kind;
  }

  return wire.mimeType === 'application/pdf' ? 'pdf' : 'image';
}

/** Сводит терпимую схему к нормализованному документу. */
export function normalizeParsedDocument(data: unknown): ParsedDocument {
  const wire = parsedDocumentSchema.parse(data);
  const pagedText = (wire.pages ?? []).map((page) => page.text).join('\n\n');
  const text =
    wire.text !== undefined && wire.text !== '' ? wire.text : pagedText;

  return {
    id: wire.id,
    filename: wire.filename,
    mimeType: wire.mimeType,
    size: wire.size,
    kind: toDocumentKind(wire),
    text,
    tables: wire.tables.map(toMessageTable),
    warnings: wire.warnings,
    createdAt: wire.createdAt ?? null,
  };
}

/** MIME-тип файла: сначала по типу от браузера, затем по расширению. */
export function resolveDocumentMimeType(
  name: string,
  type: string,
): DocumentMimeType | null {
  const normalized = type.trim().toLowerCase();

  for (const known of DOCUMENT_MIME_TYPES) {
    if (known === normalized) {
      return known;
    }
  }

  const dotIndex = name.lastIndexOf('.');

  if (dotIndex < 0) {
    return null;
  }

  const extension = name.slice(dotIndex).toLowerCase();

  return DOCUMENT_EXTENSIONS[extension] ?? null;
}

function toKind(mimeType: DocumentMimeType): DocumentKind {
  return mimeType === 'application/pdf' ? 'pdf' : 'image';
}

/**
 * Проверяет файл до отправки. Zod-схема отсекает пустые и слишком большие
 * файлы, MIME — тип, который парсер не умеет разбирать.
 */
export function validateDocumentFile(
  meta: DocumentFileMeta,
): DocumentFileValidation {
  const parsed = documentFileMetaSchema.safeParse(meta);

  if (!parsed.success) {
    const tooLarge = meta.size > MAX_DOCUMENT_BYTES;

    return {
      ok: false,
      errorKey: tooLarge
        ? 'chat.upload.errors.size'
        : 'chat.upload.errors.empty',
    };
  }

  const mimeType = resolveDocumentMimeType(parsed.data.name, parsed.data.type);

  if (mimeType === null) {
    return { ok: false, errorKey: 'chat.upload.errors.type' };
  }

  return { ok: true, mimeType, kind: toKind(mimeType) };
}

/**
 * Процент загрузки для прогресс-бара.
 *
 * `null` — браузер не сообщил размер (chunked upload): показываем
 * неопределённый прогресс. Значение не доходит до 100 раньше ответа
 * сервера: округление вниз, поэтому 100% ставит успешное завершение.
 */
export function uploadProgressPercent(
  loaded: number,
  total: number | undefined,
): number | null {
  if (total === undefined || total <= 0) {
    return null;
  }

  const percent = Math.floor((loaded / total) * 100);

  return Math.min(100, Math.max(0, percent));
}

export type DocumentErrorKind =
  'unavailable' | 'tooLarge' | 'unsupportedType' | 'network' | 'failed';

/** Коды ошибок API, которые относятся к загрузке документа. */
const DOCUMENT_ERROR_CODES: Readonly<Record<string, DocumentErrorKind>> = {
  'errors.document_too_large': 'tooLarge',
  'errors.unsupported_document_type': 'unsupportedType',
  'errors.documents_unavailable': 'unavailable',
};

export const DOCUMENT_ERROR_KEYS: Readonly<
  Record<DocumentErrorKind, DocumentErrorKey>
> = {
  unavailable: 'chat.upload.errors.unavailable',
  tooLarge: 'chat.upload.errors.tooLarge',
  unsupportedType: 'chat.upload.errors.unsupportedType',
  network: 'chat.upload.errors.network',
  failed: 'chat.upload.errors.failed',
};

function readErrorCode(data: unknown): string | null {
  if (typeof data !== 'object' || data === null || !('code' in data)) {
    return null;
  }

  const { code } = data;

  return typeof code === 'string' ? code : null;
}

/**
 * Категория ошибки загрузки.
 *
 * 404/405/501 — эндпоинта ещё нет в выкаченном API: UI показывает
 * «недоступно», а не общую ошибку сети.
 */
export function classifyDocumentError(error: unknown): DocumentErrorKind {
  if (!isAxiosError(error)) {
    return 'failed';
  }

  if (error.response === undefined) {
    return 'network';
  }

  const code = readErrorCode(error.response.data);

  if (code !== null) {
    const known = DOCUMENT_ERROR_CODES[code];

    if (known !== undefined) {
      return known;
    }
  }

  switch (error.response.status) {
    case 404:
    case 405:
    case 501:
      return 'unavailable';
    case 413:
      return 'tooLarge';
    case 415:
      return 'unsupportedType';
    default:
      return 'failed';
  }
}

export interface UploadDocumentOptions {
  onProgress?: (percent: number | null) => void;
  signal?: AbortSignal;
}

/**
 * Отправляет документ на разбор.
 *
 * Прогресс отдаётся через `onUploadProgress` axios; `AbortSignal`
 * позволяет отменить загрузку при закрытии панели.
 */
export async function uploadDocument(
  file: File,
  options: UploadDocumentOptions = {},
): Promise<ParsedDocument> {
  const formData = new FormData();
  formData.append('file', file, file.name);

  const requestConfig: AxiosRequestConfig = {
    headers: { 'Content-Type': 'multipart/form-data' },
    onUploadProgress: (event: AxiosProgressEvent) => {
      options.onProgress?.(uploadProgressPercent(event.loaded, event.total));
    },
  };

  if (options.signal !== undefined) {
    requestConfig.signal = options.signal;
  }

  const { data } = await api.post<unknown>(
    DOCUMENTS_ENDPOINT,
    formData,
    requestConfig,
  );

  return normalizeParsedDocument(data);
}

/** Таблица в «pipe»-разметке — её понимает и чат, и агент. */
function tableToMarkdown(table: MessageTable): string {
  const header = `| ${table.columns.join(' | ')} |`;
  const separator = `| ${table.columns.map(() => '---').join(' | ')} |`;
  const rows = table.rows.map((row) => `| ${row.join(' | ')} |`);
  const lines = [header, separator, ...rows];
  const title =
    table.title === undefined || table.title.trim() === ''
      ? ''
      : `${table.title.trim()}\n`;

  return `${title}${lines.join('\n')}`;
}

/**
 * Текст для отправки в чат: извлечённый текст плюс таблицы в Markdown.
 * Пустой документ даёт пустую строку — кнопка «Отправить» станет неактивной.
 */
export function documentToChatText(document: ParsedDocument): string {
  const parts: string[] = [];
  const text = document.text.trim();

  if (text !== '') {
    parts.push(text);
  }

  for (const table of document.tables) {
    parts.push(tableToMarkdown(table));
  }

  return parts.join('\n\n');
}

/** Единицы размера файла; страница подставляет их из i18n. */
export interface DocumentSizeUnits {
  byte: string;
  kilobyte: string;
  megabyte: string;
}

/** Русские единицы по умолчанию — для мест без i18n-контекста. */
export const DEFAULT_DOCUMENT_SIZE_UNITS: DocumentSizeUnits = {
  byte: 'Б',
  kilobyte: 'КБ',
  megabyte: 'МБ',
};

/** Человекочитаемый размер файла для подписи под результатом. */
export function formatDocumentSize(
  bytes: number,
  units: DocumentSizeUnits = DEFAULT_DOCUMENT_SIZE_UNITS,
): string {
  if (bytes < 1024) {
    return `${bytes} ${units.byte}`;
  }

  const kilobytes = bytes / 1024;

  if (kilobytes < 1024) {
    return `${Math.round(kilobytes)} ${units.kilobyte}`;
  }

  return `${(kilobytes / 1024).toFixed(1)} ${units.megabyte}`;
}

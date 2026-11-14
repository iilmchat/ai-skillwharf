import { Injectable, Logger } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import {
  documentTooLargeError,
  invalidRequestError,
  unsupportedDocumentTypeError,
} from '../common/api-error.js';
import { extractPdfText } from '../agent/documents/pdf-text.js';
import { OcrSmartEngineService } from '../agent/documents/ocr-smart-engine.service.js';

/**
 * Разбор загруженного документа для UI.
 *
 * Контракт совпадает с `apps/web/src/lib/documents.ts`: UI отправляет файл в
 * `POST /documents` и ждёт `{ id, filename, mimeType, size, kind, text,
 * tables, warnings, createdAt }`. Парсинг серверный: PDF разбирается
 * `pdf-text`, сканы распознаёт `ocr-smart-engine` (SDE либо Tesseract).
 *
 * Ответ терпимый к формату парсера: `text` — плоский текст, `tables` —
 * постраничные таблицы без подписей колонок (UI нумерует их сам).
 */

/** Файл, который отдаёт multer (memory storage). */
export interface UploadedDocumentFile {
  readonly originalname: string;
  readonly mimetype: string;
  readonly size: number;
  readonly buffer: Buffer;
}

/** Лимит размера файла: совпадает с клиентским (15 МБ). */
export const MAX_UPLOAD_BYTES = 15 * 1024 * 1024;

/** MIME-типы, которые умеет разбирать API. */
export const SUPPORTED_UPLOAD_MIME_TYPES = [
  'application/pdf',
  'image/png',
  'image/jpeg',
  'image/webp',
] as const;

export type UploadMimeType = (typeof SUPPORTED_UPLOAD_MIME_TYPES)[number];

/** Вид документа в ответе UI. */
export type UploadedDocumentKind = 'pdf' | 'image';

/** Таблица документа в ответе UI. */
export interface DocumentTable {
  readonly page: number;
  readonly rows: readonly (readonly string[])[];
}

/** Ответ `POST /documents`. */
export interface ParsedDocumentResponse {
  readonly id: string;
  readonly filename: string;
  readonly mimeType: string;
  readonly size: number;
  readonly kind: UploadedDocumentKind;
  readonly text: string;
  readonly tables: readonly DocumentTable[];
  readonly warnings: readonly string[];
  readonly createdAt: string;
}

@Injectable()
export class DocumentsService {
  private readonly logger = new Logger(DocumentsService.name);

  constructor(private readonly ocr: OcrSmartEngineService) {}

  /**
   * Разбирает загруженный файл.
   *
   * @throws ApiException 400 (пустой/битый файл), 413 (размер), 415 (тип)
   */
  async parse(file: UploadedDocumentFile): Promise<ParsedDocumentResponse> {
    const mimeType = file.mimetype.trim().toLowerCase();
    const filename = file.originalname.trim() || 'document';
    const size = file.buffer.length;

    if (size === 0) {
      throw invalidRequestError('Файл пуст');
    }

    if (size > MAX_UPLOAD_BYTES) {
      throw documentTooLargeError(
        `Файл больше ${Math.floor(MAX_UPLOAD_BYTES / 1024 / 1024)} МБ`,
      );
    }

    if (!isSupportedMimeType(mimeType)) {
      throw unsupportedDocumentTypeError(
        `Тип ${mimeType === '' ? 'не указан' : mimeType} не поддержан: PDF, PNG, JPEG или WebP`,
      );
    }

    this.logger.log(
      JSON.stringify({
        event: 'documents.upload',
        filename,
        mimeType,
        size,
      }),
    );

    let parsed: {
      text: string;
      tables: readonly DocumentTable[];
      warnings: readonly string[];
    };
    let kind: UploadedDocumentKind;

    if (mimeType === 'application/pdf') {
      parsed = parsePdf(file.buffer);
      kind = 'pdf';
    } else {
      parsed = await this.parseImage(file.buffer, mimeType);
      kind = 'image';
    }

    return {
      id: randomUUID(),
      filename,
      mimeType,
      size,
      kind,
      text: parsed.text,
      tables: parsed.tables,
      warnings: parsed.warnings,
      createdAt: new Date().toISOString(),
    };
  }

  /** Скан/фото: текст распознаёт OCR-сервис. */
  private async parseImage(
    buffer: Buffer,
    mimeType: Exclude<UploadMimeType, 'application/pdf'>,
  ): Promise<{
    text: string;
    tables: readonly DocumentTable[];
    warnings: readonly string[];
  }> {
    const result = await this.ocr.recognize({
      imageBase64: buffer.toString('base64'),
      mimeType,
    });

    return { text: result.text, tables: [], warnings: result.warnings };
  }
}

/** Поддержан ли MIME-тип. */
export function isSupportedMimeType(mime: string): mime is UploadMimeType {
  return (SUPPORTED_UPLOAD_MIME_TYPES as readonly string[]).includes(mime);
}

/** PDF: текст и таблицы; битый файл — 400. */
function parsePdf(buffer: Buffer): {
  text: string;
  tables: readonly DocumentTable[];
  warnings: readonly string[];
} {
  let extraction;

  try {
    extraction = extractPdfText(buffer);
  } catch (error) {
    throw invalidRequestError(
      `PDF: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  return {
    text: extraction.pages.map((page) => page.text).join('\n\n'),
    tables: extraction.tables.map((table) => ({
      page: table.page,
      rows: table.rows,
    })),
    warnings: extraction.warnings,
  };
}

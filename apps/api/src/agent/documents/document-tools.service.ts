import { Injectable, Logger } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { extname, join, resolve, sep } from 'node:path';
import { z } from 'zod';
import { invalidRequestError } from '../../common/api-error.js';
import { extractDocumentFields } from './document-fields.js';
import {
  ExtractDocumentDataToolSchema,
  ExtractPdfToolSchema,
  OcrDocumentToolSchema,
  WriteDocxToolSchema,
  type ExtractDocumentDataToolArgs,
  type ExtractPdfToolArgs,
  type OcrDocumentToolArgs,
  type WriteDocxToolArgs,
} from './document-tools.schemas.js';
import { buildDocx } from './docx-builder.js';
import { readDocxText } from './docx-reader.js';
import { OcrSmartEngineService, type OcrMimeType } from './ocr-smart-engine.service.js';
import { extractPdfText } from './pdf-text.js';

/**
 * Инструменты документов: `extract_pdf`, `write_docx`, `ocr_document` и
 * `extract_document_data`.
 *
 * Инструменты не ходят в интернет «вслепую»: файлы берутся из каталога
 * `DOCUMENTS_INPUT_DIR` (путь проверяется на выход за пределы каталога и на
 * размер), результат `write_docx` пишется в `DOCUMENTS_OUTPUT_DIR`. Текст
 * обрезается до `DOCUMENTS_MAX_TEXT_CHARS`, чтобы ответ инструмента не
 * раздувал контекст модели.
 */

/** Конфигурация документов из окружения. */
export interface DocumentsConfig {
  readonly inputDir: string;
  readonly outputDir: string;
  readonly maxBytes: number;
  readonly maxPages: number;
  readonly maxTextChars: number;
}

/** Конфигурация по умолчанию. */
export function readDocumentsConfig(
  env: NodeJS.ProcessEnv = process.env,
): DocumentsConfig {
  return {
    inputDir: env.DOCUMENTS_INPUT_DIR?.trim() || './documents',
    outputDir: env.DOCUMENTS_OUTPUT_DIR?.trim() || './docx-output',
    maxBytes: readPositiveInt(env.DOCUMENTS_MAX_BYTES, 10 * 1024 * 1024),
    maxPages: readPositiveInt(env.DOCUMENTS_MAX_PAGES, 50),
    maxTextChars: readPositiveInt(env.DOCUMENTS_MAX_TEXT_CHARS, 100_000),
  };
}

/**
 * Проверяет, что путь относительный и остаётся внутри каталога документов.
 *
 * @throws ApiException 400 на абсолютный путь, `..` или выход за каталог
 */
export function resolveDocumentPath(baseDir: string, rawPath: string): string {
  const normalized = rawPath.replace(/\\/g, '/').trim();

  if (normalized === '' || normalized.startsWith('/') || /^[A-Za-z]:/.test(normalized)) {
    throw invalidRequestError(
      'Путь к документу должен быть относительным (например, contract.pdf)',
    );
  }

  if (normalized.split('/').some((segment) => segment === '..' || segment === '.' || segment === '')) {
    throw invalidRequestError('Путь к документу не должен содержать «..» или пустые сегменты');
  }

  const base = resolve(baseDir);
  const full = resolve(base, normalized);

  if (full !== base && !full.startsWith(`${base}${sep}`)) {
    throw invalidRequestError('Путь к документу выходит за пределы каталога документов');
  }

  return full;
}

/** MIME-тип изображения по расширению файла. */
export function mimeTypeFromPath(path: string): OcrMimeType | null {
  switch (extname(path).toLowerCase()) {
    case '.png':
      return 'image/png';
    case '.jpg':
    case '.jpeg':
      return 'image/jpeg';
    case '.tif':
    case '.tiff':
      return 'image/tiff';
    case '.bmp':
      return 'image/bmp';
    case '.webp':
      return 'image/webp';
    default:
      return null;
  }
}

@Injectable()
export class DocumentToolsService {
  private readonly logger = new Logger(DocumentToolsService.name);

  constructor(private readonly ocr: OcrSmartEngineService) {}

  /** `extract_pdf`: текст и таблицы PDF. */
  async extractPdf(rawArgs: unknown): Promise<string> {
    const args = ExtractPdfToolSchema.parse(rawArgs) as ExtractPdfToolArgs;
    const config = readDocumentsConfig();
    const source =
      args.path !== undefined
        ? await this.readSource(args.path, config)
        : this.inlineSource(args.pdfBase64 ?? '');

    let extraction;

    try {
      extraction = extractPdfText(source.buffer, {
        maxPages: args.maxPages ?? config.maxPages,
      });
    } catch (error) {
      throw invalidRequestError(
        `PDF: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    const text = truncateText(
      extraction.pages.map((page) => page.text).join('\n\n'),
      config.maxTextChars,
    );

    return JSON.stringify({
      tool: 'pdf-extractor',
      source: { kind: source.kind, label: source.label, bytes: source.buffer.length },
      pageCount: extraction.pageCount,
      pages: extraction.pages.map((page) => ({
        page: page.page,
        text: truncateText(page.text, config.maxTextChars),
      })),
      text: text.value,
      tables: extraction.tables,
      metadata: extraction.metadata,
      warnings: [...extraction.warnings, ...text.warnings],
    });
  }

  /** `write_docx`: реальный DOCX на диске. */
  async writeDocx(rawArgs: unknown): Promise<string> {
    const args = WriteDocxToolSchema.parse(rawArgs) as WriteDocxToolArgs;
    const config = readDocumentsConfig();
    const fileName = args.filename ?? `docx-${randomUUID()}.docx`;

    if (!/^[A-Za-z0-9._-]+\.docx$/i.test(fileName)) {
      throw invalidRequestError(
        'Имя файла должно содержать только буквы, цифры, точку, дефис и заканчиваться .docx',
      );
    }

    const buffer = buildDocx({
      title: args.title,
      ...(args.subtitle === undefined ? {} : { subtitle: args.subtitle }),
      blocks: args.blocks,
    });
    const hostPath = join(config.outputDir, fileName);

    await mkdir(config.outputDir, { recursive: true });
    await writeFile(hostPath, buffer);

    this.logger.log(
      JSON.stringify({
        event: 'docx.written',
        path: hostPath,
        bytes: buffer.length,
      }),
    );

    return JSON.stringify({
      tool: 'docx-writer',
      path: hostPath,
      bytes: buffer.length,
      blocks: args.blocks.length,
      tables: args.blocks.filter((block) => block.type === 'table').length,
    });
  }

  /** `ocr_document`: распознавание скана через SDE/Tesseract. */
  async ocrDocument(rawArgs: unknown): Promise<string> {
    const args = OcrDocumentToolSchema.parse(rawArgs) as OcrDocumentToolArgs;
    const config = readDocumentsConfig();
    const mimeType =
      args.mimeType ??
      (args.path === undefined ? null : mimeTypeFromPath(args.path));

    if (mimeType === null) {
      throw invalidRequestError(
        'Не удалось определить MIME-тип изображения: укажите mimeType',
      );
    }

    const source =
      args.path !== undefined
        ? await this.readSource(args.path, config)
        : this.inlineSource(args.imageBase64 ?? '');

    const result = await this.ocr.recognize({
      imageBase64: source.buffer.toString('base64'),
      mimeType,
      ...(args.language === undefined ? {} : { language: args.language }),
    });
    const text = truncateText(result.text, config.maxTextChars);

    return JSON.stringify({
      tool: 'ocr-smart-engine',
      source: { kind: source.kind, label: source.label, bytes: source.buffer.length },
      engine: result.engine,
      language: result.language,
      text: text.value,
      warnings: [...result.warnings, ...text.warnings],
    });
  }

  /** `extract_document_data`: реквизиты договора из текста или файла. */
  async extractDocumentData(rawArgs: unknown): Promise<string> {
    const args = ExtractDocumentDataToolSchema.parse(
      rawArgs,
    ) as ExtractDocumentDataToolArgs;
    const config = readDocumentsConfig();
    const loaded =
      args.documentText !== undefined
        ? { text: args.documentText, label: 'inline:text', kind: 'inline' as const }
        : await this.loadDocumentText(args.path ?? '', config);
    const fields = extractDocumentFields(loaded.text);
    const dataAvailable =
      fields.contractNumber !== null ||
      fields.primaryAmount !== null ||
      fields.primaryDate !== null ||
      fields.parties.length > 0;

    return JSON.stringify({
      tool: 'document-analyzer',
      source: { kind: loaded.kind, label: loaded.label },
      dataAvailable,
      textLength: loaded.text.length,
      ...fields,
    });
  }

  /** Читает файл документа с проверками пути и размера. */
  async readSource(
    rawPath: string,
    config: DocumentsConfig,
  ): Promise<{ buffer: Buffer; label: string; kind: 'path' }> {
    const fullPath = resolveDocumentPath(config.inputDir, rawPath);
    let stats;

    try {
      stats = await stat(fullPath);
    } catch {
      throw invalidRequestError(`Документ не найден: ${rawPath}`);
    }

    if (!stats.isFile()) {
      throw invalidRequestError(`Путь не является файлом: ${rawPath}`);
    }

    if (stats.size > config.maxBytes) {
      throw invalidRequestError(
        `Файл больше ${Math.floor(config.maxBytes / 1024)} КиБ: ${rawPath}`,
      );
    }

    return {
      buffer: await readFile(fullPath),
      label: rawPath,
      kind: 'path',
    };
  }

  /** Текст документа по расширению: PDF, DOCX, TXT/MD или скан (OCR). */
  private async loadDocumentText(
    rawPath: string,
    config: DocumentsConfig,
  ): Promise<{ text: string; label: string; kind: 'path' }> {
    const source = await this.readSource(rawPath, config);
    const extension = extname(rawPath).toLowerCase();

    switch (extension) {
      case '.pdf': {
        let extraction;

        try {
          extraction = extractPdfText(source.buffer, {
            maxPages: config.maxPages,
          });
        } catch (error) {
          throw invalidRequestError(
            `PDF: ${error instanceof Error ? error.message : String(error)}`,
          );
        }

        return {
          text: truncateText(
            extraction.pages.map((page) => page.text).join('\n\n'),
            config.maxTextChars,
          ).value,
          label: source.label,
          kind: source.kind,
        };
      }

      case '.docx': {
        try {
          return {
            text: readDocxText(source.buffer),
            label: source.label,
            kind: source.kind,
          };
        } catch (error) {
          throw invalidRequestError(
            `DOCX: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }

      case '.txt':
      case '.md':
        return {
          text: truncateText(source.buffer.toString('utf8'), config.maxTextChars)
            .value,
          label: source.label,
          kind: source.kind,
        };

      default: {
        const mimeType = mimeTypeFromPath(rawPath);

        if (mimeType === null) {
          throw invalidRequestError(
            `Формат ${extension || 'без расширения'} не поддержан: PDF, DOCX, TXT/MD или скан`,
          );
        }

        const recognized = await this.ocr.recognize({
          imageBase64: source.buffer.toString('base64'),
          mimeType,
        });

        return {
          text: truncateText(recognized.text, config.maxTextChars).value,
          label: source.label,
          kind: source.kind,
        };
      }
    }
  }

  /** Inline-base64 как источник: проверяем, что это действительно данные. */
  private inlineSource(base64: string): {
    buffer: Buffer;
    label: string;
    kind: 'inline';
  } {
    const trimmed = base64.trim();

    if (trimmed === '' || !/^[A-Za-z0-9+/]+={0,2}$/.test(trimmed)) {
      throw invalidRequestError('Содержимое документа должно быть в base64');
    }

    return {
      buffer: Buffer.from(trimmed, 'base64'),
      label: 'inline',
      kind: 'inline',
    };
  }
}

/** Обрезает текст и предупреждает о потере хвоста. */
function truncateText(
  text: string,
  maxChars: number,
): { value: string; warnings: string[] } {
  if (text.length <= maxChars) {
    return { value: text, warnings: [] };
  }

  return {
    value: text.slice(0, maxChars),
    warnings: [
      `текст обрезан до ${maxChars} символов (было ${text.length})`,
    ],
  };
}

function readPositiveInt(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value ?? '', 10);

  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

/** Схема ответа `write_docx` для проверки контракта в тестах. */
export const DocxWriteResponseSchema = z.object({
  tool: z.literal('docx-writer'),
  path: z.string().min(1),
  bytes: z.number().int().positive(),
  blocks: z.number().int().nonnegative(),
  tables: z.number().int().nonnegative(),
});

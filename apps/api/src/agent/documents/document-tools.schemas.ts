import { z } from 'zod';

/**
 * Zod-схемы аргументов document-инструментов.
 *
 * Один источник истины: их используют и реестр инструментов для LLM
 * (`tool-schemas.ts`), и политики Agent Gateway (`tool-policies.ts`), и
 * сервис при разборе `execute`.
 */

/** Максимальный размер входящего документа в base64 (≈ 9 МБ файла). */
export const MAX_INLINE_BASE64 = 12_000_000;

/** Строка табуляции/URL файла: относительный путь внутри `DOCUMENTS_INPUT_DIR`. */
const relativePath = z.string().min(1).max(512);

/** Источник документа: ровно один из `path` или inline-base64. */
const documentSource = {
  path: relativePath.optional().describe(
    'Путь к файлу внутри каталога документов (например, contract.pdf)',
  ),
};

/** `extract_pdf`: текст и таблицы из PDF. */
export const ExtractPdfToolSchema = z
  .object({
    ...documentSource,
    pdfBase64: z
      .string()
      .min(1)
      .max(MAX_INLINE_BASE64)
      .optional()
      .describe('Содержимое PDF в base64 (альтернатива path)'),
    maxPages: z
      .number()
      .int()
      .positive()
      .max(500)
      .optional()
      .describe('Сколько страниц разбирать (по умолчанию 50)'),
  })
  .strict()
  .refine(
    (value) =>
      (value.path === undefined) !== (value.pdfBase64 === undefined),
    'нужен ровно один источник: path или pdfBase64',
  );

/** Блок тела DOCX. */
export const DocxBlockSchema = z.discriminatedUnion('type', [
  z
    .object({
      type: z.literal('heading'),
      text: z.string().min(1).max(500),
      level: z.union([z.literal(1), z.literal(2), z.literal(3)]).optional(),
    })
    .strict(),
  z.object({ type: z.literal('paragraph'), text: z.string().min(1).max(20_000) }).strict(),
  z
    .object({
      type: z.literal('bullets'),
      items: z.array(z.string().min(1).max(2_000)).min(1).max(100),
    })
    .strict(),
  z
    .object({
      type: z.literal('table'),
      headers: z.array(z.string().max(500)).max(50).optional(),
      rows: z
        .array(z.array(z.string().max(2_000)).max(50))
        .min(1)
        .max(500),
    })
    .strict(),
]);

/** `write_docx`: генерация отчёта в Word. */
export const WriteDocxToolSchema = z
  .object({
    title: z.string().min(1).max(300).describe('Заголовок документа'),
    subtitle: z.string().max(500).optional().describe('Подзаголовок'),
    blocks: z.array(DocxBlockSchema).min(1).max(200).describe('Тело документа'),
    filename: z
      .string()
      .min(1)
      .max(120)
      .optional()
      .describe('Имя файла без пути, например report.docx'),
  })
  .strict();

/** MIME-типы OCR (повторяют контракт сервиса). */
export const OcrMimeSchema = z.enum([
  'image/png',
  'image/jpeg',
  'image/jpg',
  'image/tiff',
  'image/bmp',
  'image/webp',
]);

/** `ocr_document`: распознавание скана. */
export const OcrDocumentToolSchema = z
  .object({
    path: relativePath.optional().describe(
      'Путь к изображению внутри каталога документов',
    ),
    imageBase64: z
      .string()
      .min(1)
      .max(MAX_INLINE_BASE64)
      .optional()
      .describe('Содержимое изображения в base64'),
    mimeType: OcrMimeSchema.optional().describe(
      'MIME-тип; по умолчанию определяется по расширению файла',
    ),
    language: z
      .string()
      .min(1)
      .max(64)
      .optional()
      .describe('Языки распознавания, например ru или rus+eng'),
  })
  .strict()
  .refine(
    (value) =>
      (value.path === undefined) !== (value.imageBase64 === undefined),
    'нужен ровно один источник: path или imageBase64',
  );

/** `extract_document_data`: реквизиты договора. */
export const ExtractDocumentDataToolSchema = z
  .object({
    documentText: z
      .string()
      .min(1)
      .max(100_000)
      .optional()
      .describe('Текст документа'),
    path: relativePath.optional().describe(
      'Файл внутри каталога документов: PDF, DOCX, TXT/MD или скан',
    ),
  })
  .strict()
  .refine(
    (value) =>
      (value.documentText === undefined) !== (value.path === undefined),
    'нужен ровно один источник: documentText или path',
  );

export type ExtractPdfToolArgs = z.infer<typeof ExtractPdfToolSchema>;
export type WriteDocxToolArgs = z.infer<typeof WriteDocxToolSchema>;
export type OcrDocumentToolArgs = z.infer<typeof OcrDocumentToolSchema>;
export type ExtractDocumentDataToolArgs = z.infer<
  typeof ExtractDocumentDataToolSchema
>;

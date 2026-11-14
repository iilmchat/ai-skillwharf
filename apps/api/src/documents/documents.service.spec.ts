import { describe, expect, it, vi } from 'vitest';
import { ApiException } from '../common/api-error.js';
import { ERROR_KEYS } from '../i18n/error-keys.js';
import type { OcrSmartEngineService } from '../agent/documents/ocr-smart-engine.service.js';
import {
  DocumentsService,
  MAX_UPLOAD_BYTES,
  isSupportedMimeType,
  type UploadedDocumentFile,
} from './documents.service.js';

/** Минимальный валидный PDF с одной страницей текста. */
function simplePdf(text: string): Buffer {
  const content = `BT /F1 12 Tf 72 700 Td (${text}) Tj ET`;
  const parts = [
    '%PDF-1.7\n',
    '1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n',
    '2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n',
    '3 0 obj\n<< /Type /Page /Parent 2 0 R /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>\nendobj\n',
    '4 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>\nendobj\n',
    `5 0 obj\n<< /Length ${content.length} >>\nstream\n${content}\nendstream\nendobj\n`,
    'trailer\n<< /Root 1 0 R >>\n%%EOF\n',
  ];

  return Buffer.from(parts.join(''), 'latin1');
}

/** Файл, каким его отдаёт multer. */
function file(
  buffer: Buffer,
  mimetype = 'application/pdf',
  originalname = 'doc.pdf',
): UploadedDocumentFile {
  return { originalname, mimetype, size: buffer.length, buffer };
}

const recognize = vi.fn(async () => ({
  text: 'Распознанный скан',
  engine: 'tesseract' as const,
  language: 'rus+eng',
  warnings: [] as string[],
}));

const service = new DocumentsService({
  recognize,
} as unknown as OcrSmartEngineService);

describe('isSupportedMimeType', () => {
  it('пропускает PDF и изображения', () => {
    expect(isSupportedMimeType('application/pdf')).toBe(true);
    expect(isSupportedMimeType('image/png')).toBe(true);
    expect(isSupportedMimeType('image/webp')).toBe(true);
  });

  it('отклоняет остальные типы', () => {
    expect(isSupportedMimeType('text/plain')).toBe(false);
    expect(isSupportedMimeType('application/msword')).toBe(false);
    expect(isSupportedMimeType('')).toBe(false);
  });
});

describe('DocumentsService: PDF', () => {
  it('возвращает контракт UI с текстом и метаданными', async () => {
    const result = await service.parse(file(simplePdf('Contract 2026')));

    expect(result).toMatchObject({
      filename: 'doc.pdf',
      mimeType: 'application/pdf',
      kind: 'pdf',
      text: 'Contract 2026',
      tables: [],
      warnings: [],
    });
    expect(result.id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
    expect(Number.isNaN(Date.parse(result.createdAt))).toBe(false);
    expect(recognize).not.toHaveBeenCalled();
  });

  it('отдаёт таблицы постранично', async () => {
    const content = [
      'BT /F1 10 Tf 1 0 0 1 72 700 Tm (Item) Tj ET',
      'BT /F1 10 Tf 1 0 0 1 250 700 Tm (Price) Tj ET',
      'BT /F1 10 Tf 1 0 0 1 72 680 Tm (Work) Tj ET',
      'BT /F1 10 Tf 1 0 0 1 250 680 Tm (1500) Tj ET',
    ].join('\n');
    const pdfBody = Buffer.from(
      `%PDF-1.7
1 0 obj
<< /Type /Catalog /Pages 2 0 R >>
endobj
2 0 obj
<< /Type /Pages /Kids [3 0 R] /Count 1 >>
endobj
3 0 obj
<< /Type /Page /Parent 2 0 R /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>
endobj
4 0 obj
<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>
endobj
5 0 obj
<< /Length ${content.length} >>
stream
${content}
endstream
endobj
trailer
<< /Root 1 0 R >>
%%EOF
`,
      'latin1',
    );

    const result = await service.parse(file(pdfBody));

    expect(result.tables).toEqual([
      { page: 1, rows: [['Item', 'Price'], ['Work', '1500']] },
    ]);
  });
});

describe('DocumentsService: изображения', () => {
  it('распознаёт скан через OCR', async () => {
    const result = await service.parse(
      file(Buffer.from([0x89, 0x50, 0x4e, 0x47]), 'image/png', 'scan.png'),
    );

    expect(result).toMatchObject({
      filename: 'scan.png',
      mimeType: 'image/png',
      kind: 'image',
      text: 'Распознанный скан',
      tables: [],
    });
    expect(recognize).toHaveBeenCalledWith({
      imageBase64: expect.any(String),
      mimeType: 'image/png',
    });
  });
});

describe('DocumentsService: валидация', () => {
  it('отклоняет пустой файл (400)', async () => {
    const error: unknown = await service
      .parse(file(Buffer.alloc(0)))
      .catch((caught: unknown) => caught);

    expect((error as ApiException).getResponse()).toMatchObject({
      statusCode: 400,
      code: ERROR_KEYS.invalidRequest,
    });
  });

  it('отклоняет файл больше 15 МБ (413)', async () => {
    const error: unknown = await service
      .parse(file(Buffer.alloc(MAX_UPLOAD_BYTES + 1)))
      .catch((caught: unknown) => caught);

    expect((error as ApiException).getResponse()).toMatchObject({
      statusCode: 413,
      code: ERROR_KEYS.documentTooLarge,
    });
  });

  it('отклоняет неподдержанный MIME (415)', async () => {
    const error: unknown = await service
      .parse(file(Buffer.from('hello'), 'text/plain', 'note.txt'))
      .catch((caught: unknown) => caught);

    expect((error as ApiException).getResponse()).toMatchObject({
      statusCode: 415,
      code: ERROR_KEYS.unsupportedDocumentType,
    });
  });

  it('битый PDF даёт 400, а не 500', async () => {
    const error: unknown = await service
      .parse(file(Buffer.from('not a pdf')))
      .catch((caught: unknown) => caught);

    expect((error as ApiException).getResponse()).toMatchObject({
      statusCode: 400,
      code: ERROR_KEYS.invalidRequest,
    });
  });
});

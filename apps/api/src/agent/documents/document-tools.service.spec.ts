import AdmZip from 'adm-zip';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deflateSync } from 'node:zlib';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiException } from '../../common/api-error.js';
import { ERROR_KEYS } from '../../i18n/error-keys.js';
import { buildDocx } from './docx-builder.js';
import {
  DocumentToolsService,
  DocxWriteResponseSchema,
  mimeTypeFromPath,
  readDocumentsConfig,
  resolveDocumentPath,
} from './document-tools.service.js';
import type { OcrSmartEngineService } from './ocr-smart-engine.service.js';

const CONTRACT_TEXT = [
  'ДОГОВОР № 42/2026',
  'ООО «Ромашка» и АО «Вектор» заключили договор.',
  'Цена договора: 1 500 000,00 руб.',
  'Дата: 12.03.2026',
].join('\n');

/**
 * Собирает одностраничный PDF с кириллицей через Type0-шрифт и ToUnicode.
 *
 * Коды символов назначаются по порядку первого появления; строки выводятся
 * отдельными `Tj`, чтобы проверить и текст, и разметку строк.
 */
function cyrillicPdf(lines: readonly string[]): Buffer {
  const chars = [...new Set(lines.join('').split(''))];
  const codeOf = new Map(chars.map((character, index) => [character, index + 1]));
  const hexOf = (character: string): string =>
    (codeOf.get(character) ?? 0).toString(16).toUpperCase().padStart(4, '0');
  const cMap = [
    '/CIDInit /ProcSet findresource begin',
    '12 dict begin',
    'begincmap',
    '1 begincodespacerange',
    '<0000> <FFFF>',
    'endcodespacerange',
    `${chars.length} beginbfchar`,
    ...chars.map(
      (character) =>
        `<${hexOf(character)}> <${(character.codePointAt(0) ?? 0).toString(16).toUpperCase().padStart(4, '0')}>`,
    ),
    'endbfchar',
    'endcmap',
    'end',
    'end',
  ].join('\n');
  const content = lines
    .map(
      (line, index) =>
        `BT /F1 11 Tf 1 0 0 1 72 ${760 - index * 18} Tm <${[...line].map(hexOf).join('')}> Tj ET`,
    )
    .join('\n');
  const parts: Buffer[] = [Buffer.from('%PDF-1.7\n', 'latin1')];
  const objects: Array<{ number: number; dict: string; stream?: Buffer; compress?: boolean }> = [
    { number: 1, dict: '<< /Type /Catalog /Pages 2 0 R >>' },
    { number: 2, dict: '<< /Type /Pages /Kids [3 0 R] /Count 1 >>' },
    {
      number: 3,
      dict:
        '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    },
    {
      number: 4,
      dict:
        '<< /Type /Font /Subtype /Type0 /BaseFont /Arial /Encoding /Identity-H /ToUnicode 6 0 R >>',
    },
    {
      number: 5,
      dict: '<< /Length 500 /Filter /FlateDecode >>',
      stream: Buffer.from(content, 'latin1'),
      compress: true,
    },
    {
      number: 6,
      dict: '<< /Length 900 /Filter /FlateDecode >>',
      stream: Buffer.from(cMap, 'latin1'),
      compress: true,
    },
  ];

  for (const object of objects) {
    parts.push(Buffer.from(`${object.number} 0 obj\n${object.dict}\n`, 'latin1'));

    if (object.stream !== undefined) {
      const data =
        object.compress === true ? deflateSync(object.stream) : object.stream;

      parts.push(Buffer.from('stream\n', 'latin1'), data, Buffer.from('\nendstream\n', 'latin1'));
    }

    parts.push(Buffer.from('endobj\n', 'latin1'));
  }

  parts.push(Buffer.from('trailer\n<< /Root 1 0 R >>\n%%EOF\n', 'latin1'));

  return Buffer.concat(parts);
}

interface Harness {
  readonly service: DocumentToolsService;
  readonly recognize: ReturnType<typeof vi.fn>;
  readonly root: string;
  readonly inputDir: string;
  readonly outputDir: string;
}

let harness: Harness;

beforeEach(async () => {
  const root = await mkdtemp(join(tmpdir(), 'skillwharf-documents-'));
  const inputDir = join(root, 'documents');
  const outputDir = join(root, 'out');

  await mkdir(inputDir, { recursive: true });

  process.env.DOCUMENTS_INPUT_DIR = inputDir;
  process.env.DOCUMENTS_OUTPUT_DIR = outputDir;
  delete process.env.DOCUMENTS_MAX_BYTES;
  delete process.env.DOCUMENTS_MAX_PAGES;
  delete process.env.DOCUMENTS_MAX_TEXT_CHARS;

  const recognize = vi.fn(
    async (input: { readonly language?: string }) => ({
      text: 'Скан: Договор № 7 от 01.02.2026 на 500 000 руб.',
      engine: 'tesseract' as const,
      language: input.language ?? 'rus+eng',
      warnings: [] as string[],
    }),
  );

  harness = {
    service: new DocumentToolsService(
      { recognize } as unknown as OcrSmartEngineService,
    ),
    recognize,
    root,
    inputDir,
    outputDir,
  };
});

afterEach(async () => {
  delete process.env.DOCUMENTS_INPUT_DIR;
  delete process.env.DOCUMENTS_OUTPUT_DIR;
  delete process.env.DOCUMENTS_MAX_BYTES;
  delete process.env.DOCUMENTS_MAX_PAGES;
  delete process.env.DOCUMENTS_MAX_TEXT_CHARS;
  await rm(harness.root, { recursive: true, force: true });
});

describe('readDocumentsConfig', () => {
  it('берёт значения по умолчанию', () => {
    expect(readDocumentsConfig({})).toEqual({
      inputDir: './documents',
      outputDir: './docx-output',
      maxBytes: 10 * 1024 * 1024,
      maxPages: 50,
      maxTextChars: 100_000,
    });
  });
});

describe('resolveDocumentPath', () => {
  it('разрешает относительный путь внутри каталога', () => {
    const base = join(harness.root, 'documents');

    expect(resolveDocumentPath(base, 'sub/contract.pdf')).toBe(
      join(base, 'sub', 'contract.pdf'),
    );
  });

  it('блокирует абсолютные пути и выход за каталог', () => {
    expect(() => resolveDocumentPath('/data/docs', '/etc/passwd')).toThrow(
      /относительным/,
    );
    expect(() => resolveDocumentPath('/data/docs', 'C:/secret.pdf')).toThrow(
      /относительным/,
    );
    expect(() => resolveDocumentPath('/data/docs', '../secret.pdf')).toThrow(
      /«\.\.»/,
    );
    expect(() => resolveDocumentPath('/data/docs', 'a//b.pdf')).toThrow(
      /«\.\.»/,
    );
  });
});

describe('mimeTypeFromPath', () => {
  it('определяет тип по расширению', () => {
    expect(mimeTypeFromPath('scan.PNG')).toBe('image/png');
    expect(mimeTypeFromPath('scan.jpeg')).toBe('image/jpeg');
    expect(mimeTypeFromPath('scan.tiff')).toBe('image/tiff');
    expect(mimeTypeFromPath('contract.pdf')).toBeNull();
  });
});

describe('extract_pdf', () => {
  it('извлекает текст и таблицы из файла в каталоге документов', async () => {
    await writeFile(join(harness.inputDir, 'contract.pdf'), cyrillicPdf([
      'ДОГОВОР 42/2026',
      'Цена 1500000 руб.',
    ]));

    const result = JSON.parse(
      await harness.service.extractPdf({ path: 'contract.pdf' }),
    ) as Record<string, unknown>;

    expect(result).toMatchObject({
      tool: 'pdf-extractor',
      pageCount: 1,
      source: { kind: 'path', label: 'contract.pdf' },
      metadata: { title: null, producer: null, creator: null },
    });
    expect(JSON.stringify(result.text)).toContain('ДОГОВОР 42/2026');
    expect(JSON.stringify(result.text)).toContain('Цена 1500000 руб.');
    expect(result.warnings).toEqual([]);
  });

  it('принимает PDF в base64', async () => {
    const pdf = cyrillicPdf(['Просто текст']);

    const result = JSON.parse(
      await harness.service.extractPdf({
        pdfBase64: pdf.toString('base64'),
        maxPages: 1,
      }),
    ) as Record<string, unknown>;

    expect(result.source).toMatchObject({ kind: 'inline' });
    expect(JSON.stringify(result.text)).toContain('Просто текст');
  });

  it('требует ровно один источник', async () => {
    await expect(harness.service.extractPdf({})).rejects.toThrow();
    await expect(
      harness.service.extractPdf({ path: 'a.pdf', pdfBase64: 'AA==' }),
    ).rejects.toThrow();
  });

  it('отдаёт 400 на отсутствующий файл и на выход из каталога', async () => {
    await expect(
      harness.service.extractPdf({ path: 'missing.pdf' }),
    ).rejects.toMatchObject({ status: 400 });
    await expect(
      harness.service.extractPdf({ path: '../secret.pdf' }),
    ).rejects.toMatchObject({ status: 400 });
  });

  it('отклоняет файл больше лимита', async () => {
    process.env.DOCUMENTS_MAX_BYTES = '10';
    await writeFile(join(harness.inputDir, 'big.pdf'), cyrillicPdf(['текст']));

    const error: unknown = await harness.service
      .extractPdf({ path: 'big.pdf' })
      .catch((caught: unknown) => caught);

    expect((error as ApiException).getResponse()).toMatchObject({
      statusCode: 400,
      code: ERROR_KEYS.invalidRequest,
    });
    expect((error as ApiException).getResponse().message).toMatch(/больше/);
  });

  it('обрезает слишком длинный текст с предупреждением', async () => {
    process.env.DOCUMENTS_MAX_TEXT_CHARS = '5';
    await writeFile(
      join(harness.inputDir, 'long.pdf'),
      cyrillicPdf(['Очень длинный текст документа']),
    );

    const result = JSON.parse(
      await harness.service.extractPdf({ path: 'long.pdf' }),
    ) as { text: string; warnings: string[] };

    expect(result.text).toHaveLength(5);
    expect(result.warnings.join(' ')).toMatch(/текст обрезан до 5 символов/);
  });
});

describe('write_docx', () => {
  it('создаёт настоящий DOCX и возвращает путь', async () => {
    const result = DocxWriteResponseSchema.parse(
      JSON.parse(
        await harness.service.writeDocx({
          title: 'Отчёт по договору',
          blocks: [
            { type: 'paragraph', text: 'Сумма — 1 500 000 ₽.' },
            {
              type: 'table',
              headers: ['Позиция', 'Сумма'],
              rows: [['Услуги', '1 500 000']],
            },
          ],
          filename: 'report.docx',
        }),
      ),
    );

    expect(result.path).toBe(join(harness.outputDir, 'report.docx'));
    expect(result.blocks).toBe(2);
    expect(result.tables).toBe(1);

    const zip = new AdmZip(result.path);
    const documentXml = zip.getEntry('word/document.xml')?.getData().toString('utf8') ?? '';

    expect(documentXml).toContain('Отчёт по договору');
    expect(documentXml).toContain('<w:tbl>');
  });

  it('генерирует имя файла, если оно не задано', async () => {
    const result = DocxWriteResponseSchema.parse(
      JSON.parse(
        await harness.service.writeDocx({
          title: 'Документ',
          blocks: [{ type: 'paragraph', text: 'Текст' }],
        }),
      ),
    );

    expect(result.path).toMatch(/docx-[0-9a-f-]+\.docx$/);
  });

  it('не пропускает имя файла с путём или другим расширением', async () => {
    await expect(
      harness.service.writeDocx({
        title: 'Документ',
        blocks: [{ type: 'paragraph', text: 'Текст' }],
        filename: '../evil.docx',
      }),
    ).rejects.toMatchObject({ status: 400 });
    await expect(
      harness.service.writeDocx({
        title: 'Документ',
        blocks: [{ type: 'paragraph', text: 'Текст' }],
        filename: 'report.txt',
      }),
    ).rejects.toMatchObject({ status: 400 });
  });
});

describe('ocr_document', () => {
  it('определяет MIME по расширению и зовёт OCR', async () => {
    await writeFile(join(harness.inputDir, 'scan.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]));

    const result = JSON.parse(
      await harness.service.ocrDocument({ path: 'scan.png', language: 'ru' }),
    ) as Record<string, unknown>;

    expect(result).toMatchObject({
      tool: 'ocr-smart-engine',
      engine: 'tesseract',
      language: 'ru',
      source: { kind: 'path', label: 'scan.png' },
    });
    expect(harness.recognize).toHaveBeenCalledWith({
      imageBase64: expect.stringContaining('iVBOR'),
      mimeType: 'image/png',
      language: 'ru',
    });
  });

  it('требует MIME-тип для файла без распознаваемого расширения', async () => {
    await writeFile(join(harness.inputDir, 'scan.bin'), Buffer.from([1, 2, 3]));

    await expect(
      harness.service.ocrDocument({ path: 'scan.bin' }),
    ).rejects.toMatchObject({ status: 400 });
    expect(harness.recognize).not.toHaveBeenCalled();
  });

  it('принимает изображение в base64 с явным MIME', async () => {
    const result = JSON.parse(
      await harness.service.ocrDocument({
        imageBase64: Buffer.from('fake-png').toString('base64'),
        mimeType: 'image/jpeg',
      }),
    ) as Record<string, unknown>;

    expect(result.source).toMatchObject({ kind: 'inline' });
    expect(harness.recognize).toHaveBeenCalledWith({
      imageBase64: expect.any(String),
      mimeType: 'image/jpeg',
    });
  });
});

describe('extract_document_data', () => {
  it('разбирает переданный текст договора', async () => {
    const result = JSON.parse(
      await harness.service.extractDocumentData({ documentText: CONTRACT_TEXT }),
    ) as Record<string, unknown>;

    expect(result).toMatchObject({
      tool: 'document-analyzer',
      source: { kind: 'inline', label: 'inline:text' },
      dataAvailable: true,
      contractNumber: '42/2026',
      primaryAmount: { value: 1_500_000, currency: 'RUB' },
      primaryDate: { iso: '2026-03-12' },
    });
    expect(result.parties).toHaveLength(2);
  });

  it('разбирает PDF из каталога документов', async () => {
    await writeFile(join(harness.inputDir, 'contract.pdf'), cyrillicPdf(CONTRACT_TEXT.split('\n')));

    const result = JSON.parse(
      await harness.service.extractDocumentData({ path: 'contract.pdf' }),
    ) as Record<string, unknown>;

    expect(result).toMatchObject({
      dataAvailable: true,
      contractNumber: '42/2026',
      primaryAmount: { value: 1_500_000, currency: 'RUB' },
    });
  });

  it('разбирает DOCX, созданный write_docx (round-trip)', async () => {
    const buffer = buildDocx({
      title: 'Договор',
      blocks: [{ type: 'paragraph', text: CONTRACT_TEXT }],
    });

    await writeFile(join(harness.inputDir, 'contract.docx'), buffer);

    const result = JSON.parse(
      await harness.service.extractDocumentData({ path: 'contract.docx' }),
    ) as Record<string, unknown>;

    expect(result).toMatchObject({
      dataAvailable: true,
      contractNumber: '42/2026',
      primaryAmount: { value: 1_500_000, currency: 'RUB' },
    });
  });

  it('разбирает скан через OCR', async () => {
    await writeFile(join(harness.inputDir, 'scan.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]));

    const result = JSON.parse(
      await harness.service.extractDocumentData({ path: 'scan.png' }),
    ) as Record<string, unknown>;

    expect(harness.recognize).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({
      dataAvailable: true,
      contractNumber: '7',
      primaryAmount: { value: 500_000, currency: 'RUB' },
    });
  });

  it('разбирает TXT и сообщает об отсутствии реквизитов', async () => {
    await writeFile(join(harness.inputDir, 'note.txt'), 'Просто заметка.');

    const result = JSON.parse(
      await harness.service.extractDocumentData({ path: 'note.txt' }),
    ) as Record<string, unknown>;

    expect(result).toMatchObject({ dataAvailable: false, primaryAmount: null });
    expect((result.warnings as string[]).length).toBeGreaterThan(0);
  });

  it('отклоняет неподдерживаемый формат', async () => {
    await writeFile(join(harness.inputDir, 'table.xlsx'), 'fake');

    await expect(
      harness.service.extractDocumentData({ path: 'table.xlsx' }),
    ).rejects.toMatchObject({ status: 400 });
  });

  it('требует ровно один источник', async () => {
    await expect(harness.service.extractDocumentData({})).rejects.toThrow();
    await expect(
      harness.service.extractDocumentData({
        documentText: 'текст',
        path: 'note.txt',
      }),
    ).rejects.toThrow();
  });
});

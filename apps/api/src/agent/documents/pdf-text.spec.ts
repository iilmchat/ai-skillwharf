import { deflateSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { extractPdfText } from './pdf-text.js';

/** Объект тестового PDF. */
interface ObjectSpec {
  readonly number: number;
  readonly dict: string;
  readonly stream?: Buffer;
  readonly compress?: boolean;
}

/** Собирает минимальный PDF (xref не пишем: парсер его не использует). */
function buildPdf(objects: readonly ObjectSpec[]): Buffer {
  const parts: Buffer[] = [Buffer.from('%PDF-1.7\n%\xE2\xE3\xCF\xD3\n', 'latin1')];

  for (const object of objects) {
    parts.push(
      Buffer.from(`${object.number} 0 obj\n${object.dict}\n`, 'latin1'),
    );

    if (object.stream !== undefined) {
      const data =
        object.compress === true ? deflateSync(object.stream) : object.stream;

      parts.push(
        Buffer.from('stream\n', 'latin1'),
        data,
        Buffer.from('\nendstream\n', 'latin1'),
      );
    }

    parts.push(Buffer.from('endobj\n', 'latin1'));
  }

  parts.push(
    Buffer.from(
      'trailer\n<< /Size 20 /Root 1 0 R >>\nstartxref\n0\n%%EOF\n',
      'latin1',
    ),
  );

  return Buffer.concat(parts);
}

/** Литеральная PDF-строка. */
function pdfString(text: string): string {
  return `(${text.replace(/([\\()])/g, '\\$1')})`;
}

/** Одностраничный PDF с заданным содержимым и шрифтом. */
function singlePage(
  content: string,
  options: {
    readonly fontDict?: string;
    readonly compress?: boolean;
    readonly extra?: readonly ObjectSpec[];
  } = {},
): Buffer {
  const fontDict =
    options.fontDict ??
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>';
  const objects: ObjectSpec[] = [
    { number: 1, dict: '<< /Type /Catalog /Pages 2 0 R >>' },
    { number: 2, dict: '<< /Type /Pages /Kids [3 0 R] /Count 1 >>' },
    {
      number: 3,
      dict:
        '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] ' +
        '/Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    },
    { number: 4, dict: fontDict },
    {
      number: 5,
      dict: options.compress === true
        ? '<< /Length 100 /Filter /FlateDecode >>'
        : '<< /Length 100 >>',
      stream: Buffer.from(content, 'latin1'),
      ...(options.compress === true ? { compress: true } : {}),
    },
    ...(options.extra ?? []),
  ];

  return buildPdf(objects);
}

describe('extractPdfText: текст', () => {
  it('извлекает текст простого шрифта с WinAnsi-кодировкой', () => {
    const pdf = singlePage(
      ['BT /F1 12 Tf 1 0 0 1 72 720 Tm (Hello World) Tj ET', 'BT /F1 12 Tf 72 700 Td (Second line) Tj ET'].join('\n'),
    );

    const result = extractPdfText(pdf);

    expect(result.pageCount).toBe(1);
    expect(result.pages[0]?.text).toBe('Hello World\nSecond line');
    expect(result.warnings).toEqual([]);
  });

  it('распаковывает FlateDecode-поток содержимого', () => {
    const pdf = singlePage(
      'BT /F1 14 Tf 1 0 0 1 72 700 Tm (Compressed text) Tj ET\n',
      { compress: true },
    );

    const result = extractPdfText(pdf);

    expect(result.pages[0]?.text).toBe('Compressed text');
  });

  it('декодирует кириллицу через ToUnicode CMap составного шрифта', () => {
    const cmap = [
      '/CIDInit /ProcSet findresource begin',
      '12 dict begin',
      'begincmap',
      '1 begincodespacerange',
      '<0000> <FFFF>',
      'endcodespacerange',
      '1 beginbfchar',
      '<0001> <0414>',
      'endbfchar',
      '1 beginbfrange',
      '<0002> <0004> <043E>',
      'endbfrange',
      'endcmap',
      'end',
      'end',
    ].join('\n');
    const pdf = singlePage(
      'BT /F1 12 Tf 1 0 0 1 72 700 Tm <0001000200030004> Tj ET\n',
      {
        fontDict:
          '<< /Type /Font /Subtype /Type0 /BaseFont /Arial /Encoding /Identity-H /ToUnicode 6 0 R >>',
        extra: [
          {
            number: 6,
            dict: '<< /Length 200 /Filter /FlateDecode >>',
            stream: Buffer.from(cmap, 'latin1'),
            compress: true,
          },
        ],
      },
    );

    const result = extractPdfText(pdf);

    expect(result.pages[0]?.text).toBe('Допр');
  });

  it('читает несколько страниц и соблюдает maxPages', () => {
    const pdf = buildPdf([
      { number: 1, dict: '<< /Type /Catalog /Pages 2 0 R >>' },
      { number: 2, dict: '<< /Type /Pages /Kids [3 0 R 6 0 R] /Count 2 >>' },
      {
        number: 3,
        dict:
          '<< /Type /Page /Parent 2 0 R /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
      },
      {
        number: 4,
        dict: '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>',
      },
      {
        number: 5,
        dict: '<< /Length 100 >>',
        stream: Buffer.from('BT /F1 12 Tf 72 700 Td (Page one) Tj ET', 'latin1'),
      },
      {
        number: 6,
        dict:
          '<< /Type /Page /Parent 2 0 R /Resources << /Font << /F1 4 0 R >> >> /Contents 7 0 R >>',
      },
      {
        number: 7,
        dict: '<< /Length 100 >>',
        stream: Buffer.from('BT /F1 12 Tf 72 700 Td (Page two) Tj ET', 'latin1'),
      },
    ]);

    const limited = extractPdfText(pdf, { maxPages: 1 });

    expect(extractPdfText(pdf).pages.map((page) => page.text)).toEqual([
      'Page one',
      'Page two',
    ]);
    expect(limited.pageCount).toBe(1);
    expect(limited.warnings).toEqual([
      'разобрано 1 из 2 страниц (лимит maxPages)',
    ]);
  });

  it('сообщает о зашифрованном PDF, но не падает', () => {
    const pdf = Buffer.concat([
      buildPdf([
        { number: 1, dict: '<< /Type /Catalog /Pages 2 0 R >>' },
        { number: 2, dict: '<< /Type /Pages /Kids [] /Count 0 >>' },
      ]),
      Buffer.from('trailer\n<< /Root 1 0 R /Encrypt 9 0 R >>', 'latin1'),
    ]);

    const result = extractPdfText(pdf);

    expect(result.warnings).toContain(
      'PDF зашифрован (/Encrypt): текст извлечён не будет без пароля',
    );
  });

  it('отклоняет файл без сигнатуры %PDF-', () => {
    expect(() => extractPdfText(Buffer.from('not a pdf'))).toThrow(
      /не является PDF/,
    );
    expect(() => extractPdfText(Buffer.alloc(0))).toThrow(/PDF пуст/);
  });

  it('читает метаданные /Info', () => {
    const pdf = buildPdf([
      { number: 1, dict: '<< /Type /Catalog /Pages 2 0 R >>' },
      { number: 2, dict: '<< /Type /Pages /Kids [] /Count 0 >>' },
      {
        number: 9,
        dict: '<< /Title (Contract 2026) /Producer (SkillWharf) /Creator (QA) >>',
      },
    ]);

    expect(extractPdfText(pdf).metadata).toEqual({
      title: 'Contract 2026',
      producer: 'SkillWharf',
      creator: 'QA',
    });
  });
});

describe('extractPdfText: объектные потоки PDF 1.5+', () => {
  it('находит страницы и шрифты внутри сжатого ObjStm', () => {
    const entries: Array<{ number: number; body: string }> = [
      {
        number: 2,
        body: '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
      },
      {
        number: 3,
        body:
          '<< /Type /Page /Parent 2 0 R /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
      },
      {
        number: 4,
        body:
          '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>',
      },
    ];
    const offsets: number[] = [];
    let offset = 0;

    for (const entry of entries) {
      offsets.push(offset);
      offset += entry.body.length + 1;
    }

    const header = entries
      .map((entry, index) => `${entry.number} ${offsets[index] ?? 0}`)
      .join(' ');
    const bodies = entries.map((entry) => entry.body).join(' ');
    const payload = `${header} ${bodies}`;
    const pdf = buildPdf([
      { number: 1, dict: '<< /Type /Catalog /Pages 2 0 R >>' },
      {
        number: 6,
        dict: `<< /Type /ObjStm /N ${entries.length} /First ${header.length + 1} /Length ${payload.length} /Filter /FlateDecode >>`,
        stream: Buffer.from(payload, 'latin1'),
        compress: true,
      },
      {
        number: 5,
        dict: '<< /Length 100 >>',
        stream: Buffer.from('BT /F1 12 Tf 72 700 Td (From object stream) Tj ET', 'latin1'),
      },
    ]);

    const result = extractPdfText(pdf);

    expect(result.pageCount).toBe(1);
    expect(result.pages[0]?.text).toBe('From object stream');
    expect(result.warnings).toEqual([]);
  });
});

describe('extractPdfText: таблицы', () => {
  it('восстанавливает таблицу по выровненным колонкам', () => {
    const content = [
      'BT /F1 10 Tf 1 0 0 1 72 700 Tm (Item) Tj ET',
      'BT /F1 10 Tf 1 0 0 1 200 700 Tm (Qty) Tj ET',
      'BT /F1 10 Tf 1 0 0 1 350 700 Tm (Price) Tj ET',
      'BT /F1 10 Tf 1 0 0 1 72 680 Tm (Contract) Tj ET',
      'BT /F1 10 Tf 1 0 0 1 200 680 Tm (3) Tj ET',
      'BT /F1 10 Tf 1 0 0 1 350 680 Tm (1500) Tj ET',
      'BT /F1 10 Tf 1 0 0 1 72 660 Tm (Report) Tj ET',
      'BT /F1 10 Tf 1 0 0 1 200 660 Tm (1) Tj ET',
      'BT /F1 10 Tf 1 0 0 1 350 660 Tm (200) Tj ET',
    ].join('\n');

    const result = extractPdfText(singlePage(content));

    expect(result.tables).toHaveLength(1);
    expect(result.tables[0]?.page).toBe(1);
    expect(result.tables[0]?.rows).toEqual([
      ['Item', 'Qty', 'Price'],
      ['Contract', '3', '1500'],
      ['Report', '1', '200'],
    ]);
  });

  it('не считает таблицей обычный абзац', () => {
    const content = [
      'BT /F1 12 Tf 1 0 0 1 72 700 Tm (The quick brown fox jumps over the lazy dog) Tj ET',
      'BT /F1 12 Tf 1 0 0 1 72 680 Tm (Second line of the same paragraph goes here) Tj ET',
    ].join('\n');

    expect(extractPdfText(singlePage(content)).tables).toEqual([]);
  });
});

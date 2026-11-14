import { inflateRawSync, inflateSync } from 'node:zlib';

/**
 * Извлечение текста и таблиц из PDF без внешних бинарников.
 *
 * Реализован минимальный, но честный разбор формата:
 * - объекты `N 0 obj ... endobj` и потоки `stream ... endstream`;
 * - фильтр `/FlateDecode` (zlib, fallback на raw deflate);
 * - дерево страниц `/Type /Pages` → `/Kids`, отдельные `/Page`;
 * - текстовые операторы `BT/ET`, `Tf`, `TL`, `Td/TD/Tm/T*`, `Tj/TJ`, `'`, `"`;
 * - кодировки: `/ToUnicode` CMap (`beginbfchar`/`beginbfrange`) для простых
 *   и составных (`Type0`/`Identity-H`) шрифтов, иначе WinAnsi/Latin-1.
 *
 * Чего сознательно нет: xref-таблиц (объекты находятся сканированием), CFF-
 * парсинга, предсказателей PNG/TIFF, шифрования и инкрементальных обновлений.
 * PDF с такими особенностями разбирается частично; `warnings` сообщает об этом.
 *
 * Таблицы восстанавливаются по геометрии: строки — близкие по `y` элементы,
 * ячейки — разрывы по `x`, а таблицей считается блок из двух и более строк с
 * одинаковым числом ячеек и выровненными левыми краями (см. `detectTables`).
 */

/** Один текстовый фрагмент, выведенный оператором показа текста. */
export interface PdfTextItem {
  /** Левый край фрагмента в текстовых координатах. */
  readonly x: number;
  /** Базовая линия фрагмента. */
  readonly y: number;
  /** Размер шрифта, которым выведен фрагмент. */
  readonly size: number;
  /** Декодированный текст. */
  readonly text: string;
}

/** Строка страницы: текст и ячейки, разделённые крупными пробелами. */
export interface PdfTextLine {
  readonly y: number;
  readonly text: string;
  /** Ячейки строки (одна ячейка — обычная строка без `x`-разрывов). */
  readonly cells: readonly string[];
}

/** Таблица, восстановленная из выровненных строк. */
export interface PdfTable {
  readonly page: number;
  readonly rows: readonly (readonly string[])[];
}

/** Текст одной страницы. */
export interface PdfPageText {
  readonly page: number;
  readonly text: string;
  readonly lines: readonly PdfTextLine[];
}

/** Результат извлечения. */
export interface PdfExtractionResult {
  readonly pageCount: number;
  readonly pages: readonly PdfPageText[];
  readonly tables: readonly PdfTable[];
  readonly metadata: {
    readonly title: string | null;
    readonly producer: string | null;
    readonly creator: string | null;
  };
  /** Ограничения, из-за которых часть содержимого пропущена. */
  readonly warnings: readonly string[];
}

/** Опции извлечения. */
export interface PdfExtractOptions {
  /** Сколько страниц разбирать максимум (по умолчанию 50). */
  readonly maxPages?: number;
}

/** Максимальное число страниц по умолчанию. */
export const DEFAULT_MAX_PAGES = 50;

/** Разрыв по `x`, после которого фрагменты считаются разными ячейками. */
const CELL_GAP_FACTOR = 1.5;
const CELL_GAP_MIN = 8;

/** Сырой объект PDF: словарь (как текст) и, если есть, поток. */
interface PdfRawObject {
  readonly number: number;
  readonly dict: string;
  readonly stream: Buffer | null;
}

/** Шрифт страницы: кодировка и карта `ToUnicode`. */
interface PdfFont {
  readonly twoByte: boolean;
  readonly cmap: ReadonlyMap<string, string> | null;
}

/** Собранные объекты документа. */
interface PdfDocument {
  readonly objects: ReadonlyMap<number, PdfRawObject>;
  readonly warnings: string[];
}

const OBJECT_PATTERN = /(\d+)\s+(\d+)\s+obj\b/g;

/**
 * Извлекает текст и таблицы из PDF.
 *
 * @throws Error если буфер не похож на PDF или содержит зашифрованный трафик.
 */
export function extractPdfText(
  buffer: Buffer,
  options: PdfExtractOptions = {},
): PdfExtractionResult {
  if (buffer.length === 0) {
    throw new Error('PDF пуст');
  }

  const head = buffer.subarray(0, 1_024).toString('latin1');

  if (!head.includes('%PDF-')) {
    throw new Error('Файл не является PDF: отсутствует сигнатура %PDF-');
  }

  const warnings: string[] = [];
  const document = readDocument(buffer, warnings);
  const pageNumbers = collectPageNumbers(document, warnings);
  const maxPages = Math.max(1, options.maxPages ?? DEFAULT_MAX_PAGES);
  const selected = pageNumbers.slice(0, maxPages);

  if (pageNumbers.length > selected.length) {
    warnings.push(
      `разобрано ${selected.length} из ${pageNumbers.length} страниц (лимит maxPages)`,
    );
  }

  const pages: PdfPageText[] = [];
  const tables: PdfTable[] = [];

  selected.forEach((pageNumber, index) => {
    const pageDict = document.objects.get(pageNumber)?.dict ?? '';
    const fonts = readPageFonts(document, pageDict);
    const contents = readPageContents(document, pageNumber);
    const items = interpretContent(contents, fonts, warnings, index + 1);
    const lines = buildLines(items);
    const pageTables = detectTables(lines, index + 1);

    pages.push({
      page: index + 1,
      text: lines.map((line) => line.text).join('\n'),
      lines,
    });
    tables.push(...pageTables);
  });

  if (pages.length === 0) {
    warnings.push('в PDF не найдено ни одной страницы');
  }

  return {
    pageCount: pages.length,
    pages,
    tables,
    metadata: readMetadata(document),
    warnings,
  };
}

/** Находит объекты документа сканированием (xref не используется). */
function readDocument(buffer: Buffer, warnings: string[]): PdfDocument {
  const text = buffer.toString('latin1');
  const objects = new Map<number, PdfRawObject>();
  const encrypted = /\/Encrypt\s+\d+\s+\d+\s+R/.test(text);

  if (encrypted) {
    warnings.push(
      'PDF зашифрован (/Encrypt): текст извлечён не будет без пароля',
    );
  }

  OBJECT_PATTERN.lastIndex = 0;

  let match: RegExpExecArray | null;

  while ((match = OBJECT_PATTERN.exec(text)) !== null) {
    const number = Number.parseInt(match[1] ?? '', 10);
    const bodyStart = match.index + match[0].length;
    const endObject = text.indexOf('endobj', bodyStart);
    const bodyEnd = endObject === -1 ? text.length : endObject;
    const body = text.slice(bodyStart, bodyEnd);
    const streamMatch = /\bstream(\r\n|\n|\r)/.exec(body);
    let dict = body;
    let stream: Buffer | null = null;

    if (streamMatch) {
      const dictEnd = streamMatch.index;
      const dataStart = dictEnd + streamMatch[0].length;
      const endStream = body.indexOf('endstream', dataStart);
      const dataEnd = endStream === -1 ? body.length : endStream;
      const raw = body.slice(dataStart, dataEnd);

      dict = body.slice(0, dictEnd);
      stream = Buffer.from(stripStreamEol(raw), 'latin1');
    }

    if (Number.isInteger(number) && number > 0) {
      objects.set(number, { number, dict, stream });
    }

    OBJECT_PATTERN.lastIndex =
      endObject === -1 ? text.length : endObject + 'endobj'.length;
  }

  if (objects.size === 0) {
    warnings.push('в PDF не найдено ни одного объекта');
  }

  expandObjectStreams(objects, warnings);

  return { objects, warnings };
}

/**
 * Раскрывает сжатые объектные потоки (`/Type /ObjStm`, PDF 1.5+).
 *
 * Word и LibreOffice пакуют словари страниц и шрифтов в `ObjStm`, поэтому без
 * этого шага текст из современных PDF не извлекается. Потоки внутри `ObjStm`
 * по спецификации запрещены, так что раскрываются только словари.
 */
function expandObjectStreams(
  objects: Map<number, PdfRawObject>,
  warnings: string[],
): void {
  const streams = [...objects.values()].filter(
    (object) => object.stream !== null && /\/Type\s*\/ObjStm\b/.test(object.dict),
  );

  for (const object of streams) {
    const data = decodeStream(object.dict, object.stream ?? Buffer.alloc(0));

    if (data === null) {
      warnings.push(
        `объектный поток ${object.number} не распакован: фильтр не поддержан`,
      );

      continue;
    }

    const count = readDictNumber(object.dict, 'N');
    const first = readDictNumber(object.dict, 'First');
    const text = data.toString('latin1');

    if (count === null || first === null || count <= 0 || first <= 0) {
      warnings.push(`объектный поток ${object.number}: нет /N или /First`);

      continue;
    }

    const numbers = text
      .slice(0, first)
      .trim()
      .split(/\s+/)
      .map((value) => Number.parseInt(value, 10));

    if (numbers.length < count * 2) {
      warnings.push(`объектный поток ${object.number}: заголовок неполный`);

      continue;
    }

    for (let index = 0; index < count; index += 1) {
      const number = numbers[index * 2] ?? 0;
      const offset = numbers[index * 2 + 1] ?? 0;
      const nextIndex = index + 1;

      if (!Number.isInteger(number) || !Number.isInteger(offset)) {
        continue;
      }

      if (objects.has(number)) {
        continue;
      }

      const start = first + offset;
      const end =
        nextIndex < count
          ? first + (numbers[nextIndex * 2 + 1] ?? text.length)
          : text.length;
      const body = text.slice(start, Math.max(start, end)).trim();

      objects.set(number, { number, dict: body, stream: null });
    }
  }
}

/** EOL перед `endstream` не входит в данные потока. */
function stripStreamEol(raw: string): string {
  return raw.endsWith('\r\n')
    ? raw.slice(0, -2)
    : raw.endsWith('\n') || raw.endsWith('\r')
      ? raw.slice(0, -1)
      : raw;
}

/** Номера объектов страниц в порядке дерева `/Pages`. */
function collectPageNumbers(
  document: PdfDocument,
  warnings: string[],
): number[] {
  const catalog = [...document.objects.values()].find((object) =>
    /\/Type\s*\/Catalog\b/.test(object.dict),
  );
  const rootPages =
    catalog === undefined ? null : readDictRef(catalog.dict, 'Pages');

  if (rootPages === null) {
    warnings.push('каталог /Pages не найден: страницы собраны сканированием');
  }

  const pages: number[] = [];
  const visited = new Set<number>();

  const walk = (number: number): void => {
    if (visited.has(number) || visited.size > 10_000) {
      return;
    }

    visited.add(number);

    const object = document.objects.get(number);

    if (object === undefined) {
      return;
    }

    if (/\/Type\s*\/Page\b/.test(object.dict)) {
      pages.push(number);

      return;
    }

    for (const kid of readDictRefs(object.dict, 'Kids')) {
      walk(kid);
    }
  };

  if (rootPages !== null) {
    walk(rootPages);
  }

  if (pages.length === 0) {
    for (const object of document.objects.values()) {
      if (/\/Type\s*\/Page\b/.test(object.dict)) {
        pages.push(object.number);
      }
    }
  }

  if (rootPages !== null && pages.length === 0) {
    warnings.push('дерево страниц пустое');
  }

  return pages;
}

/** Ссылки на потоки содержимого страницы. */
function readPageContents(document: PdfDocument, pageNumber: number): Buffer[] {
  const object = document.objects.get(pageNumber);
  const contents: Buffer[] = [];

  if (object === undefined) {
    return contents;
  }

  const single = readDictRef(object.dict, 'Contents');

  if (single !== null) {
    const stream = document.objects.get(single)?.stream;

    if (stream !== null && stream !== undefined) {
      const decoded = decodeStream(
        document.objects.get(single)?.dict ?? '',
        stream,
      );

      if (decoded !== null) {
        contents.push(decoded);
      }
    }

    return contents;
  }

  for (const reference of readDictRefs(object.dict, 'Contents')) {
    const target = document.objects.get(reference);
    const decoded =
      target?.stream == null ? null : decodeStream(target.dict, target.stream);

    if (decoded !== null) {
      contents.push(decoded);
    }
  }

  return contents;
}

/** Применяет фильтры потока (поддержан только FlateDecode). */
function decodeStream(dict: string, stream: Buffer): Buffer | null {
  const filters = readDictNames(dict, 'Filter');

  if (filters.length === 0) {
    return stream;
  }

  let data = stream;

  for (const filter of filters) {
    if (filter !== 'FlateDecode' && filter !== 'Fl') {
      return null;
    }

    const inflated = inflate(data);

    if (inflated === null) {
      return null;
    }

    data = inflated;
  }

  return data;
}

/** zlib-поток с fallback на raw deflate. */
function inflate(data: Buffer): Buffer | null {
  try {
    return inflateSync(data);
  } catch {
    try {
      return inflateRawSync(data);
    } catch {
      return null;
    }
  }
}

/** Шрифты страницы: имя → кодировка и ToUnicode. */
function readPageFonts(
  document: PdfDocument,
  pageDict: string,
): Map<string, PdfFont> {
  const fonts = new Map<string, PdfFont>();
  const resources = resolveInlineOrRef(document, pageDict, 'Resources');

  if (resources === null) {
    return fonts;
  }

  const fontDict = resolveInlineOrRef(document, resources, 'Font');

  if (fontDict === null) {
    return fonts;
  }

  const entryPattern = /\/([A-Za-z0-9#_.+-]+)\s+(\d+)\s+\d+\s+R/g;

  let entry: RegExpExecArray | null;

  while ((entry = entryPattern.exec(fontDict)) !== null) {
    const name = entry[1] ?? '';
    const reference = Number.parseInt(entry[2] ?? '', 10);
    const fontObject = document.objects.get(reference);

    if (fontObject === undefined) {
      continue;
    }

    const subtype = readDictName(fontObject.dict, 'Subtype');
    const toUnicodeRef = readDictRef(fontObject.dict, 'ToUnicode');
    const cmap =
      toUnicodeRef === null
        ? null
        : parseToUnicode(document.objects.get(toUnicodeRef));

    fonts.set(`/${name}`, {
      twoByte: subtype === 'Type0' || subtype === 'Type2',
      cmap,
    });
  }

  return fonts;
}

/** Разбирает CMap `/ToUnicode`: `bfchar` и `bfrange`. */
function parseToUnicode(object: PdfRawObject | undefined): Map<string, string> | null {
  if (object?.stream == null) {
    return null;
  }

  const decoded = decodeStream(object.dict, object.stream);

  if (decoded === null) {
    return null;
  }

  const text = decoded.toString('latin1');
  const cmap = new Map<string, string>();

  for (const block of sections(text, 'beginbfchar', 'endbfchar')) {
    const pairPattern = /<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>/g;

    let pair: RegExpExecArray | null;

    while ((pair = pairPattern.exec(block)) !== null) {
      const source = normalizeHex(pair[1] ?? '');
      const target = decodeUtf16Be(pair[2] ?? '');

      if (source !== '' && target !== '') {
        cmap.set(source, target);
      }
    }
  }

  for (const block of sections(text, 'beginbfrange', 'endbfrange')) {
    const rangePattern =
      /<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>\s*(?:<([0-9A-Fa-f]+)>|\[([^\]]*)\])/g;

    let range: RegExpExecArray | null;

    while ((range = rangePattern.exec(block)) !== null) {
      const from = Number.parseInt(range[1] ?? '0', 16);
      const to = Number.parseInt(range[2] ?? '0', 16);
      const width = normalizeHex(range[1] ?? '').length;

      if (!Number.isFinite(from) || !Number.isFinite(to) || to < from) {
        continue;
      }

      if (range[3] !== undefined) {
        const base = range[3];

        for (let code = from; code <= Math.min(to, from + 65_535); code += 1) {
          cmap.set(
            code.toString(16).toUpperCase().padStart(width, '0'),
            decodeUtf16Be(incrementHex(base, code - from)),
          );
        }

        continue;
      }

      const list = [...(range[4] ?? '').matchAll(/<([0-9A-Fa-f]+)>/g)].map(
        (item) => item[1] ?? '',
      );

      list.forEach((target, offset) => {
        const code = from + offset;

        if (code <= to) {
          cmap.set(
            code.toString(16).toUpperCase().padStart(width, '0'),
            decodeUtf16Be(target),
          );
        }
      });
    }
  }

  return cmap.size === 0 ? null : cmap;
}

/** Блоки между `begin`/`end` (многострочные секции CMap). */
function sections(text: string, begin: string, end: string): string[] {
  const pattern = new RegExp(`${begin}([\\s\\S]*?)${end}`, 'g');
  const blocks: string[] = [];

  let match: RegExpExecArray | null;

  while ((match = pattern.exec(text)) !== null) {
    blocks.push(match[1] ?? '');
  }

  return blocks;
}

/** UTF-16BE hex → строка (суррогатные пары поддерживаются). */
function decodeUtf16Be(hex: string): string {
  const normalized = normalizeHex(hex);

  if (normalized === '') {
    return '';
  }

  const bytes = Buffer.from(normalized, 'hex');
  const swapped = Buffer.from(bytes);

  swapped.swap16();

  return swapped.toString('utf16le');
}

/** Прибавляет смещение к последнему байту hex-строки (правило bfrange). */
function incrementHex(hex: string, delta: number): string {
  const normalized = normalizeHex(hex);

  if (normalized === '') {
    return '';
  }

  const value = Number.parseInt(normalized, 16) + delta;

  return value.toString(16).toUpperCase().padStart(normalized.length, '0');
}

/** Чётная hex-строка в верхнем регистре. */
function normalizeHex(raw: string): string {
  const trimmed = raw.trim();

  if (trimmed === '' || trimmed.length % 2 !== 0 || !/^[0-9A-Fa-f]+$/.test(trimmed)) {
    return '';
  }

  return trimmed.toUpperCase();
}

/**
 * Интерпретирует потоки содержимого и собирает позиционированный текст.
 *
 * Ширина глифа не читается из `/Widths`: для разметки строк и колонок
 * достаточно приблизительной оценки 0.5·размер шрифта на символ.
 */
function interpretContent(
  contents: readonly Buffer[],
  fonts: ReadonlyMap<string, PdfFont>,
  warnings: string[],
  pageNumber: number,
): PdfTextItem[] {
  const items: PdfTextItem[] = [];
  let font: PdfFont | undefined;
  let fontSize = 12;
  let leading = 0;
  let matrix = { x: 0, y: 0 };
  let operands: Operand[] = [];
  let inText = false;
  const reported = new Set<string>();

  for (const content of contents) {
    const tokens = tokenize(content.toString('latin1'));

    for (const token of tokens) {
      if (token.kind !== 'operator') {
        operands.push(token.value);

        continue;
      }

      const operator = token.value;

      if (typeof operator !== 'string') {
        operands = [];

        continue;
      }

      switch (operator) {
        case 'BT':
          inText = true;
          matrix = { x: 0, y: 0 };
          break;
        case 'ET':
          inText = false;
          break;
        case 'Tf': {
          const name = operands.find(
            (operand): operand is string => typeof operand === 'string',
          );
          const size = operands.find(
            (operand): operand is number => typeof operand === 'number',
          );

          if (name !== undefined) {
            font = fonts.get(name);
          }

          if (size !== undefined && size > 0) {
            fontSize = size;
          }

          break;
        }
        case 'TL': {
          const value = operands.find(
            (operand): operand is number => typeof operand === 'number',
          );

          if (value !== undefined) {
            leading = value;
          }

          break;
        }
        case 'Td':
        case 'TD': {
          const [tx, ty] = numericPair(operands);

          matrix = { x: matrix.x + tx, y: matrix.y + ty };

          if (operator === 'TD') {
            leading = -ty;
          }

          break;
        }
        case 'Tm': {
          const numbers = operands.filter(
            (operand): operand is number => typeof operand === 'number',
          );

          if (numbers.length >= 6) {
            matrix = {
              x: numbers[4] ?? matrix.x,
              y: numbers[5] ?? matrix.y,
            };
          }

          break;
        }
        case 'T*':
          matrix = { x: matrix.x, y: matrix.y - leading };
          break;
        case 'Tz':
        case 'Tc':
        case 'Tw':
        case 'Ts':
        case 'Tr':
          // Межбуквенный/межсловный интервал и режим отрисовки на разметку
          // строк и колонок не влияют.
          break;
        case 'Tj':
        case 'TJ':
        case "'":
        case '"': {
          if (operator === "'" || operator === '"') {
            matrix = { x: matrix.x, y: matrix.y - leading };
          }

          if (!inText) {
            break;
          }

          const emitted = showText(operands, font, fontSize, matrix);

          for (const item of emitted.items) {
            if (item.text.trim() !== '') {
              items.push(item);
            }
          }

          matrix = { x: matrix.x + emitted.advance, y: matrix.y };
          break;
        }
        default:
          if (!reported.has(operator) && operator.startsWith('T')) {
            reported.add(operator);
            warnings.push(
              `страница ${pageNumber}: оператор ${operator} не поддержан`,
            );
          }
      }

      operands = [];
    }
  }

  return items;
}

/** Разбирает операнды `Tj`/`TJ` и возвращает фрагменты с шириной. */
function showText(
  operands: ReadonlyArray<Operand>,
  font: PdfFont | undefined,
  fontSize: number,
  matrix: { readonly x: number; readonly y: number },
): { items: PdfTextItem[]; advance: number } {
  const items: PdfTextItem[] = [];
  let advance = 0;
  let buffer = '';

  const flush = (): void => {
    if (buffer === '') {
      return;
    }

    items.push({
      x: matrix.x + advance,
      y: matrix.y,
      size: fontSize,
      text: buffer,
    });
    advance += buffer.length * fontSize * 0.5;
    buffer = '';
  };

  for (const operand of operands) {
    if (typeof operand === 'number') {
      // Отрицательный кернинг-сдвиг в TJ увеличивает межбуквенный просвет.
      advance += (-operand / 1_000) * fontSize;

      continue;
    }

    if (typeof operand === 'string') {
      buffer += decodeShowString(operand, font);

      continue;
    }

    for (const nested of operand) {
      if (typeof nested === 'number') {
        advance += (-nested / 1_000) * fontSize;
      } else if (typeof nested === 'string') {
        buffer += decodeShowString(nested, font);
      }
    }
  }

  flush();

  return { items, advance };
}

/** Декодирует байты строки показа через ToUnicode или WinAnsi. */
function decodeShowString(raw: string, font: PdfFont | undefined): string {
  const bytes = Buffer.from(raw, 'latin1');
  const twoByte = font?.twoByte === true;
  const step = twoByte ? 2 : 1;
  let result = '';

  for (let index = 0; index + step <= bytes.length; index += step) {
    const slice = bytes.subarray(index, index + step);
    const key = slice.toString('hex').toUpperCase();
    const mapped = font?.cmap?.get(key);

    if (mapped !== undefined) {
      result += mapped;

      continue;
    }

    result += twoByte
      ? Buffer.from([...slice].reverse()).toString('utf16le')
      : decodeWinAnsi(slice[0] ?? 0);
  }

  return result;
}

/** WinAnsi/Latin-1 для простых шрифтов без ToUnicode. */
function decodeWinAnsi(code: number): string {
  const special = WIN_ANSI_SPECIAL[code];

  return special ?? String.fromCharCode(code);
}

const WIN_ANSI_SPECIAL: Readonly<Record<number, string>> = {
  0x80: '€',
  0x82: '‚',
  0x83: 'ƒ',
  0x84: '„',
  0x85: '…',
  0x86: '†',
  0x87: '‡',
  0x88: 'ˆ',
  0x89: '‰',
  0x8a: 'Š',
  0x8b: '‹',
  0x8c: 'Œ',
  0x8e: 'Ž',
  0x91: '‘',
  0x92: '’',
  0x93: '“',
  0x94: '”',
  0x95: '•',
  0x96: '–',
  0x97: '—',
  0x98: '˜',
  0x99: '™',
  0x9a: 'š',
  0x9b: '›',
  0x9c: 'œ',
  0x9e: 'ž',
  0x9f: 'Ÿ',
};

type Token =
  | { readonly kind: 'operand'; readonly value: Operand }
  | { readonly kind: 'operator'; readonly value: string };

/** Операнд потока содержимого: число, строка или вложенный массив. */
type Operand = number | string | Operand[];

/** Токенизатор потока содержимого PDF. */
function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  const stack: Array<{ readonly array: Operand[] }> = [];
  let index = 0;

  const push = (value: Operand): void => {
    const top = stack.at(-1);

    if (top === undefined) {
      tokens.push({ kind: 'operand', value });

      return;
    }

    top.array.push(value);
  };

  while (index < source.length) {
    const char = source[index] ?? '';

    if (char === '%') {
      while (index < source.length && source[index] !== '\n') {
        index += 1;
      }

      continue;
    }

    if (/\s/.test(char)) {
      index += 1;

      continue;
    }

    if (char === '(') {
      const parsed = readLiteralString(source, index);

      push(parsed.value);
      index = parsed.next;
      continue;
    }

    if (char === '<' && source[index + 1] === '<') {
      // Словарь внутри контента (например, маркерный `/DP << ... >>`) — пропуск.
      index = skipBalanced(source, index + 2, '<<', '>>');
      continue;
    }

    if (char === '<') {
      const end = source.indexOf('>', index + 1);
      const hex = end === -1 ? '' : source.slice(index + 1, end);
      const parsed = readHexString(hex);

      push(parsed);
      index = end === -1 ? source.length : end + 1;
      continue;
    }

    if (char === '[') {
      stack.push({ array: [] });
      index += 1;
      continue;
    }

    if (char === ']') {
      const completed = stack.pop();

      if (completed !== undefined) {
        push(completed.array);
      }

      index += 1;
      continue;
    }

    if (char === '/') {
      const nameMatch = /^\/([^\s/[\]<>(){}%]*)/.exec(source.slice(index));
      const name = nameMatch?.[1] ?? '';

      push(`/${name}`);
      index += 1 + name.length;
      continue;
    }

    const numberMatch = /^[+-]?(?:\d+\.?\d*|\.\d+)/.exec(source.slice(index));

    if (numberMatch !== null) {
      push(Number.parseFloat(numberMatch[0]));
      index += numberMatch[0].length;
      continue;
    }

    const wordMatch = /^[A-Za-z'"*][A-Za-z0-9'"*]*/.exec(source.slice(index));

    if (wordMatch !== null) {
      const word = wordMatch[0];

      if (word === 'true' || word === 'false' || word === 'null') {
        push(word);
      } else {
        tokens.push({ kind: 'operator', value: word });
      }

      index += word.length;
      continue;
    }

    // Неизвестный символ: пропускаем, чтобы не зациклиться.
    index += 1;
  }

  return tokens;
}

/** Литеральная строка `( ... )` с экранированием и вложенными скобками. */
function readLiteralString(
  source: string,
  start: number,
): { value: string; next: number } {
  let depth = 0;
  let index = start;

  while (index < source.length) {
    const char = source[index];

    if (char === '\\') {
      index += 2;
      continue;
    }

    if (char === '(') {
      depth += 1;
    } else if (char === ')') {
      depth -= 1;

      if (depth === 0) {
        return {
          value: unescapeLiteral(source.slice(start + 1, index)),
          next: index + 1,
        };
      }
    }

    index += 1;
  }

  return {
    value: unescapeLiteral(source.slice(start + 1)),
    next: source.length,
  };
}

/** Разэкранирует литеральную строку PDF. */
function unescapeLiteral(raw: string): string {
  let result = '';

  for (let index = 0; index < raw.length; index += 1) {
    const char = raw[index];

    if (char !== '\\') {
      result += char;
      continue;
    }

    const next = raw[index + 1];

    if (next === undefined) {
      break;
    }

    index += 1;

    switch (next) {
      case 'n':
        result += '\n';
        break;
      case 'r':
        result += '\r';
        break;
      case 't':
        result += '\t';
        break;
      case 'b':
        result += '\b';
        break;
      case 'f':
        result += '\f';
        break;
      case '(':
      case ')':
      case '\\':
        result += next;
        break;
      default: {
        const octal = /^[0-7]{1,3}/.exec(raw.slice(index));

        if (octal !== null) {
          result += String.fromCharCode(Number.parseInt(octal[0], 8));
          index += octal[0].length - 1;
        } else {
          result += next;
        }
      }
    }
  }

  return result;
}

/** Hex-строка `<...>` → байты в latin1 (по два hex-символа на байт). */
function readHexString(hex: string): string {
  const digits = hex.replace(/[^0-9A-Fa-f]/g, '');
  const padded = digits.length % 2 === 0 ? digits : `${digits}0`;
  const bytes: number[] = [];

  for (let index = 0; index < padded.length; index += 2) {
    bytes.push(Number.parseInt(padded.slice(index, index + 2), 16));
  }

  return Buffer.from(bytes).toString('latin1');
}

/** Пропускает сбалансированную конструкцию (`<<...>>`). */
function skipBalanced(
  source: string,
  start: number,
  open: string,
  close: string,
): number {
  let depth = 1;
  let index = start;

  while (index < source.length && depth > 0) {
    if (source.startsWith(open, index)) {
      depth += 1;
      index += open.length;
      continue;
    }

    if (source.startsWith(close, index)) {
      depth -= 1;
      index += close.length;
      continue;
    }

    index += 1;
  }

  return index;
}

/** Первая пара чисел из операндов (Td/TD). */
function numericPair(
  operands: ReadonlyArray<Operand>,
): [number, number] {
  const numbers = operands.filter(
    (operand): operand is number => typeof operand === 'number',
  );

  return [numbers[0] ?? 0, numbers[1] ?? 0];
}

/** Группирует фрагменты в строки и ячейки. */
function buildLines(items: readonly PdfTextItem[]): PdfTextLine[] {
  const sorted = [...items].sort((left, right) => {
    if (Math.abs(left.y - right.y) > 0.5) {
      return right.y - left.y;
    }

    return left.x - right.x;
  });
  const lines: Array<{ y: number; size: number; items: PdfTextItem[] }> = [];

  for (const item of sorted) {
    const tolerance = Math.max(1.5, item.size * 0.5);
    const line = lines.find(
      (candidate) => Math.abs(candidate.y - item.y) <= tolerance,
    );

    if (line === undefined) {
      lines.push({ y: item.y, size: item.size, items: [item] });
    } else {
      line.items.push(item);
    }
  }

  return lines
    .sort((left, right) => right.y - left.y)
    .map((line) => {
      const ordered = [...line.items].sort((left, right) => left.x - right.x);
      const cells: string[] = [];
      let current = '';
      let previousEnd: number | null = null;

      for (const item of ordered) {
        const gap = previousEnd === null ? 0 : item.x - previousEnd;
        const threshold = Math.max(
          CELL_GAP_MIN,
          line.size * CELL_GAP_FACTOR,
        );

        if (previousEnd !== null && gap >= threshold) {
          cells.push(current.trim());
          current = '';
        } else if (current !== '' && !current.endsWith(' ')) {
          current += ' ';
        }

        current += item.text;
        previousEnd = item.x + item.text.length * item.size * 0.5;
      }

      if (current !== '') {
        cells.push(current.trim());
      }

      const cleaned = cells.filter((cell) => cell !== '');

      return {
        y: line.y,
        text: cleaned.join('  ').trim(),
        cells: cleaned,
      };
    })
    .filter((line) => line.text !== '');
}

/** Восстанавливает таблицы по выровненным строкам с несколькими ячейками. */
function detectTables(
  lines: readonly PdfTextLine[],
  pageNumber: number,
): PdfTable[] {
  const tables: PdfTable[] = [];
  let block: PdfTextLine[] = [];

  const flush = (): void => {
    if (block.length >= 2) {
      const rows = block.map((line) => [...line.cells]);
      const firstCount = rows[0]?.length ?? 0;
      const aligned = rows.every(
        (row) => row.length === firstCount && row.length >= 2,
      );

      if (aligned && firstCount >= 2) {
        tables.push({ page: pageNumber, rows });
      }
    }

    block = [];
  };

  for (const line of lines) {
    if (line.cells.length >= 2) {
      block.push(line);
      continue;
    }

    flush();
  }

  flush();

  return tables;
}

/** Словарь по ссылке или inline-словарь после ключа. */
function resolveInlineOrRef(
  document: PdfDocument,
  dict: string,
  key: string,
): string | null {
  const reference = readDictRef(dict, key);

  if (reference !== null) {
    return document.objects.get(reference)?.dict ?? null;
  }

  return readInlineDict(dict, key);
}

/** Inline-словарь `<< ... >>` после `/Key`. */
function readInlineDict(dict: string, key: string): string | null {
  const pattern = new RegExp(`/${key}\\s*<<`);
  const match = pattern.exec(dict);

  if (match === null) {
    return null;
  }

  const start = match.index + match[0].length - 2;
  const end = skipBalanced(dict, start + 2, '<<', '>>');

  return dict.slice(start, end);
}

/** Значение-имя: `/Key /Name`. */
function readDictName(dict: string, key: string): string | null {
  const pattern = new RegExp(`/${key}\\s*/([A-Za-z0-9_.+-]+)`);
  const match = pattern.exec(dict);

  return match?.[1] ?? null;
}

/** Все имена для ключа: `/Key /A` или `/Key [ /A /B ]`. */
function readDictNames(dict: string, key: string): string[] {
  const inline = readDictName(dict, key);

  if (inline !== null) {
    return [inline];
  }

  const arrayPattern = new RegExp(`/${key}\\s*\\[([^\\]]*)\\]`);
  const match = arrayPattern.exec(dict);

  if (match === null) {
    return [];
  }

  return [...(match[1] ?? '').matchAll(/\/([A-Za-z0-9_.+-]+)/g)].map(
    (item) => item[1] ?? '',
  );
}

/** Числовое значение: `/Key 12`. */
function readDictNumber(dict: string, key: string): number | null {
  const pattern = new RegExp(`/${key}\\s+(\\d+)(?!\\s+\\d+\\s+R)`);
  const match = pattern.exec(dict);

  if (match?.[1] === undefined) {
    return null;
  }

  const value = Number.parseInt(match[1], 10);

  return Number.isInteger(value) ? value : null;
}

/** Ссылка на объект: `/Key N 0 R`. */
function readDictRef(dict: string, key: string): number | null {
  const pattern = new RegExp(`/${key}\\s+(\\d+)\\s+\\d+\\s+R`);
  const match = pattern.exec(dict);
  const parsed = match?.[1] === undefined ? Number.NaN : Number.parseInt(match[1], 10);

  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

/** Массив ссылок: `/Key [ N 0 R ... ]`. */
function readDictRefs(dict: string, key: string): number[] {
  const single = readDictRef(dict, key);

  if (single !== null) {
    return [single];
  }

  const arrayPattern = new RegExp(`/${key}\\s*\\[([^\\]]*)\\]`);
  const match = arrayPattern.exec(dict);

  if (match === null) {
    return [];
  }

  const references: number[] = [];

  for (const item of (match[1] ?? '').matchAll(/(\d+)\s+\d+\s+R/g)) {
    references.push(Number.parseInt(item[1] ?? '', 10));
  }

  return references.filter((value) => Number.isInteger(value) && value > 0);
}

/** Метаданные `/Info`. */
function readMetadata(document: PdfDocument): PdfExtractionResult['metadata'] {
  const info = [...document.objects.values()].find((object) =>
    /^\s*<<[\s\S]*\/Producer\b/.test(object.dict),
  );

  if (info === undefined) {
    return { title: null, producer: null, creator: null };
  }

  return {
    title: readTextValue(info.dict, 'Title'),
    producer: readTextValue(info.dict, 'Producer'),
    creator: readTextValue(info.dict, 'Creator'),
  };
}

/** Текстовое значение `/Key ( ... )` или `/Key <hex>`. */
function readTextValue(dict: string, key: string): string | null {
  const literal = new RegExp(`/${key}\\s*\\(([^)]*)\\)`).exec(dict);

  if (literal !== null) {
    const value = unescapeLiteral(literal[1] ?? '').trim();

    return value === '' ? null : value;
  }

  const hex = new RegExp(`/${key}\\s*<([0-9A-Fa-f]+)>`).exec(dict);

  if (hex === null) {
    return null;
  }

  const value = decodeUtf16Be(hex[1] ?? '').trim();

  return value === '' ? null : value;
}

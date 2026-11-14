import { parseResumeJson, type ResumeCandidate } from './resume';

/**
 * Разметка ответа агента.
 *
 * Агенты Sprint 20 возвращают результат текстом, поэтому UI сам разбирает
 * три конструкции, не подключая Markdown-парсер:
 *
 * - ```` ```lang … ``` ```` — блок кода с подписью языка;
 * - таблицу в «pipe»-стиле (`| A | B |` + разделитель `| --- | --- |`);
 * - JSON `resume-screener` (в fence `json` или целиком в ответе) — карточки.
 *
 * Всё остальное остаётся текстом: рендерятся только известные конструкции,
 * поэтому текст агента не может подставить произвольную разметку.
 */

export interface MessageTable {
  columns: string[];
  rows: string[][];
  /** Видимый заголовок таблицы, если он есть у разобранного документа. */
  title?: string;
}

export type MessageBlock =
  | { type: 'text'; text: string }
  | { type: 'code'; language: string; code: string }
  | { type: 'table'; table: MessageTable }
  | { type: 'resume'; resume: ResumeCandidate };

/** Линия открытия/закрытия блока кода: ``` или ```ts. */
const FENCE_LINE = /^\s*```([A-Za-z0-9_+#.-]*)\s*$/;

/** Разделитель таблицы: `| --- | :---: |`. */
const TABLE_SEPARATOR = /^\s*\|?\s*:?-{3,}:?\s*(?:\|\s*:?-{3,}:?\s*)+\|?\s*$/;

/** Языки fence'а, в которых ищем JSON резюме. */
const JSON_LANGUAGES = new Set(['', 'json', 'jsonc']);

function isTableLine(line: string): boolean {
  return line.includes('|');
}

/** Ячейки строки таблицы без внешних `|`; `\|` считается экранированием. */
function splitTableRow(line: string): string[] {
  const trimmed = line.trim().replace(/^\|/, '').replace(/\|$/, '');

  return trimmed.split('|').map((cell) => cell.replace(/\\\|/g, '|').trim());
}

function isTableSeparator(line: string): boolean {
  return TABLE_SEPARATOR.test(line);
}

/** Заголовок таблицы: не меньше двух колонок и следующая строка-разделитель. */
function isTableHeader(line: string): boolean {
  return isTableLine(line) && splitTableRow(line).length >= 2;
}

/** Добивает/обрезает строку до ширины заголовка — таблица не «съезжает». */
function normalizeRow(cells: string[], width: number): string[] {
  if (cells.length === width) {
    return cells;
  }

  if (cells.length > width) {
    return cells.slice(0, width);
  }

  return [...cells, ...Array<string>(width - cells.length).fill('')];
}

function trimBlankLines(text: string): string {
  return text.replace(/^\n+/, '').replace(/\n+$/, '');
}

function pushText(blocks: MessageBlock[], lines: string[]): void {
  const text = trimBlankLines(lines.join('\n'));

  if (text !== '') {
    blocks.push({ type: 'text', text });
  }
}

/** Делит текстовый фрагмент на абзацы и таблицы. */
function splitTextTables(lines: string[]): MessageBlock[] {
  const blocks: MessageBlock[] = [];
  let textLines: string[] = [];
  let index = 0;

  while (index < lines.length) {
    const line = lines[index] ?? '';
    const separator = lines[index + 1];

    if (
      separator !== undefined &&
      isTableHeader(line) &&
      isTableSeparator(separator)
    ) {
      const columns = splitTableRow(line);

      if (splitTableRow(separator).length !== columns.length) {
        textLines.push(line);
        index += 1;
        continue;
      }

      pushText(blocks, textLines);
      textLines = [];

      const rows: string[][] = [];
      let cursor = index + 2;

      while (cursor < lines.length && isTableLine(lines[cursor] ?? '')) {
        const row = lines[cursor] ?? '';

        if (isTableSeparator(row)) {
          break;
        }

        rows.push(normalizeRow(splitTableRow(row), columns.length));
        cursor += 1;
      }

      blocks.push({ type: 'table', table: { columns, rows } });
      index = cursor;
      continue;
    }

    textLines.push(line);
    index += 1;
  }

  pushText(blocks, textLines);

  return blocks;
}

function parseResumeFence(
  language: string,
  code: string,
): ResumeCandidate | null {
  return JSON_LANGUAGES.has(language) ? parseResumeJson(code) : null;
}

/**
 * Разбирает ответ агента на блоки.
 *
 * Незакрытый fence (ответ ещё стримится) остаётся текстом: так не мигает
 * блок кода, пока модель дописывает последние строки.
 */
export function parseMessageBlocks(content: string): MessageBlock[] {
  const trimmed = content.trim();

  if (trimmed.startsWith('{')) {
    const resume = parseResumeJson(trimmed);

    if (resume !== null) {
      return [{ type: 'resume', resume }];
    }
  }

  const lines = content.split('\n');
  const blocks: MessageBlock[] = [];
  let textLines: string[] = [];
  let index = 0;

  while (index < lines.length) {
    const line = lines[index] ?? '';
    const fence = FENCE_LINE.exec(line);

    if (fence === null) {
      textLines.push(line);
      index += 1;
      continue;
    }

    const language = (fence[1] ?? '').toLowerCase();
    const codeLines: string[] = [];
    let closingIndex = -1;

    for (let cursor = index + 1; cursor < lines.length; cursor += 1) {
      const candidate = lines[cursor] ?? '';

      if (FENCE_LINE.test(candidate)) {
        closingIndex = cursor;
        break;
      }

      codeLines.push(candidate);
    }

    if (closingIndex === -1) {
      textLines.push(...lines.slice(index));
      break;
    }

    blocks.push(...splitTextTables(textLines));
    textLines = [];

    const code = codeLines.join('\n');
    const resume = parseResumeFence(language, code);

    if (resume !== null) {
      blocks.push({ type: 'resume', resume });
    } else {
      blocks.push({ type: 'code', language, code });
    }

    index = closingIndex + 1;
  }

  blocks.push(...splitTextTables(textLines));

  return blocks.length === 0 ? [{ type: 'text', text: content }] : blocks;
}

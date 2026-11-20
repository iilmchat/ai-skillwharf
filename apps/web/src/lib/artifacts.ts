import { z } from 'zod';
import { api } from './api';
import { parseMessageBlocks, type MessageTable } from './message-blocks';

/**
 * Контракт структурированных артефактов и точечного редактирования (Sprint 37,
 * UX-37.1). Схемы повторяют контракт API: лишние поля от сервера отсекаются,
 * поэтому UI не зависит от внутренних полей создателя артефакта.
 */
export const artifactItemSchema = z
  .object({
    id: z.string().min(1),
    type: z.enum(['document', 'table', 'code']),
    title: z.string().min(1),
    language: z.string().optional(),
    content: z.string(),
  })
  .strict();

export const executionStepSchema = z
  .object({
    stepIndex: z.number().int().nonnegative(),
    name: z.string().min(1),
    toolName: z.string().optional(),
    durationMs: z.number().nonnegative(),
    status: z.enum(['completed', 'failed', 'hitl_paused']),
    costRub: z.number().nonnegative().optional(),
  })
  .strict();

export type ArtifactItem = z.infer<typeof artifactItemSchema>;
export type ArtifactType = ArtifactItem['type'];
export type ExecutionStep = z.infer<typeof executionStepSchema>;
export type ExecutionStepStatus = ExecutionStep['status'];

/** Путь относительно `api` (`/api/v1` задаётся в `lib/api.ts`). */
export const ARTIFACT_REFINEMENT_ENDPOINT = '/chat/artifacts/refine';

export const refineArtifactRequestSchema = z
  .object({
    artifactType: z.enum(['document', 'table', 'code']),
    title: z.string().trim().min(1).max(200),
    fullContent: z.string().min(1).max(100_000),
    selectedText: z.string().min(1).max(20_000),
    instruction: z.string().trim().min(1).max(2_000),
  })
  .strict()
  .refine((value) => value.fullContent.includes(value.selectedText), {
    message: 'selectedText должен быть фрагментом fullContent',
    path: ['selectedText'],
  });

export const refineArtifactResponseSchema = z
  .object({
    updatedContent: z.string().min(1),
    summary: z.string().min(1).max(1_000),
  })
  .strict();

export type RefineArtifactRequest = z.infer<typeof refineArtifactRequestSchema>;
export type RefineArtifactResponse = z.infer<typeof refineArtifactResponseSchema>;

/**
 * Отправляет выделенный фрагмент на точечную правку.
 *
 * Запрос валидируется до сети: пустой фрагмент или фрагмент вне содержимого
 * артефакта не должен расходовать токены. Ответ проверяется Zod — UI получает
 * только оптимизированный текст и краткое резюме правки.
 */
export async function refineArtifact(
  input: RefineArtifactRequest,
): Promise<RefineArtifactResponse> {
  const request = refineArtifactRequestSchema.parse(input);
  const { data } = await api.post<unknown>(ARTIFACT_REFINEMENT_ENDPOINT, request);

  return refineArtifactResponseSchema.parse(data);
}

/* ------------------------------------------------------------------------- */
/* Экспорт артефактов без тяжёлых зависимостей                                */
/* ------------------------------------------------------------------------- */

export const ARTIFACT_MIME_TYPES = {
  md: 'text/markdown',
  csv: 'text/csv',
  html: 'text/html',
  doc: 'application/msword',
} as const;

function splitCsvLine(line: string, delimiter: string): string[] {
  const cells: string[] = [];
  let cell = '';
  let quoted = false;

  for (let index = 0; index < line.length; index += 1) {
    const char = line[index] ?? '';

    if (char === '"') {
      if (quoted && line[index + 1] === '"') {
        cell += '"';
        index += 1;
      } else {
        quoted = !quoted;
      }
      continue;
    }

    if (char === delimiter && !quoted) {
      cells.push(cell);
      cell = '';
      continue;
    }

    cell += char;
  }

  cells.push(cell);

  return cells.map((value) => value.trim());
}

/**
 * Таблица артефакта: сначала «pipe»-разметка Markdown (как в чате), затем CSV
 * с запятой или точкой с запятой — российские выгрузки часто используют `;`.
 */
export function parseArtifactTable(content: string): MessageTable | null {
  for (const block of parseMessageBlocks(content)) {
    if (block.type === 'table') {
      return block.table;
    }
  }

  const lines = content
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== '');
  const header = lines[0];

  if (header === undefined) {
    return null;
  }

  const delimiter = header.includes(';') && !header.includes(',') ? ';' : ',';
  const columns = splitCsvLine(header, delimiter);

  if (columns.length < 2) {
    return null;
  }

  const width = columns.length;
  const rows = lines.slice(1).map((line) => {
    const cells = splitCsvLine(line, delimiter);

    return Array.from({ length: width }, (_, index) => cells[index] ?? '');
  });

  return { columns, rows };
}

function csvCell(value: string): string {
  return /[",;\r\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

function tableToCsv(table: MessageTable): string {
  const rows = [table.columns, ...table.rows];

  return `${rows.map((row) => row.map(csvCell).join(',')).join('\r\n')}\r\n`;
}

function tableToPipeMarkdown(table: MessageTable): string {
  const header = `| ${table.columns.join(' | ')} |`;
  const separator = `| ${table.columns.map(() => '---').join(' | ')} |`;
  const rows = table.rows.map((row) => `| ${row.join(' | ')} |`);

  return [header, separator, ...rows].join('\n');
}

/** Markdown-файл: заголовок артефакта и содержимое в понятном виде. */
export function artifactToMarkdown(artifact: ArtifactItem): string {
  const heading = `# ${artifact.title}\n\n`;

  if (artifact.type === 'code') {
    const language = artifact.language ?? '';

    return `${heading}\`\`\`${language}\n${artifact.content}\n\`\`\`\n`;
  }

  if (artifact.type === 'table') {
    const table = parseArtifactTable(artifact.content);

    return `${heading}${table === null ? artifact.content.trimEnd() : tableToPipeMarkdown(table)}\n`;
  }

  return `${heading}${artifact.content.trimEnd()}\n`;
}

/** CSV доступен только для таблиц; остальные типы явной ошибкой. */
export function artifactToCsv(artifact: ArtifactItem): string {
  if (artifact.type !== 'table') {
    throw new Error('CSV export is available for table artifacts only');
  }

  const table = parseArtifactTable(artifact.content);

  return table === null
    ? `${artifact.content.trimEnd()}\r\n`
    : tableToCsv(table);
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function inlineHtml(text: string): string {
  return escapeHtml(text)
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/`([^`]+)`/g, '<code>$1</code>');
}

function tableToHtml(table: MessageTable): string {
  const head = table.columns
    .map((column) => `<th>${escapeHtml(column)}</th>`)
    .join('');
  const body = table.rows
    .map(
      (row) =>
        `<tr>${row.map((cell) => `<td>${escapeHtml(cell)}</td>`).join('')}</tr>`,
    )
    .join('');

  return `<table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>`;
}

/**
 * Ограниченный Markdown → HTML: заголовки, списки, код, таблицы и инлайн-
 * выделение. Весь текст экранируется, поэтому содержимое артефакта не может
 * подставить произвольный HTML в печатную версию.
 */
function markdownToHtml(content: string): string {
  const lines = content.split(/\r?\n/);
  const parts: string[] = [];
  let listItems: string[] = [];
  let listOrdered = false;

  const flushList = (): void => {
    if (listItems.length === 0) {
      return;
    }

    const tag = listOrdered ? 'ol' : 'ul';

    parts.push(
      `<${tag}>${listItems.map((item) => `<li>${inlineHtml(item)}</li>`).join('')}</${tag}>`,
    );
    listItems = [];
  };

  let index = 0;

  while (index < lines.length) {
    const line = lines[index] ?? '';

    if (line.trim() === '') {
      flushList();
      index += 1;
      continue;
    }

    const fence = /^\s*```([A-Za-z0-9_+#.-]*)\s*$/.exec(line);

    if (fence !== null) {
      flushList();
      const code: string[] = [];
      let cursor = index + 1;

      while (cursor < lines.length && !/^\s*```\s*$/.test(lines[cursor] ?? '')) {
        code.push(lines[cursor] ?? '');
        cursor += 1;
      }

      const language = escapeHtml(fence[1] ?? '');

      parts.push(
        `<pre><code${language === '' ? '' : ` class="language-${language}"`}>${escapeHtml(code.join('\n'))}</code></pre>`,
      );
      index = cursor + 1;
      continue;
    }

    if (
      line.includes('|') &&
      index + 1 < lines.length &&
      /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?\s*$/.test(
        lines[index + 1] ?? '',
      )
    ) {
      flushList();
      const tableLines: string[] = [];

      while (index < lines.length && (lines[index] ?? '').includes('|')) {
        tableLines.push(lines[index] ?? '');
        index += 1;
      }

      const table = parseArtifactTable(tableLines.join('\n'));

      parts.push(
        table === null
          ? `<pre>${escapeHtml(tableLines.join('\n'))}</pre>`
          : tableToHtml(table),
      );
      continue;
    }

    const heading = /^\s*(#{1,6})\s+(.+)$/.exec(line);

    if (heading !== null) {
      flushList();
      const level = Math.min((heading[1] ?? '').length + 1, 6);

      parts.push(`<h${level}>${inlineHtml(heading[2] ?? '')}</h${level}>`);
      index += 1;
      continue;
    }

    const bullet = /^\s*[-*]\s+(.+)$/.exec(line);
    const numbered = /^\s*\d+[.)]\s+(.+)$/.exec(line);

    if (bullet !== null || numbered !== null) {
      const ordered = numbered !== null;

      if (listItems.length > 0 && listOrdered !== ordered) {
        flushList();
      }

      listOrdered = ordered;
      listItems.push((numbered ?? bullet)?.[1] ?? '');
      index += 1;
      continue;
    }

    flushList();
    parts.push(`<p>${inlineHtml(line)}</p>`);
    index += 1;
  }

  flushList();

  return parts.join('\n');
}

/** Подписи для реквизитов печатной версии (локализуются на странице). */
export interface ArtifactPrintLabels {
  lang: string;
  platform: string;
  generatedAt: string;
  typeLabel: string;
}

/**
 * Печатная HTML-версия: реквизиты, A4 и совместимая с Word разметка.
 * Файл можно сохранить как `.html` или как `.doc` без внешних библиотек.
 */
export function artifactToPrintHtml(
  artifact: ArtifactItem,
  labels: ArtifactPrintLabels,
): string {
  const title = escapeHtml(artifact.title);
  const body =
    artifact.type === 'table'
      ? (() => {
          const table = parseArtifactTable(artifact.content);

          return table === null
            ? `<pre>${escapeHtml(artifact.content)}</pre>`
            : tableToHtml(table);
        })()
      : artifact.type === 'code'
        ? `<pre><code class="language-${escapeHtml(artifact.language ?? '')}">${escapeHtml(artifact.content)}</code></pre>`
        : markdownToHtml(artifact.content);

  return [
    '<!DOCTYPE html>',
    `<html lang="${escapeHtml(labels.lang)}" xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:w="urn:schemas-microsoft-com:office:word" xmlns="http://www.w3.org/TR/REC-html40">`,
    '<head>',
    '<meta charset="utf-8">',
    `<title>${title}</title>`,
    '<!--[if gte mso 9]><xml><w:WordDocument><w:View>Print</w:View><w:Zoom>90</w:Zoom></w:WordDocument></xml><![endif]-->',
    '<style>',
    '@page { size: A4; margin: 2cm; }',
    'body { font-family: "Times New Roman", Arial, serif; font-size: 12pt; color: #111; }',
    '.requisites { border-bottom: 1px solid #666; margin-bottom: 18pt; padding-bottom: 8pt; font-size: 9pt; color: #444; }',
    'h1 { font-size: 18pt; margin: 0 0 14pt; } h2 { font-size: 15pt; } h3 { font-size: 13pt; }',
    'table { border-collapse: collapse; width: 100%; margin: 10pt 0; }',
    'th, td { border: 1px solid #777; padding: 4pt 6pt; text-align: left; vertical-align: top; font-size: 10pt; }',
    'pre { font-family: Consolas, "Courier New", monospace; font-size: 10pt; white-space: pre-wrap; }',
    'code { font-family: Consolas, "Courier New", monospace; }',
    '.signature { border-top: 1px solid #666; margin-top: 24pt; padding-top: 8pt; font-size: 9pt; color: #444; }',
    '</style>',
    '</head>',
    '<body>',
    '<div class="requisites">',
    `<p>${escapeHtml(labels.platform)} · ${escapeHtml(labels.typeLabel)}</p>`,
    `<p>${escapeHtml(labels.generatedAt)}</p>`,
    '</div>',
    `<h1>${title}</h1>`,
    body,
    '<div class="signature">',
    `<p>${escapeHtml(labels.platform)}</p>`,
    '</div>',
    '</body>',
    '</html>',
    '',
  ].join('\n');
}

/** Имя файла без символов, запрещённых в путях Windows/macOS/Linux. */
export function artifactFileName(artifact: ArtifactItem, extension: string): string {
  const base =
    artifact.title
      .trim()
      .replace(/[\\/:*?"<>|]+/g, '_')
      .replace(/\s+/g, '_')
      .slice(0, 80) || 'artifact';

  return `${base}.${extension}`;
}

/** Скачивание текстового файла через Blob, без серверного эндпоинта. */
export function downloadTextFile(
  filename: string,
  content: string,
  mimeType: string,
): void {
  const blob = new Blob([content], { type: `${mimeType};charset=utf-8` });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');

  link.href = url;
  link.download = filename;
  link.style.display = 'none';
  document.body.appendChild(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 0);
}

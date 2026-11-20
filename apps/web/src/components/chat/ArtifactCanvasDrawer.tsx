import {
  useEffect,
  useRef,
  useState,
  type ReactNode,
  type SyntheticEvent,
} from 'react';
import {
  ARTIFACT_MIME_TYPES,
  artifactFileName,
  artifactToCsv,
  artifactToMarkdown,
  artifactToPrintHtml,
  downloadTextFile,
  parseArtifactTable,
  refineArtifact,
  type ArtifactItem,
  type ArtifactPrintLabels,
  type ArtifactType,
} from '../../lib/artifacts';
import { MessageCodeBlock } from '../MessageCodeBlock';
import { ResultTable } from '../ResultTable';

export interface ArtifactCardLabels {
  open: string;
  types: Record<ArtifactType, string>;
}

export interface ArtifactCanvasLabels extends ArtifactCardLabels {
  title: string;
  close: string;
  preview: string;
  edit: string;
  instruction: string;
  instructionPlaceholder: string;
  presets: { recalculate: string; stricterLegal: string };
  selection: string;
  selectionHint: string;
  selectionEmpty: string;
  apply: string;
  applying: string;
  copy: string;
  copied: string;
  copyFailed: string;
  download: { md: string; csv: string; html: string; doc: string };
  refinementError: string;
  export: Omit<ArtifactPrintLabels, 'typeLabel'>;
}

const ARTIFACT_ICON: Record<ArtifactType, string> = {
  document: '▤',
  table: '▦',
  code: '</>',
};

/** Компактная карточка артефакта в ленте ответа. */
export function ArtifactCard({
  artifact,
  labels,
  onOpen,
}: {
  artifact: ArtifactItem;
  labels: ArtifactCardLabels;
  onOpen: (artifact: ArtifactItem) => void;
}) {
  return (
    <button
      type="button"
      onClick={() => onOpen(artifact)}
      className="mt-2 flex w-full max-w-full items-center gap-2 rounded-xl border border-outline-variant bg-surface-container px-3 py-2 text-left text-xs transition hover:border-primary/40 hover:bg-surface-container-high focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
    >
      <span
        aria-hidden="true"
        className="grid size-7 shrink-0 place-items-center rounded-lg bg-primary-container font-mono text-[11px] font-bold text-on-primary-container"
      >
        {ARTIFACT_ICON[artifact.type]}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate font-semibold text-on-surface">
          {artifact.title}
        </span>
        <span className="block text-[11px] text-on-surface-variant">
          {labels.types[artifact.type]}
        </span>
      </span>
      <span className="shrink-0 font-medium text-primary">{labels.open}</span>
    </button>
  );
}

/** Инлайн-разметка Markdown для превью документа: только жирный и код. */
function renderInline(text: string): ReactNode[] {
  return text.split(/(\*\*[^*]+\*\*|`[^`]+`)/g).map((part, index) => {
    if (part.startsWith('**') && part.endsWith('**')) {
      return <strong key={index}>{part.slice(2, -2)}</strong>;
    }

    if (part.startsWith('`') && part.endsWith('`')) {
      return <code key={index}>{part.slice(1, -1)}</code>;
    }

    return part;
  });
}

/**
 * Превью документа без Markdown-зависимости: заголовки, списки, код и
 * таблицы. Произвольный HTML из текста агента не рендерится.
 */
function MarkdownPreview({
  content,
  tableLabel,
}: {
  content: string;
  tableLabel: string;
}) {
  const lines = content.split('\n');
  const nodes: ReactNode[] = [];
  let listItems: string[] = [];
  let listOrdered = false;

  const flushList = (): void => {
    if (listItems.length === 0) {
      return;
    }

    const items = listItems.map((item, index) => (
      <li key={index}>{renderInline(item)}</li>
    ));

    nodes.push(
      listOrdered ? (
        <ol key={`list-${nodes.length}`} className="ml-5 list-decimal space-y-1">
          {items}
        </ol>
      ) : (
        <ul key={`list-${nodes.length}`} className="ml-5 list-disc space-y-1">
          {items}
        </ul>
      ),
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

    if (/^\s*```/.test(line)) {
      flushList();
      const code: string[] = [];
      let cursor = index + 1;

      while (cursor < lines.length && !/^\s*```\s*$/.test(lines[cursor] ?? '')) {
        code.push(lines[cursor] ?? '');
        cursor += 1;
      }

      nodes.push(
        <pre
          key={`code-${index}`}
          className="overflow-x-auto rounded-lg bg-surface-container px-3 py-2 text-xs"
        >
          <code>{code.join('\n')}</code>
        </pre>,
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

      nodes.push(
        table === null ? (
          <pre key={`table-${index}`} className="whitespace-pre-wrap text-xs">
            {tableLines.join('\n')}
          </pre>
        ) : (
          <ResultTable key={`table-${index}`} table={table} label={tableLabel} />
        ),
      );
      continue;
    }

    const heading = /^\s*(#{1,6})\s+(.+)$/.exec(line);

    if (heading !== null) {
      flushList();
      const level = Math.min((heading[1] ?? '').length + 1, 6);
      const headingText = heading[2] ?? '';
      const classes = 'font-display font-bold text-on-surface';

      nodes.push(
        level <= 2 ? (
          <p key={`heading-${index}`} className={`${classes} text-base`}>
            {renderInline(headingText)}
          </p>
        ) : (
          <p key={`heading-${index}`} className={`${classes} text-sm`}>
            {renderInline(headingText)}
          </p>
        ),
      );
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
    nodes.push(
      <p key={`text-${index}`} className="whitespace-pre-wrap break-words">
        {renderInline(line)}
      </p>,
    );
    index += 1;
  }

  flushList();

  return <div className="space-y-3 text-sm leading-relaxed">{nodes}</div>;
}

/**
 * Боковая рабочая область артефакта (UX-37.1/37.2): просмотр, выделение
 * фрагмента, точечная правка через API и экспорт без тяжёлых зависимостей.
 */
export function ArtifactCanvasDrawer({
  artifact,
  labels,
  onClose,
  onRefined,
}: {
  artifact: ArtifactItem;
  labels: ArtifactCanvasLabels;
  onClose: () => void;
  onRefined: (content: string) => void;
}) {
  const [mode, setMode] = useState<'preview' | 'edit'>('preview');
  const [content, setContent] = useState(artifact.content);
  const [selectedText, setSelectedText] = useState('');
  const [instruction, setInstruction] = useState('');
  const [isRefining, setIsRefining] = useState(false);
  const [feedback, setFeedback] = useState<{
    tone: 'success' | 'error';
    text: string;
  } | null>(null);
  const previewRef = useRef<HTMLDivElement>(null);
  const currentArtifact: ArtifactItem = { ...artifact, content };

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        onClose();
      }
    };

    window.addEventListener('keydown', handleKeyDown);

    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [onClose]);

  function handleSelection(event: SyntheticEvent<HTMLTextAreaElement>): void {
    const { selectionStart, selectionEnd, value } = event.currentTarget;

    if (selectionEnd > selectionStart) {
      setSelectedText(value.slice(selectionStart, selectionEnd));
    }
  }

  function handlePreviewSelection(): void {
    const selection = window.getSelection();
    const anchor = selection?.anchorNode ?? null;

    if (
      selection === null ||
      selection.isCollapsed ||
      anchor === null ||
      !(previewRef.current?.contains(anchor) ?? false)
    ) {
      return;
    }

    const text = selection.toString().trim();

    if (text !== '') {
      setSelectedText(text);
    }
  }

  async function handleRefine(): Promise<void> {
    setIsRefining(true);
    setFeedback(null);

    try {
      const response = await refineArtifact({
        artifactType: artifact.type,
        title: artifact.title,
        fullContent: content,
        selectedText,
        instruction,
      });

      setContent(response.updatedContent);
      setSelectedText('');
      setInstruction('');
      setMode('preview');
      setFeedback({ tone: 'success', text: response.summary });
      onRefined(response.updatedContent);
    } catch {
      setFeedback({ tone: 'error', text: labels.refinementError });
    } finally {
      setIsRefining(false);
    }
  }

  async function handleCopy(): Promise<void> {
    try {
      await navigator.clipboard.writeText(content);
      setFeedback({ tone: 'success', text: labels.copied });
    } catch {
      setFeedback({ tone: 'error', text: labels.copyFailed });
    }
  }

  function handleDownload(format: 'md' | 'csv' | 'html' | 'doc'): void {
    const extension = format === 'doc' ? 'doc' : format;
    const filename = artifactFileName(currentArtifact, extension);

    if (format === 'md') {
      downloadTextFile(
        filename,
        artifactToMarkdown(currentArtifact),
        ARTIFACT_MIME_TYPES.md,
      );
      return;
    }

    if (format === 'csv') {
      downloadTextFile(
        filename,
        artifactToCsv(currentArtifact),
        ARTIFACT_MIME_TYPES.csv,
      );
      return;
    }

    const html = artifactToPrintHtml(currentArtifact, {
      ...labels.export,
      typeLabel: labels.types[artifact.type],
    });

    downloadTextFile(
      filename,
      html,
      format === 'html' ? ARTIFACT_MIME_TYPES.html : ARTIFACT_MIME_TYPES.doc,
    );
  }

  return (
    <>
      <div
        aria-hidden="true"
        onClick={onClose}
        className="fixed inset-0 z-40 bg-black/40"
      />
      <aside
        role="dialog"
        aria-modal="true"
        aria-label={labels.title}
        className="fixed inset-y-0 right-0 z-50 flex w-full max-w-xl flex-col border-l border-outline-variant bg-surface shadow-2xl"
      >
        <header className="flex h-16 shrink-0 items-center justify-between gap-3 border-b border-outline-variant px-4">
          <div className="min-w-0">
            <h2 className="truncate text-sm font-semibold text-on-surface">
              {artifact.title}
            </h2>
            <p className="text-[11px] text-on-surface-variant">
              {labels.types[artifact.type]}
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label={labels.close}
            title={labels.close}
            className="grid size-9 shrink-0 place-items-center rounded-lg border border-outline text-on-surface-variant transition hover:bg-surface-container-high focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
          >
            <svg
              aria-hidden="true"
              viewBox="0 0 20 20"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.8"
              strokeLinecap="round"
              className="size-4"
            >
              <path d="m5 5 10 10M15 5 5 15" />
            </svg>
          </button>
        </header>

        <div className="flex shrink-0 items-center gap-2 border-b border-outline-variant px-4 py-2">
          <button
            type="button"
            onClick={() => setMode('preview')}
            aria-pressed={mode === 'preview'}
            className={`rounded-lg px-3 py-1.5 text-xs font-medium transition focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary ${
              mode === 'preview'
                ? 'bg-primary-container text-on-primary-container'
                : 'text-on-surface-variant hover:bg-surface-container-high'
            }`}
          >
            {labels.preview}
          </button>
          <button
            type="button"
            onClick={() => setMode('edit')}
            aria-pressed={mode === 'edit'}
            className={`rounded-lg px-3 py-1.5 text-xs font-medium transition focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary ${
              mode === 'edit'
                ? 'bg-primary-container text-on-primary-container'
                : 'text-on-surface-variant hover:bg-surface-container-high'
            }`}
          >
            {labels.edit}
          </button>
          <span className="ml-auto text-[11px] text-on-surface-variant">
            {selectedText === '' ? labels.selectionEmpty : labels.selection}
          </span>
        </div>

        <div className="flex-1 overflow-y-auto px-4 py-4">
          {mode === 'preview' ? (
            <div ref={previewRef} onMouseUp={handlePreviewSelection}>
              {artifact.type === 'table' ? (
                (() => {
                  const table = parseArtifactTable(content);

                  return table === null ? (
                    <pre className="overflow-x-auto whitespace-pre-wrap rounded-lg bg-surface-container p-3 text-xs">
                      {content}
                    </pre>
                  ) : (
                    <ResultTable table={table} label={labels.types.table} />
                  );
                })()
              ) : artifact.type === 'code' ? (
                <MessageCodeBlock
                  language={artifact.language ?? ''}
                  code={content}
                  label={labels.types.code}
                />
              ) : (
                <MarkdownPreview content={content} tableLabel={labels.types.table} />
              )}
            </div>
          ) : (
            <textarea
              aria-label={labels.edit}
              value={content}
              onChange={(event) => setContent(event.target.value)}
              onSelect={handleSelection}
              className="min-h-80 w-full rounded-xl border border-outline-variant bg-surface-container p-3 font-mono text-xs leading-relaxed text-on-surface outline-none focus:border-primary focus:ring-4 focus:ring-primary/15"
            />
          )}

          <p className="mt-3 text-[11px] leading-relaxed text-on-surface-variant">
            {labels.selectionHint}
          </p>

          <div className="mt-4 space-y-2">
            <label
              htmlFor="artifact-instruction"
              className="block text-xs font-semibold text-on-surface"
            >
              {labels.instruction}
            </label>
            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                onClick={() => setInstruction(labels.presets.recalculate)}
                className="rounded-full border border-outline px-2.5 py-1 text-[11px] text-on-surface-variant transition hover:border-primary/40 hover:text-on-surface focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
              >
                {labels.presets.recalculate}
              </button>
              <button
                type="button"
                onClick={() => setInstruction(labels.presets.stricterLegal)}
                className="rounded-full border border-outline px-2.5 py-1 text-[11px] text-on-surface-variant transition hover:border-primary/40 hover:text-on-surface focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
              >
                {labels.presets.stricterLegal}
              </button>
            </div>
            <textarea
              id="artifact-instruction"
              value={instruction}
              onChange={(event) => setInstruction(event.target.value)}
              placeholder={labels.instructionPlaceholder}
              rows={2}
              className="w-full rounded-xl border border-outline-variant bg-surface-container px-3 py-2 text-xs text-on-surface outline-none placeholder:text-on-surface-variant/60 focus:border-primary focus:ring-4 focus:ring-primary/15"
            />
            <button
              type="button"
              onClick={() => void handleRefine()}
              disabled={
                isRefining ||
                selectedText.trim() === '' ||
                instruction.trim() === ''
              }
              aria-busy={isRefining}
              className="inline-flex items-center justify-center rounded-lg bg-primary px-3 py-2 text-xs font-semibold text-on-primary transition hover:brightness-95 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary disabled:cursor-not-allowed disabled:opacity-40"
            >
              {isRefining ? labels.applying : labels.apply}
            </button>
          </div>

          {feedback !== null && (
            <p
              role={feedback.tone === 'error' ? 'alert' : 'status'}
              className={`mt-3 rounded-lg px-3 py-2 text-xs ${
                feedback.tone === 'error'
                  ? 'bg-error-container text-on-error-container'
                  : 'bg-tertiary-container text-on-tertiary-container'
              }`}
            >
              {feedback.text}
            </p>
          )}
        </div>

        <footer className="flex shrink-0 flex-wrap gap-2 border-t border-outline-variant px-4 py-3">
          <button
            type="button"
            onClick={() => void handleCopy()}
            className="rounded-lg border border-outline px-3 py-2 text-xs font-medium text-on-surface-variant transition hover:bg-surface-container-high focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
          >
            {labels.copy}
          </button>
          <button
            type="button"
            onClick={() => handleDownload('md')}
            className="rounded-lg border border-outline px-3 py-2 text-xs font-medium text-on-surface-variant transition hover:bg-surface-container-high focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
          >
            {labels.download.md}
          </button>
          {artifact.type === 'table' && (
            <button
              type="button"
              onClick={() => handleDownload('csv')}
              className="rounded-lg border border-outline px-3 py-2 text-xs font-medium text-on-surface-variant transition hover:bg-surface-container-high focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
            >
              {labels.download.csv}
            </button>
          )}
          <button
            type="button"
            onClick={() => handleDownload('html')}
            className="rounded-lg border border-outline px-3 py-2 text-xs font-medium text-on-surface-variant transition hover:bg-surface-container-high focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
          >
            {labels.download.html}
          </button>
          <button
            type="button"
            onClick={() => handleDownload('doc')}
            className="rounded-lg border border-outline px-3 py-2 text-xs font-medium text-on-surface-variant transition hover:bg-surface-container-high focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
          >
            {labels.download.doc}
          </button>
        </footer>
      </aside>
    </>
  );
}

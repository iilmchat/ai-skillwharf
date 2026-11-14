import { useTranslation } from 'react-i18next';
import {
  documentToChatText,
  formatDocumentSize,
  type ParsedDocument,
} from '../lib/documents';
import { ResultTable } from './ResultTable';

/**
 * Результат разбора загруженного документа: извлечённый текст, таблицы и
 * действие «Отправить в чат», чтобы агент продолжил работу с содержимым.
 */
export function DocumentResult({
  document,
  onSendToChat,
  onUploadAnother,
}: {
  document: ParsedDocument;
  onSendToChat: (text: string) => void;
  onUploadAnother: () => void;
}) {
  const { t } = useTranslation();
  const chatText = documentToChatText(document);
  const kindLabel =
    document.kind === 'pdf'
      ? t('chat.upload.kinds.pdf')
      : t('chat.upload.kinds.image');
  const sizeUnits = {
    byte: t('chat.upload.units.byte'),
    kilobyte: t('chat.upload.units.kilobyte'),
    megabyte: t('chat.upload.units.megabyte'),
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="min-w-0">
          <p className="truncate text-sm font-semibold text-on-surface">
            {document.filename}
          </p>
          <p className="mt-0.5 text-xs text-on-surface-variant">
            {kindLabel} · {formatDocumentSize(document.size, sizeUnits)}
          </p>
        </div>
        <button
          type="button"
          onClick={onUploadAnother}
          className="rounded-lg border border-outline px-3 py-1.5 text-xs font-semibold text-on-surface-variant transition hover:bg-surface-container-high hover:text-on-surface focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
        >
          {t('chat.upload.another')}
        </button>
      </div>

      {document.tables.length > 0 && (
        <div className="space-y-2">
          <p className="text-[11px] font-semibold uppercase tracking-wider text-on-surface-variant">
            {t('chat.upload.tablesTitle')}
          </p>
          {document.tables.map((table, index) => (
            <ResultTable
              key={`document-table-${index}`}
              table={table}
              label={t('chat.results.table')}
              caption={table.title}
            />
          ))}
        </div>
      )}

      <div>
        <p className="text-[11px] font-semibold uppercase tracking-wider text-on-surface-variant">
          {t('chat.upload.textTitle')}
        </p>
        {document.text.trim() === '' ? (
          <p className="mt-1 text-xs text-on-surface-variant">
            {t('chat.upload.emptyText')}
          </p>
        ) : (
          <pre
            aria-label={t('chat.upload.textTitle')}
            tabIndex={0}
            className="mt-1 max-h-72 overflow-auto rounded-xl border border-outline-variant bg-surface-container p-3 text-xs leading-relaxed whitespace-pre-wrap text-on-surface focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
          >
            {document.text}
          </pre>
        )}
      </div>

      {document.warnings.length > 0 && (
        <div className="rounded-xl border border-warning/30 bg-warning-container/40 p-3">
          <p className="text-[11px] font-semibold uppercase tracking-wider text-on-warning-container">
            {t('chat.upload.warningsTitle')}
          </p>
          <ul className="mt-1 list-disc space-y-0.5 pl-4 text-xs leading-relaxed text-on-warning-container">
            {document.warnings.map((warning, index) => (
              <li key={`${warning}-${index}`}>{warning}</li>
            ))}
          </ul>
        </div>
      )}

      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={() => onSendToChat(chatText)}
          disabled={chatText === ''}
          className="inline-flex items-center gap-2 rounded-xl bg-primary px-4 py-2 text-sm font-semibold text-on-primary shadow-lg shadow-primary/20 transition hover:brightness-95 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary disabled:cursor-not-allowed disabled:opacity-40 disabled:shadow-none"
        >
          {t('chat.upload.sendToChat')}
        </button>
      </div>
    </div>
  );
}

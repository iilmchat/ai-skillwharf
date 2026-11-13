import { useTranslation } from 'react-i18next';
import { useRagMemory } from '../hooks/useRagMemory';
import {
  getRagMemoryErrorKind,
  type MemoryEntry,
  type RagMemoryErrorKind,
} from '../lib/rag-memory';

const SECTION_CLASSES =
  'rounded-2xl border border-outline-variant bg-surface-container p-5 shadow-sm sm:p-6';

const RETRY_BUTTON_CLASSES =
  'mt-3 inline-flex items-center justify-center rounded-lg bg-error px-3 py-2 text-sm font-semibold text-on-error transition hover:brightness-95 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-error disabled:cursor-not-allowed disabled:opacity-60';

/** Локализованная дата создания записи; при кривой дате — исходная строка. */
function formatMemoryDate(createdAt: string, language: string): string {
  const date = new Date(createdAt);

  if (Number.isNaN(date.getTime())) {
    return createdAt;
  }

  return new Intl.DateTimeFormat(
    language.startsWith('en') ? 'en-US' : 'ru-RU',
    { dateStyle: 'medium', timeStyle: 'short' },
  ).format(date);
}

function RefreshIcon({ spinning }: { spinning: boolean }) {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={`size-4 ${spinning ? 'animate-spin' : ''}`}
    >
      <path d="M21 12a9 9 0 1 1-3-6.7" />
      <path d="M21 3v6h-6" />
    </svg>
  );
}

function MemorySkeleton() {
  const { t } = useTranslation();

  return (
    <div role="status">
      <span className="sr-only">{t('settings.rag.loading')}</span>
      <div aria-hidden="true" className="space-y-3">
        {[0, 1, 2].map((index) => (
          <div
            key={index}
            className="h-28 animate-pulse rounded-xl border border-outline-variant bg-surface-container-high"
          />
        ))}
      </div>
    </div>
  );
}

function MemoryEmptyState() {
  const { t } = useTranslation();

  return (
    <div className="rounded-xl border border-dashed border-outline px-6 py-10 text-center">
      <div
        aria-hidden="true"
        className="mx-auto grid size-12 place-items-center rounded-2xl border border-primary/20 bg-primary-container text-on-primary-container"
      >
        <svg
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.6"
          strokeLinecap="round"
          strokeLinejoin="round"
          className="size-6"
        >
          <path d="M12 3a5 5 0 0 1 5 5v1a4 4 0 0 1 0 8v1a3 3 0 0 1-5 2.2A3 3 0 0 1 7 18v-1a4 4 0 0 1 0-8V8a5 5 0 0 1 5-5Z" />
          <path d="M9 8h.01M15 8h.01M9 12h.01M15 12h.01M10 16h4" />
        </svg>
      </div>
      <h3 className="mt-4 font-display text-base font-bold text-on-surface">
        {t('settings.rag.emptyTitle')}
      </h3>
      <p className="mx-auto mt-2 max-w-md text-sm leading-relaxed text-on-surface-variant">
        {t('settings.rag.emptyBody')}
      </p>
    </div>
  );
}

function MemoryErrorState({
  kind,
  onRetry,
}: {
  kind: RagMemoryErrorKind;
  onRetry: () => void;
}) {
  const { t } = useTranslation();

  return (
    <div
      role="alert"
      className="rounded-xl border border-error/30 bg-error-container p-4 text-on-error-container sm:p-5"
    >
      <p className="text-sm leading-relaxed">
        {t(`settings.rag.errors.${kind}`)}
      </p>
      <button type="button" onClick={onRetry} className={RETRY_BUTTON_CLASSES}>
        {t('settings.rag.retry')}
      </button>
    </div>
  );
}

function MemoryEntryCard({
  entry,
  language,
}: {
  entry: MemoryEntry;
  language: string;
}) {
  const { t } = useTranslation();

  return (
    <li className="rounded-xl border border-outline-variant bg-surface-container-high p-4">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 text-xs text-on-surface-variant">
        <span className="inline-flex items-center gap-1.5 rounded-full bg-primary-container px-2.5 py-1 font-medium text-on-primary-container">
          <span
            aria-hidden="true"
            className="size-1.5 shrink-0 rounded-full bg-primary"
          />
          {t('settings.rag.entryType')}
        </span>
        <time dateTime={entry.createdAt} className="tabular-nums">
          {t('settings.rag.createdAt', {
            date: formatMemoryDate(entry.createdAt, language),
          })}
        </time>
      </div>

      <p className="mt-2 line-clamp-4 whitespace-pre-wrap break-words text-sm leading-relaxed text-on-surface">
        {entry.content}
      </p>
    </li>
  );
}

/**
 * Раздел «Память» на странице настроек.
 *
 * Показывает реальные записи из API со состояниями загрузки, пустоты и
 * ошибки. Рендерится только при включённом feature-флаге: read-endpoint
 * памяти ещё не реализован (KI-023), поэтому по умолчанию раздел скрыт.
 */
export function RagMemoryPanel() {
  const { t, i18n } = useTranslation();
  const query = useRagMemory();
  const language = i18n.resolvedLanguage ?? i18n.language ?? 'ru';
  const entries = query.data?.items ?? [];
  const total = query.data?.total ?? entries.length;
  const errorKind = query.isError ? getRagMemoryErrorKind(query.error) : null;

  function handleRefresh() {
    void query.refetch();
  }

  return (
    <section
      aria-labelledby="rag-memory-title"
      aria-describedby="rag-memory-description"
      className={SECTION_CLASSES}
    >
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0 max-w-xl">
          <h2
            id="rag-memory-title"
            className="font-display text-lg font-bold text-on-surface"
          >
            {t('settings.rag.title')}
          </h2>
          <p
            id="rag-memory-description"
            className="mt-2 text-sm leading-relaxed text-on-surface-variant"
          >
            {t('settings.rag.description')}
          </p>
        </div>

        <button
          type="button"
          onClick={handleRefresh}
          disabled={query.isFetching}
          aria-busy={query.isFetching}
          className="inline-flex shrink-0 items-center gap-2 rounded-lg border border-outline bg-surface px-3 py-2 text-sm font-medium text-on-surface-variant transition hover:border-primary/40 hover:text-on-surface focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary disabled:cursor-not-allowed disabled:opacity-60"
        >
          <RefreshIcon spinning={query.isFetching} />
          {query.isFetching
            ? t('settings.rag.refreshing')
            : t('settings.rag.refresh')}
        </button>
      </div>

      <div className="mt-5" aria-live="polite" aria-busy={query.isFetching}>
        {query.isPending ? (
          <MemorySkeleton />
        ) : errorKind !== null ? (
          <MemoryErrorState kind={errorKind} onRetry={handleRefresh} />
        ) : entries.length === 0 ? (
          <MemoryEmptyState />
        ) : (
          <>
            <p className="mb-3 text-xs font-medium text-on-surface-variant">
              {t('settings.rag.count', { count: total })}
            </p>
            <ul aria-label={t('settings.rag.listLabel')} className="space-y-3">
              {entries.map((entry) => (
                <MemoryEntryCard
                  key={entry.id}
                  entry={entry}
                  language={language}
                />
              ))}
            </ul>
          </>
        )}
      </div>

      <p className="mt-4 text-xs leading-relaxed text-on-surface-variant">
        {t('settings.rag.metadataNote')}
      </p>
    </section>
  );
}

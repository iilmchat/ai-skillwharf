import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import type { Citation } from '../../lib/message-metadata';

/**
 * Кликабельные сноски на источники ответа (KB-38.2).
 *
 * По нажатию бейджа раскрывается карточка с подсвеченным фрагментом; ссылка
 * ведёт в Knowledge Hub с идентификатором чанка, чтобы продолжить поиск
 * исходного документа.
 */
export function CitationBadges({
  citations,
}: {
  citations: readonly Citation[];
}) {
  const { t } = useTranslation();
  const [selectedIndex, setSelectedIndex] = useState<number | null>(null);

  if (citations.length === 0) {
    return null;
  }

  const sorted = [...citations].sort((left, right) => left.index - right.index);
  const selected = sorted.find((item) => item.index === selectedIndex) ?? null;

  return (
    <div className="mt-2">
      <div
        role="group"
        aria-label={t('chat.citations.label')}
        className="flex flex-wrap gap-1.5"
      >
        {sorted.map((citation) => (
          <button
            key={`${citation.index}-${citation.chunkId}`}
            type="button"
            aria-expanded={selectedIndex === citation.index}
            onClick={() =>
              setSelectedIndex((current) =>
                current === citation.index ? null : citation.index,
              )
            }
            className={`rounded-full border px-2.5 py-1 text-[11px] font-medium transition focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary ${
              selectedIndex === citation.index
                ? 'border-primary bg-primary-container text-on-primary-container'
                : 'border-outline bg-surface-container text-on-surface-variant hover:border-primary/40 hover:text-on-surface'
            }`}
          >
            [{citation.index}] {citation.title}
          </button>
        ))}
      </div>

      {selected !== null && (
        <div className="mt-2 rounded-xl border border-outline-variant bg-surface-container p-3 text-xs">
          <p className="font-semibold text-on-surface">
            {t('chat.citations.source', {
              index: selected.index,
              title: selected.title,
            })}
          </p>
          <mark className="mt-2 block rounded bg-tertiary-container px-2 py-1 leading-relaxed text-on-tertiary-container">
            {selected.snippet}
          </mark>
          <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-on-surface-variant">
            {selected.pageNumber !== undefined && (
              <span>
                {t('chat.citations.page', { pageNumber: selected.pageNumber })}
              </span>
            )}
            <Link
              to={`/app/knowledge?chunkId=${encodeURIComponent(selected.chunkId)}`}
              className="font-medium text-primary hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
            >
              {t('chat.citations.openInHub')}
            </Link>
          </div>
        </div>
      )}
    </div>
  );
}

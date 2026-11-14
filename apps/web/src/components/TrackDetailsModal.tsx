import { useEffect, useRef, type KeyboardEvent, type MouseEvent } from 'react';
import { useTranslation } from 'react-i18next';
import {
  findLandingTrack,
  type LandingTrack,
  type TrackId,
  type TrackPricing,
} from '../lib/landing-tracks';

interface TrackDetailsModalProps {
  /** Открытый трек или `null`, если окно закрыто. */
  trackId: TrackId | null;
  onClose: () => void;
}

const SECTION_TITLE_CLASSES =
  'text-[11px] font-semibold uppercase tracking-[0.16em] text-on-surface-variant';

const ROW_CLASSES =
  'flex items-start gap-3 rounded-xl border border-outline-variant bg-surface-container px-3 py-2.5';

/** Элементы, которые участвуют в последовательной навигации по Tab. */
const FOCUSABLE_SELECTOR = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(',');

function trackSectionTitleKey(
  section: 'agents' | 'scenario' | 'pricing',
): string {
  return `landing.tracks.details.${section}Label`;
}

function AgentList({ track }: { track: LandingTrack }) {
  const { t } = useTranslation();

  return (
    <ul className="mt-3 grid gap-2 sm:grid-cols-2">
      {track.agentKeys.map((agentKey) => {
        const prefix = `landing.tracks.items.${track.id}.agents.${agentKey}`;
        const name = t(`${prefix}.name`);
        // Не у всех агентов есть уточнение в скобках (например, «Диспетчер»).
        const role = t(`${prefix}.role`, { defaultValue: '' });

        return (
          <li key={agentKey} className={ROW_CLASSES}>
            <span
              aria-hidden="true"
              className="mt-0.5 grid size-6 shrink-0 place-items-center rounded-full bg-primary-container text-[10px] font-bold text-on-primary-container"
            >
              {name.slice(0, 1)}
            </span>
            <span className="min-w-0">
              <span className="block text-sm font-semibold text-on-surface">
                {name}
              </span>
              {role !== '' && (
                <span className="mt-0.5 block text-xs leading-relaxed text-on-surface-variant">
                  {role}
                </span>
              )}
            </span>
          </li>
        );
      })}
    </ul>
  );
}

function ScenarioList({ track }: { track: LandingTrack }) {
  const { t } = useTranslation();

  return (
    <ol className="mt-3 space-y-2">
      {track.stepKeys.map((stepKey, index) => (
        <li key={stepKey} className={ROW_CLASSES}>
          <span
            aria-hidden="true"
            className="grid size-6 shrink-0 place-items-center rounded-full bg-tertiary-container text-[11px] font-bold text-on-tertiary-container"
          >
            {index + 1}
          </span>
          <span className="min-w-0 text-sm leading-relaxed text-on-surface">
            {t(`landing.tracks.items.${track.id}.steps.${stepKey}`)}
          </span>
        </li>
      ))}
    </ol>
  );
}

function PricingList({
  track,
  pricing,
}: {
  track: LandingTrack;
  pricing: readonly TrackPricing[];
}) {
  const { t } = useTranslation();

  return (
    <ul className="mt-3 space-y-2">
      {pricing.map((row) => (
        <li
          key={row.key}
          className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 rounded-xl border border-outline-variant bg-surface-container px-3 py-2.5"
        >
          <span className="text-sm font-semibold text-on-surface">
            {row.plan}
          </span>
          <span className="text-sm leading-relaxed text-on-surface-variant">
            {t(`landing.tracks.items.${track.id}.pricing.${row.key}`)}
          </span>
        </li>
      ))}
    </ul>
  );
}

/**
 * Детали трека в модальном окне.
 *
 * Использует нативный `<dialog>`: браузер сам удерживает фокус внутри окна и
 * закрывает его по Escape. Клик по затемнению обрабатывается здесь — событие
 * приходит на сам `<dialog>`, поэтому `target === currentTarget`.
 */
export function TrackDetailsModal({
  trackId,
  onClose,
}: TrackDetailsModalProps) {
  const { t } = useTranslation();
  const dialogRef = useRef<HTMLDialogElement>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const isOpen = trackId !== null;
  const track = trackId === null ? undefined : findLandingTrack(trackId);

  useEffect(() => {
    const dialog = dialogRef.current;

    if (!dialog) {
      return;
    }

    if (isOpen) {
      if (!dialog.open) {
        dialog.showModal();
      }

      const timeoutId = window.setTimeout(() => {
        closeButtonRef.current?.focus();
      }, 0);

      return () => window.clearTimeout(timeoutId);
    }

    if (dialog.open) {
      dialog.close();
    }
  }, [isOpen]);

  // Все пути закрытия (кнопка, затемнение, Escape) проходят через dialog.close(),
  // поэтому состояние страницы обновляется только здесь.
  useEffect(() => {
    const dialog = dialogRef.current;

    if (!dialog) {
      return;
    }

    const handleClose = () => onClose();
    dialog.addEventListener('close', handleClose);

    return () => dialog.removeEventListener('close', handleClose);
  }, [onClose]);

  function closeDialog(): void {
    dialogRef.current?.close();
  }

  function handleBackdropClick(event: MouseEvent<HTMLDialogElement>): void {
    if (event.target === event.currentTarget) {
      closeDialog();
    }
  }

  /**
   * Нативный `<dialog>` запирает Tab не полностью: из Chrome фокус уходит в
   * панель браузера. Поэтому замыкаем обход на первом и последнем элементе окна.
   */
  function handleKeyDown(event: KeyboardEvent<HTMLDialogElement>): void {
    if (event.key !== 'Tab') {
      return;
    }

    const dialog = dialogRef.current;

    if (dialog === null) {
      return;
    }

    const focusable = Array.from(
      dialog.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR),
    ).filter((element) => element.getClientRects().length > 0);

    if (focusable.length === 0) {
      event.preventDefault();
      return;
    }

    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    const active = document.activeElement;

    if (event.shiftKey) {
      if (active === first || active === dialog) {
        event.preventDefault();
        last.focus();
      }

      return;
    }

    if (active === last) {
      event.preventDefault();
      first.focus();
    }
  }

  return (
    <dialog
      ref={dialogRef}
      aria-labelledby="track-dialog-title"
      onClick={handleBackdropClick}
      onKeyDown={handleKeyDown}
      className="m-auto w-[calc(100%-2rem)] max-w-2xl overflow-hidden rounded-2xl border border-outline-variant bg-surface p-0 text-on-surface shadow-2xl"
    >
      {track !== undefined && (
        <div className="flex max-h-[85svh] flex-col">
          <div className="flex items-start justify-between gap-4 border-b border-outline-variant px-6 py-5 sm:px-7">
            <div className="flex min-w-0 items-start gap-3">
              <span
                aria-hidden="true"
                className="grid size-11 shrink-0 place-items-center rounded-xl bg-primary-container text-xl text-on-primary-container"
              >
                {track.icon}
              </span>
              <div className="min-w-0">
                <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-primary">
                  {t('landing.tracks.details.letter', { letter: track.letter })}
                </p>
                <h2
                  id="track-dialog-title"
                  className="mt-1 font-display text-2xl font-bold tracking-tight text-on-surface"
                >
                  {t(`landing.tracks.items.${track.id}.name`)}
                </h2>
                <p className="mt-1 text-sm leading-relaxed text-on-surface-variant">
                  {t(`landing.tracks.items.${track.id}.description`)}
                </p>
              </div>
            </div>
            <button
              ref={closeButtonRef}
              type="button"
              onClick={closeDialog}
              aria-label={t('common.close')}
              className="shrink-0 rounded-lg p-1.5 text-on-surface-variant transition hover:bg-surface-container-high hover:text-on-surface focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
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
          </div>

          <div className="min-h-0 overflow-y-auto overscroll-contain px-6 py-5 sm:px-7">
            <div className="space-y-6">
              <section aria-labelledby="track-dialog-agents">
                <h3 id="track-dialog-agents" className={SECTION_TITLE_CLASSES}>
                  {t(trackSectionTitleKey('agents'))}
                </h3>
                <AgentList track={track} />
              </section>

              <section aria-labelledby="track-dialog-scenario">
                <h3
                  id="track-dialog-scenario"
                  className={SECTION_TITLE_CLASSES}
                >
                  {t(trackSectionTitleKey('scenario'))}
                </h3>
                <ScenarioList track={track} />
              </section>

              <section aria-labelledby="track-dialog-pricing">
                <h3 id="track-dialog-pricing" className={SECTION_TITLE_CLASSES}>
                  {t(trackSectionTitleKey('pricing'))}
                </h3>
                <PricingList track={track} pricing={track.pricing} />
              </section>
            </div>

            <div className="mt-6 flex justify-end">
              <button
                type="button"
                onClick={closeDialog}
                className="rounded-xl border border-outline px-4 py-2.5 text-sm font-medium text-on-surface-variant transition hover:border-primary/40 hover:text-on-surface focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
              >
                {t('common.close')}
              </button>
            </div>
          </div>
        </div>
      )}
    </dialog>
  );
}

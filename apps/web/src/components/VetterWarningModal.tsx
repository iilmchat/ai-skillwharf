import { useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import type { VetterReport } from '../lib/registry';

interface VetterWarningModalProps {
  open: boolean;
  skillName: string;
  report: VetterReport;
  isInstalling: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}

export function VetterWarningModal({
  open,
  skillName,
  report,
  isInstalling,
  onCancel,
  onConfirm,
}: VetterWarningModalProps) {
  const { t } = useTranslation();
  const dialogRef = useRef<HTMLDialogElement>(null);
  const cancelButtonRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    const dialog = dialogRef.current;

    if (!dialog) {
      return;
    }

    if (open) {
      if (!dialog.open) {
        dialog.showModal();
      }

      const timeoutId = window.setTimeout(() => {
        cancelButtonRef.current?.focus();
      }, 0);

      return () => window.clearTimeout(timeoutId);
    }

    if (dialog.open) {
      dialog.close();
    }
  }, [open]);

  useEffect(() => {
    const dialog = dialogRef.current;

    if (!dialog) {
      return;
    }

    const handleClose = () => onCancel();
    dialog.addEventListener('close', handleClose);

    return () => dialog.removeEventListener('close', handleClose);
  }, [onCancel]);

  // Пока идёт повторная установка, Escape не должен закрывать диалог.
  useEffect(() => {
    const dialog = dialogRef.current;

    if (!dialog) {
      return;
    }

    const handleCancel = (event: Event) => {
      if (isInstalling) {
        event.preventDefault();
      }
    };

    dialog.addEventListener('cancel', handleCancel);

    return () => dialog.removeEventListener('cancel', handleCancel);
  }, [isInstalling]);

  return (
    <dialog
      ref={dialogRef}
      aria-labelledby="vetter-title"
      aria-describedby="vetter-description"
      className="m-auto w-[calc(100%-2rem)] max-w-lg overflow-hidden rounded-2xl border border-error/30 bg-surface p-0 text-on-surface shadow-2xl"
    >
      <div className="max-h-[85svh] overflow-y-auto p-6">
        <div className="flex items-start gap-4">
          <span
            aria-hidden="true"
            className="grid size-11 shrink-0 place-items-center rounded-full bg-error-container text-on-error-container"
          >
            <svg
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.7"
              strokeLinecap="round"
              strokeLinejoin="round"
              className="size-6"
            >
              <path d="M12 3 2.8 19h18.4L12 3Z" />
              <path d="M12 9v4" />
              <circle cx="12" cy="16.5" r="0.9" fill="currentColor" />
            </svg>
          </span>

          <div className="min-w-0">
            <h2
              id="vetter-title"
              className="font-display text-xl font-bold tracking-tight text-on-surface"
            >
              {t('store.vetter.title')}
            </h2>
            <p
              id="vetter-description"
              className="mt-1 text-sm leading-relaxed text-on-surface-variant"
            >
              {t('store.vetter.body', { name: skillName })}
            </p>
          </div>
        </div>

        {report.dangers.length > 0 && (
          <section className="mt-5 rounded-xl border border-error/30 bg-error-container p-4">
            <h3 className="text-sm font-semibold text-on-error-container">
              {t('store.vetter.dangers')}
            </h3>
            <ul className="mt-2 list-disc space-y-1 pl-5 text-sm leading-relaxed text-on-error-container">
              {report.dangers.map((danger, index) => (
                <li key={`${index}-${danger}`}>{danger}</li>
              ))}
            </ul>
          </section>
        )}

        {report.warnings.length > 0 && (
          <section className="mt-4 rounded-xl border border-outline-variant bg-surface-container-high p-4">
            <h3 className="text-sm font-semibold text-on-surface">
              {t('store.vetter.warnings')}
            </h3>
            <ul className="mt-2 list-disc space-y-1 pl-5 text-sm leading-relaxed text-on-surface-variant">
              {report.warnings.map((warning, index) => (
                <li key={`${index}-${warning}`}>{warning}</li>
              ))}
            </ul>
          </section>
        )}

        <div className="mt-6 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
          <button
            ref={cancelButtonRef}
            type="button"
            onClick={onCancel}
            disabled={isInstalling}
            className="rounded-xl border border-outline px-4 py-2.5 text-sm font-medium text-on-surface-variant transition hover:border-primary/40 hover:text-on-surface focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary disabled:cursor-not-allowed disabled:opacity-60"
          >
            {t('store.vetter.cancel')}
          </button>
          <button
            type="button"
            onClick={onConfirm}
            disabled={isInstalling}
            aria-busy={isInstalling}
            className="inline-flex items-center justify-center gap-2 rounded-xl bg-error px-4 py-2.5 text-sm font-semibold text-on-error shadow-lg shadow-error/25 transition hover:brightness-95 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-error active:brightness-95 disabled:cursor-not-allowed disabled:opacity-60"
          >
            {isInstalling && (
              <svg
                aria-hidden="true"
                viewBox="0 0 24 24"
                fill="none"
                className="size-4 animate-spin"
              >
                <circle
                  cx="12"
                  cy="12"
                  r="9"
                  stroke="currentColor"
                  strokeOpacity="0.25"
                  strokeWidth="3"
                />
                <path
                  d="M21 12a9 9 0 0 0-9-9"
                  stroke="currentColor"
                  strokeWidth="3"
                  strokeLinecap="round"
                />
              </svg>
            )}
            {isInstalling
              ? t('store.installing')
              : t('store.vetter.confirm')}
          </button>
        </div>
      </div>
    </dialog>
  );
}

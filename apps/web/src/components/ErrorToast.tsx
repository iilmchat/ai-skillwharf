import { useEffect } from 'react';
import { useTranslation } from 'react-i18next';

interface ErrorToastAction {
  label: string;
  onClick: () => void;
}

interface ErrorToastProps {
  message: string;
  onClose: () => void;
  action?: ErrorToastAction;
}

const AUTO_DISMISS_MS = 8000;

export function ErrorToast({ message, onClose, action }: ErrorToastProps) {
  const { t } = useTranslation();

  useEffect(() => {
    const timeoutId = window.setTimeout(onClose, AUTO_DISMISS_MS);

    return () => window.clearTimeout(timeoutId);
  }, [message, onClose]);

  return (
    <div
      role="alert"
      className="fixed inset-x-4 bottom-28 z-50 flex items-start gap-3 rounded-xl border border-error/30 bg-error-container px-4 py-3 text-sm text-on-error-container shadow-xl shadow-error/10 sm:inset-x-auto sm:right-6 sm:bottom-28 sm:w-96"
    >
      <svg
        aria-hidden="true"
        viewBox="0 0 20 20"
        fill="none"
        className="mt-0.5 size-5 shrink-0 text-error"
      >
        <circle
          cx="10"
          cy="10"
          r="8.25"
          stroke="currentColor"
          strokeWidth="1.5"
        />
        <path
          d="M10 6v5"
          stroke="currentColor"
          strokeWidth="1.7"
          strokeLinecap="round"
        />
        <circle cx="10" cy="14" r="1" fill="currentColor" />
      </svg>
      <div className="min-w-0 flex-1">
        <p className="leading-relaxed">{message}</p>
        {action !== undefined && (
          <button
            type="button"
            onClick={action.onClick}
            className="mt-2 rounded-lg bg-error px-3 py-1.5 text-xs font-semibold text-on-error transition hover:brightness-95 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-error"
          >
            {action.label}
          </button>
        )}
      </div>
      <button
        type="button"
        onClick={onClose}
        aria-label={t('common.closeNotification')}
        className="rounded-md p-0.5 text-on-error-container/70 transition hover:bg-error/10 hover:text-on-error-container focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-error"
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
  );
}

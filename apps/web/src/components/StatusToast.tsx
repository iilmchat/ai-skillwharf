import { useEffect } from 'react';
import { useTranslation } from 'react-i18next';

type StatusToastTone = 'success' | 'warning';

interface StatusToastProps {
  message: string;
  tone: StatusToastTone;
  onClose: () => void;
}

const AUTO_DISMISS_MS = 8000;

const TONE_CLASSES: Record<StatusToastTone, string> = {
  success: 'border-success/30 bg-success/10 text-success',
  warning:
    'border-warning/30 bg-warning-container text-on-warning-container',
};

export function StatusToast({ message, tone, onClose }: StatusToastProps) {
  const { t } = useTranslation();

  useEffect(() => {
    const timeoutId = window.setTimeout(onClose, AUTO_DISMISS_MS);

    return () => window.clearTimeout(timeoutId);
  }, [message, onClose]);

  return (
    <div
      role="status"
      className={`fixed inset-x-4 bottom-28 z-50 flex items-start gap-3 rounded-xl border px-4 py-3 text-sm shadow-xl sm:inset-x-auto sm:right-6 sm:bottom-28 sm:w-96 ${TONE_CLASSES[tone]}`}
    >
      <svg
        aria-hidden="true"
        viewBox="0 0 20 20"
        fill="none"
        className="mt-0.5 size-5 shrink-0"
      >
        {tone === 'success' ? (
          <>
            <circle
              cx="10"
              cy="10"
              r="8.25"
              stroke="currentColor"
              strokeWidth="1.5"
            />
            <path
              d="m6.5 10.2 2.3 2.3 4.7-5"
              stroke="currentColor"
              strokeWidth="1.7"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </>
        ) : (
          <>
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
          </>
        )}
      </svg>
      <p className="min-w-0 flex-1 leading-relaxed">{message}</p>
      <button
        type="button"
        onClick={onClose}
        aria-label={t('common.closeNotification')}
        className="rounded-md p-0.5 opacity-70 transition hover:bg-current/10 hover:opacity-100 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-current"
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

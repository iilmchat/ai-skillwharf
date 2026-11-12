import { useQuery } from '@tanstack/react-query';
import { useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import {
  fetchLedger,
  getBillingErrorMessage,
  ledgerQueryKey,
  type LedgerEntry,
} from '../lib/billing';
import { CURRENCY_SYMBOL, formatMoney } from '../lib/money';

interface LedgerHistoryModalProps {
  open: boolean;
  onClose: () => void;
}

function formatDate(value: string, language: string): string {
  const date = new Date(value);

  if (Number.isNaN(date.getTime())) {
    return value;
  }

  return new Intl.DateTimeFormat(language, {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(date);
}

function LedgerRow({ entry }: { entry: LedgerEntry }) {
  const { t, i18n } = useTranslation();
  const type = entry.type.toUpperCase();
  const isPending = type === 'PENDING';
  const isCredit = type === 'CREDIT';
  const statusKey = isPending
    ? 'billing.history.pending'
    : isCredit
      ? 'billing.history.credit'
      : 'billing.history.debit';
  const badgeClasses = isPending
    ? 'bg-warning-container text-on-warning-container'
    : isCredit
      ? 'bg-success/10 text-success'
      : 'bg-error-container text-on-error-container';

  return (
    <li className="flex items-start justify-between gap-4 py-3">
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-2">
          <p className="text-sm font-medium text-on-surface">
            {entry.description}
          </p>
          <span
            className={`inline-flex rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${badgeClasses}`}
          >
            {t(statusKey)}
          </span>
        </div>
        <p className="mt-0.5 text-xs text-on-surface-variant">
          {formatDate(entry.createdAt, i18n.language)}
        </p>
        <p className="mt-1 text-xs text-on-surface-variant">
          {t('billing.history.balanceAfter', {
            amount: formatMoney(entry.balanceAfter, i18n.language),
          })}
        </p>
      </div>

      <span
        className={`shrink-0 text-sm font-semibold tabular-nums ${
          isPending
            ? 'text-warning'
            : isCredit
              ? 'text-success'
              : 'text-error'
        }`}
      >
        {isCredit ? '+' : '−'}
        {formatMoney(entry.amount, i18n.language)} {CURRENCY_SYMBOL}
      </span>
    </li>
  );
}

export function LedgerHistoryModal({ open, onClose }: LedgerHistoryModalProps) {
  const { t } = useTranslation();
  const dialogRef = useRef<HTMLDialogElement>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);

  const ledgerQuery = useQuery({
    queryKey: ledgerQueryKey,
    queryFn: fetchLedger,
    enabled: open,
    staleTime: 0,
  });

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
        closeButtonRef.current?.focus();
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

    const handleClose = () => onClose();
    dialog.addEventListener('close', handleClose);

    return () => dialog.removeEventListener('close', handleClose);
  }, [onClose]);

  const entries = ledgerQuery.data ?? [];

  return (
    <dialog
      ref={dialogRef}
      aria-labelledby="ledger-title"
      aria-describedby="ledger-description"
      className="m-auto w-[calc(100%-2rem)] max-w-lg overflow-hidden rounded-2xl border border-outline-variant bg-surface p-0 text-on-surface shadow-2xl"
    >
      <div className="max-h-[85svh] overflow-y-auto p-6">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h2
              id="ledger-title"
              className="font-display text-xl font-bold tracking-tight text-on-surface"
            >
              {t('billing.history.title')}
            </h2>
            <p
              id="ledger-description"
              className="mt-1 text-sm text-on-surface-variant"
            >
              {t('billing.history.subtitle')}
            </p>
          </div>
          <button
            ref={closeButtonRef}
            type="button"
            onClick={onClose}
            aria-label={t('common.close')}
            className="rounded-lg p-1.5 text-on-surface-variant transition hover:bg-surface-container-high hover:text-on-surface focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
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

        {ledgerQuery.isPending ? (
          <>
            <span className="sr-only">{t('billing.history.loading')}</span>
            <div aria-hidden="true" className="mt-5 space-y-3">
              {[0, 1, 2, 3].map((index) => (
                <div
                  key={index}
                  className="h-16 animate-pulse rounded-xl bg-surface-container-high"
                />
              ))}
            </div>
          </>
        ) : ledgerQuery.isError ? (
          <div
            role="alert"
            className="mt-5 rounded-xl border border-error/30 bg-error-container p-4 text-sm text-on-error-container"
          >
            <p className="font-semibold">{t('billing.history.errorTitle')}</p>
            <p className="mt-1">
              {getBillingErrorMessage(
                ledgerQuery.error,
                'billing.errors.ledger',
              )}
            </p>
            <button
              type="button"
              onClick={() => {
                void ledgerQuery.refetch();
              }}
              className="mt-3 rounded-lg bg-primary px-3 py-2 text-xs font-semibold text-on-primary transition hover:brightness-95 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
            >
              {t('billing.history.retry')}
            </button>
          </div>
        ) : entries.length === 0 ? (
          <div className="mt-5 rounded-xl border border-dashed border-outline px-4 py-10 text-center">
            <h3 className="font-display text-base font-bold text-on-surface">
              {t('billing.history.emptyTitle')}
            </h3>
            <p className="mt-1 text-sm text-on-surface-variant">
              {t('billing.history.emptyBody')}
            </p>
          </div>
        ) : (
          <ul className="mt-4 divide-y divide-outline-variant">
            {entries.map((entry) => (
              <LedgerRow key={entry.id} entry={entry} />
            ))}
          </ul>
        )}
      </div>
    </dialog>
  );
}

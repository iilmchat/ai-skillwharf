import { useTranslation } from 'react-i18next';
import { CURRENCY_SYMBOL, formatMoney } from '../lib/money';

interface BalanceWidgetProps {
  balance: string | undefined;
  isFetching: boolean;
  isError: boolean;
  onRetry: () => void;
  onTopUp: () => void;
  variant?: 'card' | 'inline';
}

export function BalanceWidget({
  balance,
  isFetching,
  isError,
  onRetry,
  onTopUp,
  variant = 'card',
}: BalanceWidgetProps) {
  const { t, i18n } = useTranslation();
  const formatted =
    balance === undefined ? '—' : formatMoney(balance, i18n.language);
  const value = isError && balance === undefined ? '—' : formatted;

  if (variant === 'inline') {
    return (
      <div className="flex items-center justify-between gap-3">
        <div className="flex min-w-0 items-baseline gap-1.5 text-xs text-on-surface-variant">
          <span>{t('billing.balance')}</span>
          {isFetching && (
            <span
              aria-hidden="true"
              className="size-3 animate-spin rounded-full border-2 border-outline border-t-primary"
            />
          )}
          {isFetching && balance === undefined && (
            <span className="sr-only">{t('billing.loading')}</span>
          )}
          <span
            aria-live="polite"
            className="truncate text-sm font-semibold tabular-nums text-on-surface"
          >
            {value} {CURRENCY_SYMBOL}
          </span>
        </div>

        <div className="flex shrink-0 items-center gap-2">
          {isError && (
            <button
              type="button"
              onClick={onRetry}
              aria-label={t('billing.retry')}
              className="rounded-lg border border-outline px-2.5 py-1 text-xs font-medium text-on-surface-variant transition hover:border-primary/40 hover:text-on-surface focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
            >
              {t('billing.retry')}
            </button>
          )}
          <button
            type="button"
            onClick={onTopUp}
            className="rounded-lg bg-primary px-2.5 py-1 text-xs font-semibold text-on-primary transition hover:brightness-95 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
          >
            {t('billing.topUp')}
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="rounded-xl border border-outline-variant bg-surface-container-high p-3">
      <div className="flex items-center justify-between gap-2">
        <p className="text-xs font-medium text-on-surface-variant">
          {t('billing.balance')}
        </p>
        {isFetching && (
          <span
            aria-hidden="true"
            className="size-3 animate-spin rounded-full border-2 border-outline border-t-primary"
          />
        )}
        {isFetching && balance === undefined && (
          <span className="sr-only">{t('billing.loading')}</span>
        )}
      </div>

      <p
        aria-live="polite"
        className="mt-1 font-display text-2xl font-bold tabular-nums text-on-surface"
      >
        {value}{' '}
        <span className="text-sm font-semibold text-on-surface-variant">
          {CURRENCY_SYMBOL}
        </span>
      </p>

      {isError && (
        <button
          type="button"
          onClick={onRetry}
          className="mt-1 text-xs font-medium text-primary underline-offset-2 transition hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
        >
          {t('billing.retry')}
        </button>
      )}

      <button
        type="button"
        onClick={onTopUp}
        className="mt-3 w-full rounded-lg bg-primary px-3 py-2 text-sm font-semibold text-on-primary transition hover:brightness-95 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
      >
        {t('billing.topUp')}
      </button>
    </div>
  );
}

import { useTranslation } from 'react-i18next';
import { CURRENCY_SYMBOL, formatMoney } from '../lib/money';

interface BalanceWidgetProps {
  balance: string | undefined;
  heldBalance?: string | undefined;
  isFetching: boolean;
  isError: boolean;
  onRetry: () => void;
  onTopUp: () => void;
  onHistory: () => void;
  variant?: 'card' | 'inline';
}

export function BalanceWidget({
  balance,
  heldBalance,
  isFetching,
  isError,
  onRetry,
  onTopUp,
  onHistory,
  variant = 'card',
}: BalanceWidgetProps) {
  const { t, i18n } = useTranslation();
  const formatted =
    balance === undefined ? '—' : formatMoney(balance, i18n.language);
  const value = isError && balance === undefined ? '—' : formatted;
  const held = heldBalance === undefined ? 0 : Number(heldBalance);
  const hasHeld = Number.isFinite(held) && held > 0;
  const formattedHeld =
    heldBalance === undefined ? '—' : formatMoney(heldBalance, i18n.language);

  if (variant === 'inline') {
    return (
      <div className="flex items-center justify-between gap-3">
        <div className="flex min-w-0 flex-wrap items-baseline gap-1.5 text-xs text-on-surface-variant">
          <span>{t('billing.available')}</span>
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
          {hasHeld && (
            <span className="text-[11px] font-medium text-warning">
              · {t('billing.held')}: {formattedHeld} {CURRENCY_SYMBOL}
            </span>
          )}
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
            onClick={onHistory}
            className="rounded-lg border border-outline px-2.5 py-1 text-xs font-medium text-on-surface-variant transition hover:border-primary/40 hover:text-on-surface focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
          >
            {t('billing.history.button')}
          </button>
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
          {t('billing.available')}
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

      {hasHeld && (
        <p className="mt-1 inline-flex items-center gap-1 rounded-full bg-warning-container px-2 py-0.5 text-[11px] font-semibold text-on-warning-container">
          <span aria-hidden="true">🔒</span>
          {t('billing.held')}: {formattedHeld} {CURRENCY_SYMBOL}
        </p>
      )}

      {isError && (
        <button
          type="button"
          onClick={onRetry}
          className="mt-1 text-xs font-medium text-primary underline-offset-2 transition hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
        >
          {t('billing.retry')}
        </button>
      )}

      <div className="mt-3 grid grid-cols-2 gap-2">
        <button
          type="button"
          onClick={onTopUp}
          className="rounded-lg bg-primary px-3 py-2 text-sm font-semibold text-on-primary transition hover:brightness-95 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
        >
          {t('billing.topUp')}
        </button>
        <button
          type="button"
          onClick={onHistory}
          className="rounded-lg border border-outline px-3 py-2 text-sm font-medium text-on-surface-variant transition hover:border-primary/40 hover:text-on-surface focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
        >
          {t('billing.history.button')}
        </button>
      </div>
    </div>
  );
}

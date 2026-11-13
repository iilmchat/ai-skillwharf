import { useTranslation } from 'react-i18next';
import type { TokenQuota } from '../lib/profile';

interface TokenUsageWidgetProps {
  quota: TokenQuota | null | undefined;
}

const WARNING_THRESHOLD = 0.8;

/** Компактное число: 15000 → 15k, 12345 → 12.3k, 2_500_000 → 2.5M. */
function formatCompact(value: number): string {
  if (value < 1_000) {
    return String(value);
  }

  if (value < 1_000_000) {
    const thousands = Math.round((value / 1_000) * 10) / 10;

    return thousands >= 1_000 ? '1M' : `${formatDecimal(thousands)}k`;
  }

  const millions = Math.round((value / 1_000_000) * 10) / 10;

  return `${formatDecimal(millions)}M`;
}

function formatDecimal(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(1);
}

/**
 * Дневной лимит токенов: компактная подпись и прогресс-бар.
 *
 * Виджет не рендерится, пока бэкенд не отдал корректные поля квоты.
 */
export function TokenUsageWidget({ quota }: TokenUsageWidgetProps) {
  const { t } = useTranslation();

  if (quota === null || quota === undefined) {
    return null;
  }

  const { dailyTokenLimit, dailyTokensUsed } = quota;
  const ratio = dailyTokensUsed / dailyTokenLimit;
  const percent = Math.min(100, ratio * 100);
  const isExhausted = ratio >= 1;
  const isWarning = !isExhausted && ratio >= WARNING_THRESHOLD;
  const barClassName = isExhausted
    ? 'bg-error'
    : isWarning
      ? 'bg-warning'
      : 'bg-primary';
  const used = formatCompact(dailyTokensUsed);
  const limit = formatCompact(dailyTokenLimit);

  return (
    <div className="mt-3 rounded-xl border border-outline-variant bg-surface-container-high p-3">
      <div className="flex items-baseline justify-between gap-2">
        <p className="text-xs font-medium text-on-surface-variant">
          {t('chat.tokens.label')}
        </p>
        <p
          aria-live="polite"
          className="text-sm font-semibold tabular-nums text-on-surface"
        >
          {t('chat.tokens.usage', { used, limit })}
        </p>
      </div>

      <div
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={dailyTokenLimit}
        aria-valuenow={Math.min(dailyTokensUsed, dailyTokenLimit)}
        aria-label={t('chat.tokens.ariaLabel', { used, limit })}
        className="mt-2 h-2 overflow-hidden rounded-full bg-surface-container"
      >
        <span
          aria-hidden="true"
          className={`block h-full rounded-full transition-[width] duration-300 ${barClassName}`}
          style={{ width: `${percent}%` }}
        />
      </div>
    </div>
  );
}

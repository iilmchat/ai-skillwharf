import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Link, NavLink } from 'react-router-dom';
import { Brand } from '../components/Brand';
import { LanguageSwitcher } from '../components/LanguageSwitcher';
import { ThemeToggle } from '../components/ThemeToggle';
import {
  fetchFinanceOverview,
  financeQueryKey,
  getFinanceErrorDetails,
  getFraudShieldRisks,
  getFraudShieldStatus,
  getProfitLeakFindings,
  getTotalMarginPercent,
  sumUnitEconomicsMargin,
  sumUnitEconomicsRevenue,
  type FinanceErrorKind,
  type FinanceFinding,
  type FraudShieldStatus,
  type UnitEconomicsResult,
} from '../lib/finance';

const SECTION_CLASSES =
  'rounded-2xl border border-outline-variant bg-surface-container p-5 shadow-sm sm:p-6';

const METRIC_CLASSES =
  'rounded-xl border border-outline-variant bg-surface p-4';

const ERROR_KEYS: Record<FinanceErrorKind, string> = {
  network: 'finance.errors.network',
  sessionExpired: 'finance.errors.sessionExpired',
  forbidden: 'finance.errors.forbidden',
  notFound: 'finance.errors.notFound',
  unavailable: 'finance.errors.unavailable',
  invalidResponse: 'finance.errors.invalidResponse',
  unknown: 'finance.errors.unknown',
};

const FRAUD_CLASSES: Record<FraudShieldStatus, string> = {
  complete: 'border-success/30 bg-success/10 text-success',
  risks: 'border-error/30 bg-error-container text-on-error-container',
  unknown:
    'border-outline-variant bg-surface-container-high text-on-surface-variant',
};

const FRAUD_LABEL_KEYS: Record<FraudShieldStatus, string> = {
  complete: 'finance.fraud.complete',
  risks: 'finance.fraud.risks',
  unknown: 'finance.fraud.unknown',
};

function navLinkClasses({ isActive }: { isActive: boolean }): string {
  return `rounded-lg px-3 py-2 text-sm font-medium transition focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary ${
    isActive
      ? 'bg-primary-container text-on-primary-container'
      : 'text-on-surface-variant hover:bg-surface-container-high hover:text-on-surface'
  }`;
}

function formatMoney(
  value: number,
  currency: string,
  language: string,
): string {
  const locale = language.startsWith('en') ? 'en-US' : 'ru-RU';

  try {
    return new Intl.NumberFormat(locale, {
      style: 'currency',
      currency,
      maximumFractionDigits: 0,
    }).format(value);
  } catch {
    return `${Math.round(value)} ${currency}`;
  }
}

function formatPercent(value: number, language: string): string {
  const locale = language.startsWith('en') ? 'en-US' : 'ru-RU';

  return `${new Intl.NumberFormat(locale, {
    maximumFractionDigits: 1,
  }).format(value)}%`;
}

function itemMarginPercent(item: UnitEconomicsResult): number | null {
  if (item.marginPercent !== undefined) {
    return item.marginPercent;
  }

  if (item.margin === undefined || item.revenue === undefined) {
    return null;
  }

  return item.revenue === 0 ? null : (item.margin / item.revenue) * 100;
}

function marketplaceLabel(marketplace: 'ozon' | 'wb'): string {
  return marketplace === 'ozon' ? 'Ozon' : 'WB';
}

function severityClasses(severity: FinanceFinding['severity']): string {
  if (severity === 'high') {
    return 'border-error/30 bg-error-container text-on-error-container';
  }

  if (severity === 'medium') {
    return 'border-warning/30 bg-warning-container text-on-warning-container';
  }

  return 'border-outline-variant bg-surface-container-high text-on-surface-variant';
}

function FinanceSkeleton() {
  const { t } = useTranslation();

  return (
    <div role="status">
      <span className="sr-only">{t('finance.loading')}</span>
      <div aria-hidden="true" className="space-y-4">
        <div className="grid gap-4 sm:grid-cols-3">
          {[0, 1, 2].map((index) => (
            <div
              key={index}
              className="h-24 animate-pulse rounded-xl border border-outline-variant bg-surface-container-high"
            />
          ))}
        </div>
        <div className="h-64 animate-pulse rounded-2xl border border-outline-variant bg-surface-container-high" />
      </div>
    </div>
  );
}

function FinanceErrorState({
  error,
  onRetry,
}: {
  error: unknown;
  onRetry: () => void;
}) {
  const { t, i18n } = useTranslation();
  const details = getFinanceErrorDetails(error);
  const translatedServerMessage =
    details.serverMessage !== null &&
    details.serverMessage.startsWith('errors.') &&
    i18n.exists(details.serverMessage)
      ? t(details.serverMessage)
      : null;
  const message = translatedServerMessage ?? t(ERROR_KEYS[details.kind]);

  return (
    <div
      role="alert"
      className="rounded-2xl border border-error/30 bg-error-container p-5 text-on-error-container"
    >
      <p className="text-sm leading-relaxed">{message}</p>
      <button
        type="button"
        onClick={onRetry}
        className="mt-3 rounded-lg bg-primary px-3 py-2 text-xs font-semibold text-on-primary transition hover:brightness-95 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
      >
        {t('finance.retry')}
      </button>
    </div>
  );
}

function MetricCard({
  label,
  value,
  tone = 'default',
}: {
  label: string;
  value: string;
  tone?: 'default' | 'positive' | 'negative';
}) {
  const valueClasses =
    tone === 'positive'
      ? 'text-success'
      : tone === 'negative'
        ? 'text-error'
        : 'text-on-surface';

  return (
    <div className={METRIC_CLASSES}>
      <p className="text-[11px] font-medium uppercase tracking-wider text-on-surface-variant">
        {label}
      </p>
      <p className={`mt-2 font-display text-2xl font-bold ${valueClasses}`}>
        {value}
      </p>
    </div>
  );
}

function MarginBar({ value }: { value: number }) {
  const width = Math.min(Math.abs(value), 100);

  return (
    <div className="flex items-center justify-end gap-2">
      <div
        aria-hidden="true"
        className="h-1.5 w-20 overflow-hidden rounded-full bg-surface-container-high"
      >
        <div
          className={`h-full rounded-full ${value < 0 ? 'bg-error' : 'bg-success'}`}
          style={{ width: `${width}%` }}
        />
      </div>
      <span className="w-16 text-right tabular-nums">
        {value.toFixed(1)}%
      </span>
    </div>
  );
}

function UnitEconomicsTable({
  items,
  currency,
  language,
}: {
  items: readonly UnitEconomicsResult[];
  currency: string;
  language: string;
}) {
  const { t } = useTranslation();

  if (items.length === 0) {
    return (
      <div className="rounded-xl border border-dashed border-outline px-6 py-10 text-center">
        <h3 className="font-display text-base font-bold text-on-surface">
          {t('finance.unit.emptyTitle')}
        </h3>
        <p className="mx-auto mt-2 max-w-md text-sm leading-relaxed text-on-surface-variant">
          {t('finance.unit.emptyBody')}
        </p>
      </div>
    );
  }

  return (
    <div className="overflow-x-auto rounded-xl border border-outline-variant">
      <table className="w-full min-w-[680px] text-left text-sm">
        <thead className="border-b border-outline-variant bg-surface-container-high text-[11px] uppercase tracking-wider text-on-surface-variant">
          <tr>
            <th scope="col" className="px-4 py-3 font-semibold">
              {t('finance.unit.marketplace')}
            </th>
            <th scope="col" className="px-4 py-3 font-semibold">
              {t('finance.unit.sku')}
            </th>
            <th scope="col" className="px-4 py-3 text-right font-semibold">
              {t('finance.unit.revenue')}
            </th>
            <th scope="col" className="px-4 py-3 text-right font-semibold">
              {t('finance.unit.profit')}
            </th>
            <th scope="col" className="px-4 py-3 text-right font-semibold">
              {t('finance.unit.margin')}
            </th>
          </tr>
        </thead>
        <tbody className="divide-y divide-outline-variant">
          {items.map((item) => {
            const margin = itemMarginPercent(item);
            const available = item.dataAvailable;

            return (
              <tr key={`${item.marketplace}-${item.sku}`} className="bg-surface">
                <td className="px-4 py-3 text-xs font-medium uppercase text-on-surface-variant">
                  {marketplaceLabel(item.marketplace)}
                </td>
                <td className="px-4 py-3">
                  <span className="font-mono text-xs text-on-surface">
                    {item.sku}
                  </span>
                  {!available && item.reason !== undefined && (
                    <span className="mt-1 block max-w-xs text-xs text-on-surface-variant">
                      {item.reason}
                    </span>
                  )}
                </td>
                <td className="px-4 py-3 text-right tabular-nums text-on-surface">
                  {item.revenue === undefined
                    ? '—'
                    : formatMoney(item.revenue, currency, language)}
                </td>
                <td
                  className={`px-4 py-3 text-right tabular-nums ${
                    (item.margin ?? 0) < 0 ? 'text-error' : 'text-on-surface'
                  }`}
                >
                  {item.margin === undefined
                    ? '—'
                    : formatMoney(item.margin, currency, language)}
                </td>
                <td className="px-4 py-3 text-on-surface-variant">
                  {margin === null ? '—' : <MarginBar value={margin} />}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function ProfitLeakAlerts({ findings }: { findings: readonly FinanceFinding[] }) {
  const { t, i18n } = useTranslation();
  const language = i18n.language;

  if (findings.length === 0) {
    return (
      <div className="rounded-xl border border-dashed border-outline px-6 py-8 text-center">
        <p className="text-sm text-on-surface-variant">
          {t('finance.leaks.noLeaks')}
        </p>
      </div>
    );
  }

  return (
    <ul className="space-y-2">
      {findings.map((finding) => (
        <li
          key={`${finding.code}-${finding.detail}`}
          className={`rounded-xl border px-3 py-2.5 text-sm ${severityClasses(finding.severity)}`}
        >
          <div className="flex flex-wrap items-start justify-between gap-2">
            <span className="font-medium">{finding.detail}</span>
            {finding.amount !== undefined && (
              <span className="shrink-0 tabular-nums">
                {formatMoney(finding.amount, 'RUB', language)}
              </span>
            )}
          </div>
          <p className="mt-1 font-mono text-[11px] opacity-70">
            {finding.code} · {finding.source}
          </p>
        </li>
      ))}
    </ul>
  );
}

function formatPeriod(
  period: string | { from: string; to: string } | undefined,
): string | null {
  if (period === undefined) {
    return null;
  }

  return typeof period === 'string' ? period : `${period.from} — ${period.to}`;
}

export function FinancePage() {
  const { t, i18n } = useTranslation();
  const financeQuery = useQuery({
    queryKey: financeQueryKey,
    queryFn: fetchFinanceOverview,
    staleTime: 60_000,
  });

  const data = financeQuery.data;
  const items = data?.unitEconomics ?? [];
  const revenue = sumUnitEconomicsRevenue(items);
  const profit = sumUnitEconomicsMargin(items);
  const margin = getTotalMarginPercent(items);
  const leakFindings = data === undefined ? [] : getProfitLeakFindings(data.profitLeaks);
  const fraudAudit = data?.fraudShield ?? null;
  const fraudStatus = getFraudShieldStatus(fraudAudit);
  const fraudRisks = getFraudShieldRisks(fraudAudit);
  const period = formatPeriod(data?.period);
  const currency = data?.currency ?? 'RUB';
  const language = i18n.language;

  return (
    <div className="min-h-svh bg-surface text-on-surface">
      <header className="sticky top-0 z-20 border-b border-outline-variant bg-surface/90 backdrop-blur">
        <div className="mx-auto flex h-16 max-w-6xl items-center justify-between gap-3 px-4 sm:px-6">
          <div className="flex min-w-0 items-center gap-2 sm:gap-4">
            <span className="sm:hidden">
              <Brand compact />
            </span>
            <span className="hidden sm:block">
              <Brand />
            </span>

            <Link
              to="/app/chat"
              aria-label={t('finance.backToChat')}
              title={t('finance.backToChat')}
              className="inline-flex size-10 items-center justify-center rounded-full border border-outline text-on-surface-variant transition hover:bg-surface-container-high hover:text-on-surface focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary sm:hidden"
            >
              <svg
                aria-hidden="true"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.7"
                strokeLinecap="round"
                strokeLinejoin="round"
                className="size-5"
              >
                <path d="M19 12H5M11 18l-6-6 6-6" />
              </svg>
            </Link>

            <nav
              aria-label={t('nav.primary')}
              className="hidden items-center gap-1 sm:flex"
            >
              <NavLink to="/app/chat" className={navLinkClasses}>
                {t('nav.chat')}
              </NavLink>
              <NavLink to="/app/finance" className={navLinkClasses}>
                {t('nav.finance')}
              </NavLink>
              <NavLink to="/app/settings" className={navLinkClasses}>
                {t('nav.settings')}
              </NavLink>
            </nav>
          </div>

          <div className="flex items-center gap-2">
            <LanguageSwitcher />
            <ThemeToggle />
          </div>
        </div>
      </header>

      <main className="mx-auto w-full max-w-6xl px-4 py-8 sm:px-6 lg:py-10">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <h1 className="font-display text-3xl font-bold tracking-tight text-on-surface">
              {t('finance.title')}
            </h1>
            <p className="mt-2 max-w-2xl text-sm leading-relaxed text-on-surface-variant">
              {t('finance.subtitle')}
            </p>
          </div>
          {period !== null && (
            <span className="rounded-full border border-outline-variant bg-surface-container px-3 py-1 text-xs font-medium text-on-surface-variant">
              {t('finance.period', { period })}
            </span>
          )}
        </div>

        <div className="mt-8">
          {financeQuery.isPending ? (
            <FinanceSkeleton />
          ) : financeQuery.isError || data === undefined ? (
            <FinanceErrorState
              error={financeQuery.error}
              onRetry={() => {
                void financeQuery.refetch();
              }}
            />
          ) : (
            <div className="space-y-6">
              <div className="grid gap-4 sm:grid-cols-3">
                <MetricCard
                  label={t('finance.metrics.revenue')}
                  value={formatMoney(revenue, currency, language)}
                />
                <MetricCard
                  label={t('finance.metrics.profit')}
                  value={formatMoney(profit, currency, language)}
                  tone={profit < 0 ? 'negative' : 'positive'}
                />
                <MetricCard
                  label={t('finance.metrics.margin')}
                  value={margin === null ? '—' : formatPercent(margin, language)}
                  tone={
                    margin === null
                      ? 'default'
                      : margin < 0
                        ? 'negative'
                        : 'positive'
                  }
                />
              </div>

              <section
                aria-labelledby="finance-unit-title"
                className={SECTION_CLASSES}
              >
                <h2
                  id="finance-unit-title"
                  className="font-display text-lg font-bold text-on-surface"
                >
                  {t('finance.unit.title')}
                </h2>
                <p className="mt-1 text-sm text-on-surface-variant">
                  {t('finance.unit.description')}
                </p>
                <div className="mt-4">
                  <UnitEconomicsTable
                    items={items}
                    currency={currency}
                    language={language}
                  />
                </div>
              </section>

              <section
                aria-labelledby="finance-leaks-title"
                className={SECTION_CLASSES}
              >
                <h2
                  id="finance-leaks-title"
                  className="font-display text-lg font-bold text-on-surface"
                >
                  {t('finance.leaks.title')}
                </h2>
                <p className="mt-1 text-sm text-on-surface-variant">
                  {t('finance.leaks.description')}
                </p>
                <div className="mt-4">
                  <ProfitLeakAlerts findings={leakFindings} />
                </div>
                {data.profitLeaks.some((result) => !result.dataAvailable) && (
                  <p className="mt-3 text-xs text-on-surface-variant">
                    {t('finance.leaks.unavailable')}
                  </p>
                )}
              </section>

              <section
                aria-labelledby="finance-fraud-title"
                className={SECTION_CLASSES}
              >
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0 max-w-2xl">
                    <h2
                      id="finance-fraud-title"
                      className="font-display text-lg font-bold text-on-surface"
                    >
                      {t('finance.fraud.title')}
                    </h2>
                    <p className="mt-1 text-sm text-on-surface-variant">
                      {t('finance.fraud.description')}
                    </p>
                  </div>
                  <span
                    className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] font-semibold ${FRAUD_CLASSES[fraudStatus]}`}
                  >
                    <span
                      aria-hidden="true"
                      className="size-1.5 rounded-full bg-current"
                    />
                    {t(FRAUD_LABEL_KEYS[fraudStatus])}
                  </span>
                </div>

                {fraudRisks.length > 0 && (
                  <div className="mt-4 rounded-xl border border-error/30 bg-error-container/60 p-4 text-on-error-container">
                    <h3 className="text-sm font-semibold">
                      {t('finance.fraud.risksLabel')}
                    </h3>
                    <ul className="mt-2 list-inside list-disc space-y-1 text-sm">
                      {fraudRisks.map((risk) => (
                        <li key={risk}>{risk}</li>
                      ))}
                    </ul>
                  </div>
                )}

                {fraudAudit?.dataAvailable === false &&
                  fraudAudit.reason !== undefined && (
                    <p className="mt-3 text-sm text-on-surface-variant">
                      {fraudAudit.reason}
                    </p>
                  )}
              </section>
            </div>
          )}
        </div>
      </main>
    </div>
  );
}

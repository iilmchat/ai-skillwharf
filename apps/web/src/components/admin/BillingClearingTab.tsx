import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  adminQueryKeys,
  fetchBillingReconciliation,
  fetchTreasurySummary,
  formatAdminDate,
  getAdminErrorMessage,
  retryOutboxItem,
  type BillingOutboxItem,
  type BillingOutboxStatus,
} from '../../lib/admin';
import { formatMoney } from '../../lib/money';

const CARD_CLASSES =
  'rounded-2xl border border-outline-variant bg-surface-container p-5';

const STATUS_CLASSES: Record<BillingOutboxStatus, string> = {
  pending: 'border-outline-variant bg-surface-container-high text-on-surface-variant',
  processing: 'border-primary/30 bg-primary-container text-on-primary-container',
  sent: 'border-success/30 bg-success/10 text-success',
  failed_dead: 'border-error/30 bg-error-container text-on-error-container',
};

function OutboxStatusBadge({ status }: { status: BillingOutboxStatus }) {
  const { t } = useTranslation();

  return (
    <span
      className={`inline-flex shrink-0 rounded-full border px-2.5 py-1 text-[11px] font-semibold ${STATUS_CLASSES[status]}`}
    >
      {t(`admin.billing.status.${status}`)}
    </span>
  );
}

function ReconciliationCard() {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [refreshNotice, setRefreshNotice] = useState<string | null>(null);
  const query = useQuery({
    queryKey: adminQueryKeys.reconciliation,
    queryFn: fetchBillingReconciliation,
    staleTime: 15_000,
  });

  function refresh(): void {
    setRefreshNotice(null);
    void queryClient.invalidateQueries({
      queryKey: adminQueryKeys.reconciliation,
    });
    setRefreshNotice(t('admin.billing.reconciliation.updated'));
  }

  const report = query.data;

  return (
    <section aria-labelledby="admin-billing-reconciliation" className={CARD_CLASSES}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h3
            id="admin-billing-reconciliation"
            className="font-display text-base font-bold text-on-surface"
          >
            {t('admin.billing.reconciliation.title')}
          </h3>
          <p className="mt-1 text-sm text-on-surface-variant">
            {t('admin.billing.reconciliation.subtitle')}
          </p>
        </div>
        <button
          type="button"
          onClick={refresh}
          disabled={query.isFetching}
          aria-busy={query.isFetching}
          className="inline-flex items-center justify-center rounded-xl border border-outline px-3 py-2 text-xs font-semibold text-on-surface-variant transition hover:bg-surface-container-high hover:text-on-surface focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary disabled:cursor-not-allowed disabled:opacity-60"
        >
          {query.isFetching
            ? t('admin.billing.reconciliation.refreshing')
            : t('admin.billing.reconciliation.refresh')}
        </button>
      </div>

      {query.isPending ? (
        <p className="mt-4 text-sm text-on-surface-variant">
          {t('admin.billing.loading')}
        </p>
      ) : query.isError ? (
        <div
          role="alert"
          className="mt-4 rounded-xl border border-error/30 bg-error-container px-3 py-2.5 text-sm text-on-error-container"
        >
          {getAdminErrorMessage(query.error, 'admin.errors.reconciliation')}
        </div>
      ) : report === undefined ? (
        <p className="mt-4 text-sm text-on-surface-variant">
          {t('admin.billing.loading')}
        </p>
      ) : (
        <>
          <div className="mt-4 flex flex-wrap items-center gap-3">
            <span
              className={`inline-flex rounded-full border px-3 py-1 text-xs font-semibold ${
                report.balanced
                  ? 'border-success/30 bg-success/10 text-success'
                  : 'border-error/30 bg-error-container text-on-error-container'
              }`}
            >
              {report.balanced
                ? t('admin.billing.reconciliation.balanced')
                : t('admin.billing.reconciliation.discrepancy', {
                    amount: formatMoney(String(report.discrepancyRub), 'ru-RU'),
                  })}
            </span>
            {report.ledgerNetRub !== undefined && (
              <span className="text-xs text-on-surface-variant">
                {t('admin.billing.reconciliation.ledgerNet', {
                  amount: formatMoney(String(report.ledgerNetRub), 'ru-RU'),
                })}
              </span>
            )}
            {report.walletsTotalRub !== undefined && (
              <span className="text-xs text-on-surface-variant">
                {t('admin.billing.reconciliation.walletsTotal', {
                  amount: formatMoney(String(report.walletsTotalRub), 'ru-RU'),
                })}
              </span>
            )}
          </div>
          {refreshNotice !== null && (
            <p role="status" className="mt-3 text-xs font-medium text-success">
              {refreshNotice}
            </p>
          )}
        </>
      )}
    </section>
  );
}

function TreasuryCard() {
  const { t, i18n } = useTranslation();
  const query = useQuery({
    queryKey: adminQueryKeys.treasury,
    queryFn: fetchTreasurySummary,
    staleTime: 15_000,
  });
  const data = query.data;

  return (
    <section aria-labelledby="admin-billing-treasury" className={CARD_CLASSES}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h3
            id="admin-billing-treasury"
            className="font-display text-base font-bold text-on-surface"
          >
            {t('admin.billing.treasury.title')}
          </h3>
          <p className="mt-1 text-sm text-on-surface-variant">
            {t('admin.billing.treasury.subtitle')}
          </p>
        </div>
      </div>

      {query.isPending ? (
        <p className="mt-4 text-sm text-on-surface-variant">
          {t('admin.billing.loading')}
        </p>
      ) : query.isError ? (
        <div
          role="alert"
          className="mt-4 rounded-xl border border-error/30 bg-error-container px-3 py-2.5 text-sm text-on-error-container"
        >
          {getAdminErrorMessage(query.error, 'admin.errors.treasury')}
        </div>
      ) : data === undefined ? (
        <p className="mt-4 text-sm text-on-surface-variant">
          {t('admin.billing.loading')}
        </p>
      ) : (
        <>
          <p className="mt-5 font-display text-3xl font-bold tracking-tight text-success">
            {formatMoney(String(data.treasuryBalanceRub), i18n.language)} ₽
          </p>
          <p className="mt-1 text-xs text-on-surface-variant">
            {t('admin.billing.treasury.balanceHint')}
          </p>
          <div className="mt-4 flex flex-wrap gap-2">
            <span className="rounded-full border border-outline-variant bg-surface-container-high px-2.5 py-1 text-[11px] font-semibold text-on-surface-variant">
              {t('admin.billing.counts.pending', {
                count: data.counts.pending,
              })}
            </span>
            <span className="rounded-full border border-success/30 bg-success/10 px-2.5 py-1 text-[11px] font-semibold text-success">
              {t('admin.billing.counts.sent', { count: data.counts.sent })}
            </span>
            <span className="rounded-full border border-error/30 bg-error-container px-2.5 py-1 text-[11px] font-semibold text-on-error-container">
              {t('admin.billing.counts.failed_dead', {
                count: data.counts.failed_dead,
              })}
            </span>
          </div>
        </>
      )}
    </section>
  );
}

function OutboxRow({
  item,
  isRetrying,
  retryError,
  onRetry,
}: {
  item: BillingOutboxItem;
  isRetrying: boolean;
  retryError: string | null;
  onRetry: () => void;
}) {
  const { t, i18n } = useTranslation();
  const canRetry = item.status === 'failed_dead';

  return (
    <>
      <tr className="transition hover:bg-surface-container/60">
        <td className="px-4 py-3 font-mono text-xs text-on-surface">
          {item.eventType}
        </td>
        <td className="max-w-48 truncate px-4 py-3 font-mono text-[11px] text-on-surface-variant">
          {item.idempotencyKey ?? '—'}
        </td>
        <td className="px-4 py-3">
          <OutboxStatusBadge status={item.status} />
        </td>
        <td className="whitespace-nowrap px-4 py-3 text-xs text-on-surface-variant">
          {t('admin.billing.outbox.attempts', {
            attempts: item.attempts,
            maxAttempts: item.maxAttempts,
          })}
        </td>
        <td className="whitespace-nowrap px-4 py-3 text-xs text-on-surface-variant">
          {formatAdminDate(item.createdAt, i18n.language)}
        </td>
        <td className="max-w-64 truncate px-4 py-3 text-xs text-on-surface-variant">
          {item.lastError ?? '—'}
        </td>
        <td className="px-4 py-3 text-right">
          <button
            type="button"
            onClick={onRetry}
            disabled={!canRetry || isRetrying}
            aria-busy={isRetrying}
            title={
              canRetry
                ? t('admin.billing.outbox.retry')
                : t('admin.billing.outbox.retryHint')
            }
            className="inline-flex items-center justify-center rounded-lg border border-primary/40 px-3 py-1.5 text-xs font-semibold text-primary transition hover:bg-primary-container focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary disabled:cursor-not-allowed disabled:opacity-50"
          >
            {isRetrying
              ? t('admin.billing.outbox.retrying')
              : t('admin.billing.outbox.retry')}
          </button>
        </td>
      </tr>
      {retryError !== null && (
        <tr>
          <td colSpan={7} className="px-4 pb-3">
            <p
              role="alert"
              className="rounded-lg border border-error/30 bg-error-container px-3 py-2 text-xs text-on-error-container"
            >
              {retryError}
            </p>
          </td>
        </tr>
      )}
    </>
  );
}

function OutboxTable() {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [retryingId, setRetryingId] = useState<string | null>(null);
  const [retryError, setRetryError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const query = useQuery({
    queryKey: adminQueryKeys.treasury,
    queryFn: fetchTreasurySummary,
    staleTime: 15_000,
  });
  const items = query.data?.recentOutbox ?? [];

  const retryMutation = useMutation({
    mutationFn: retryOutboxItem,
    onMutate: (id: string) => {
      setRetryingId(id);
      setRetryError(null);
      setNotice(null);
    },
    onSuccess: () => {
      setNotice(t('admin.billing.outbox.retrySuccess'));
      void queryClient.invalidateQueries({ queryKey: adminQueryKeys.treasury });
    },
    onError: (error) => {
      setRetryError(getAdminErrorMessage(error, 'admin.errors.retryOutbox'));
    },
    onSettled: () => {
      setRetryingId(null);
    },
  });

  return (
    <section aria-labelledby="admin-billing-outbox" className="mt-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h3
            id="admin-billing-outbox"
            className="font-display text-lg font-bold text-on-surface"
          >
            {t('admin.billing.outbox.title')}
          </h3>
          <p className="mt-1 text-sm text-on-surface-variant">
            {t('admin.billing.outbox.subtitle')}
          </p>
        </div>
        {notice !== null && (
          <p role="status" className="text-sm font-medium text-success">
            {notice}
          </p>
        )}
      </div>

      {query.isPending ? (
        <p className="mt-4 text-sm text-on-surface-variant">
          {t('admin.billing.loading')}
        </p>
      ) : query.isError ? (
        <div
          role="alert"
          className="mt-4 rounded-2xl border border-error/30 bg-error-container p-5 text-on-error-container"
        >
          {getAdminErrorMessage(query.error, 'admin.errors.treasury')}
          <button
            type="button"
            onClick={() => {
              void query.refetch();
            }}
            className="mt-3 rounded-lg bg-primary px-3 py-2 text-xs font-semibold text-on-primary transition hover:brightness-95 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
          >
            {t('admin.retry')}
          </button>
        </div>
      ) : items.length === 0 ? (
        <div className="mt-4 rounded-2xl border border-dashed border-outline px-6 py-12 text-center">
          <p className="text-sm text-on-surface-variant">
            {t('admin.billing.outbox.empty')}
          </p>
        </div>
      ) : (
        <div className="mt-4 overflow-x-auto rounded-2xl border border-outline-variant bg-surface-container">
          <table className="w-full min-w-[900px] text-left text-sm">
            <thead className="border-b border-outline-variant bg-surface-container-high text-[11px] uppercase tracking-wider text-on-surface-variant">
              <tr>
                <th scope="col" className="px-4 py-3 font-semibold">
                  {t('admin.billing.outbox.columns.eventType')}
                </th>
                <th scope="col" className="px-4 py-3 font-semibold">
                  {t('admin.billing.outbox.columns.idempotencyKey')}
                </th>
                <th scope="col" className="px-4 py-3 font-semibold">
                  {t('admin.billing.outbox.columns.status')}
                </th>
                <th scope="col" className="px-4 py-3 font-semibold">
                  {t('admin.billing.outbox.columns.attempts')}
                </th>
                <th scope="col" className="px-4 py-3 font-semibold">
                  {t('admin.billing.outbox.columns.createdAt')}
                </th>
                <th scope="col" className="px-4 py-3 font-semibold">
                  {t('admin.billing.outbox.columns.lastError')}
                </th>
                <th scope="col" className="px-4 py-3 text-right font-semibold">
                  {t('admin.billing.outbox.columns.actions')}
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-outline-variant">
              {items.map((item) => (
                <OutboxRow
                  key={item.id}
                  item={item}
                  isRetrying={retryingId === item.id && retryMutation.isPending}
                  retryError={retryingId === item.id ? retryError : null}
                  onRetry={() => retryMutation.mutate(item.id)}
                />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

export function BillingClearingTab() {
  const { t } = useTranslation();

  return (
    <div>
      <div>
        <h2 className="font-display text-xl font-bold text-on-surface">
          {t('admin.billing.title')}
        </h2>
        <p className="mt-1 text-sm text-on-surface-variant">
          {t('admin.billing.subtitle')}
        </p>
      </div>

      <div className="mt-6 grid gap-4 lg:grid-cols-2">
        <TreasuryCard />
        <ReconciliationCard />
      </div>

      <OutboxTable />
    </div>
  );
}

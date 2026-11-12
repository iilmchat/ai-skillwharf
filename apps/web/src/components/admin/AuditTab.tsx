import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import {
  adminQueryKeys,
  fetchAudit,
  formatAdminDate,
  getAdminErrorMessage,
  getAuditActor,
  getAuditTarget,
  type AuditEntry,
} from '../../lib/admin';

function actionClasses(action: string): string {
  const normalized = action.toLowerCase();

  if (normalized.includes('delete') || normalized.includes('reject')) {
    return 'bg-error-container text-on-error-container';
  }

  if (normalized.includes('create') || normalized.includes('approve')) {
    return 'bg-success/10 text-success';
  }

  if (normalized.includes('update') || normalized.includes('edit')) {
    return 'bg-primary-container text-on-primary-container';
  }

  return 'bg-surface-container-high text-on-surface-variant';
}

function AuditRow({ entry }: { entry: AuditEntry }) {
  const { i18n } = useTranslation();

  return (
    <tr className="transition hover:bg-surface-container/60">
      <td className="whitespace-nowrap px-4 py-3 text-xs text-on-surface-variant">
        {formatAdminDate(entry.createdAt, i18n.language)}
      </td>
      <td className="px-4 py-3 text-sm text-on-surface">
        {getAuditActor(entry)}
      </td>
      <td className="px-4 py-3">
        <span
          className={`inline-flex rounded-full px-2.5 py-1 font-mono text-[11px] font-semibold ${actionClasses(entry.action)}`}
        >
          {entry.action}
        </span>
      </td>
      <td className="max-w-xs truncate px-4 py-3 text-sm text-on-surface-variant">
        {getAuditTarget(entry)}
      </td>
    </tr>
  );
}

export function AuditTab() {
  const { t } = useTranslation();
  const auditQuery = useQuery({
    queryKey: adminQueryKeys.audit,
    queryFn: fetchAudit,
    staleTime: 15_000,
  });

  const entries = auditQuery.data ?? [];

  return (
    <div>
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 className="font-display text-xl font-bold text-on-surface">
            {t('admin.audit.title')}
          </h2>
          <p className="mt-1 text-sm text-on-surface-variant">
            {t('admin.audit.subtitle')}
          </p>
        </div>
        {auditQuery.data !== undefined && (
          <span className="rounded-full border border-outline-variant bg-surface-container px-3 py-1 text-xs font-medium text-on-surface-variant">
            {t('admin.audit.count', { count: entries.length })}
          </span>
        )}
      </div>

      {auditQuery.isPending ? (
        <div aria-hidden="true" className="mt-6 space-y-2">
          {[0, 1, 2, 3, 4].map((index) => (
            <div
              key={index}
              className="h-12 animate-pulse rounded-xl bg-surface-container"
            />
          ))}
          <span className="sr-only">{t('admin.audit.loading')}</span>
        </div>
      ) : auditQuery.isError ? (
        <div
          role="alert"
          className="mt-6 rounded-2xl border border-error/30 bg-error-container p-5 text-on-error-container"
        >
          <h3 className="font-display text-lg font-bold">
            {t('admin.audit.errorTitle')}
          </h3>
          <p className="mt-2 text-sm">
            {getAdminErrorMessage(auditQuery.error, 'admin.errors.audit')}
          </p>
          <button
            type="button"
            onClick={() => {
              void auditQuery.refetch();
            }}
            className="mt-3 rounded-lg bg-primary px-3 py-2 text-xs font-semibold text-on-primary transition hover:brightness-95 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
          >
            {t('admin.retry')}
          </button>
        </div>
      ) : entries.length === 0 ? (
        <div className="mt-6 rounded-2xl border border-dashed border-outline px-6 py-14 text-center">
          <h3 className="font-display text-lg font-bold text-on-surface">
            {t('admin.audit.emptyTitle')}
          </h3>
          <p className="mx-auto mt-2 max-w-md text-sm text-on-surface-variant">
            {t('admin.audit.emptyBody')}
          </p>
        </div>
      ) : (
        <div className="mt-6 overflow-x-auto rounded-2xl border border-outline-variant bg-surface-container">
          <table className="w-full min-w-[640px] text-left text-sm">
            <thead className="border-b border-outline-variant bg-surface-container-high text-[11px] uppercase tracking-wider text-on-surface-variant">
              <tr>
                <th scope="col" className="px-4 py-3 font-semibold">
                  {t('admin.audit.columns.time')}
                </th>
                <th scope="col" className="px-4 py-3 font-semibold">
                  {t('admin.audit.columns.actor')}
                </th>
                <th scope="col" className="px-4 py-3 font-semibold">
                  {t('admin.audit.columns.action')}
                </th>
                <th scope="col" className="px-4 py-3 font-semibold">
                  {t('admin.audit.columns.target')}
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-outline-variant">
              {entries.map((entry) => (
                <AuditRow key={entry.id} entry={entry} />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

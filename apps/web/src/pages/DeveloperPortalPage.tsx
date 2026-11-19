import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, NavLink } from 'react-router-dom';
import { LanguageSwitcher } from '../components/LanguageSwitcher';
import { ThemeToggle } from '../components/ThemeToggle';
import {
  DeveloperPortalError,
  developerPortalQueryKey,
  fetchDeveloperDashboard,
  getDeveloperPortalErrorMessage,
  publishDeveloperSkill,
  updateSkillPayoutAccount,
  type AuditFinding,
  type AuditStatus,
  type DeveloperSkillItem,
} from '../lib/developer-portal';
import { useAuthStore } from '../store/auth.store';

const SECTION_CLASSES =
  'rounded-2xl border border-outline-variant bg-surface p-5 shadow-sm sm:p-6';

const INPUT_CLASSES =
  'mt-2 block w-full rounded-xl border border-outline bg-surface-container px-4 py-2.5 text-sm text-on-surface outline-none transition placeholder:text-on-surface-variant/60 hover:border-primary/40 focus:border-primary focus:ring-4 focus:ring-primary/15 disabled:cursor-not-allowed disabled:opacity-60';

const PRIMARY_BUTTON_CLASSES =
  'inline-flex items-center justify-center gap-2 rounded-xl bg-primary px-4 py-2.5 text-sm font-semibold text-on-primary shadow-lg shadow-primary/20 transition hover:brightness-95 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary disabled:cursor-not-allowed disabled:opacity-60';

const MANIFEST_TEMPLATE = `---
name: my-skill
version: 1.0.0
description: Что делает навык
author: author-name
track: A
pricing:
  model: Pay-per-Call
  priceRub: 15
permissions:
  - network:api.example.com
---

# My Skill

Инструкция для агента: как и когда использовать навык.
`;

const AUDIT_BADGE_CLASSES: Record<AuditStatus, string> = {
  passed: 'border-success/30 bg-success/10 text-success',
  warning: 'border-warning/30 bg-warning-container text-on-warning-container',
  rejected: 'border-error/30 bg-error-container text-on-error-container',
};

const SEVERITY_CLASSES: Record<AuditFinding['severity'], string> = {
  critical: 'border-error/30 bg-error-container text-on-error-container',
  warning: 'border-warning/30 bg-warning-container text-on-warning-container',
  info: 'border-outline-variant bg-surface-container-high text-on-surface-variant',
};

function navLinkClasses({ isActive }: { isActive: boolean }): string {
  return `rounded-lg px-3 py-2 text-sm font-medium transition focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary ${
    isActive
      ? 'bg-primary-container text-on-primary-container'
      : 'text-on-surface-variant hover:bg-surface-container-high hover:text-on-surface'
  }`;
}

function KpiCard({ label, value }: { label: string; value: string }) {
  return (
    <div className={SECTION_CLASSES}>
      <p className="text-[11px] font-medium uppercase tracking-wider text-on-surface-variant">
        {label}
      </p>
      <p className="mt-2 font-display text-2xl font-bold tracking-tight text-on-surface">
        {value}
      </p>
    </div>
  );
}

function AuditBadge({ skill }: { skill: DeveloperSkillItem }) {
  const { t } = useTranslation();
  const findings = skill.auditFindings ?? [];
  const tooltip =
    findings.length === 0
      ? undefined
      : findings.map((finding) => `${finding.code}: ${finding.message}`).join('\n');

  return (
    <span
      title={tooltip}
      className={`inline-flex rounded-full border px-2.5 py-1 text-[11px] font-semibold ${AUDIT_BADGE_CLASSES[skill.auditStatus]}`}
    >
      {t(`developerPortal.audit.${skill.auditStatus}`)}
      {findings.length > 0 ? ` · ${findings.length}` : ''}
    </span>
  );
}

function PayoutCell({ skill }: { skill: DeveloperSkillItem }) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(skill.payoutAccountId ?? '');
  const [error, setError] = useState<string | null>(null);

  const mutation = useMutation({
    mutationFn: (account: string) => updateSkillPayoutAccount(skill.slug, account),
    onSuccess: () => {
      setEditing(false);
      setError(null);
      void queryClient.invalidateQueries({ queryKey: developerPortalQueryKey });
    },
    onError: (error: unknown) => {
      setError(getDeveloperPortalErrorMessage(error));
    },
  });

  if (!editing) {
    return (
      <div className="max-w-52">
        <button
          type="button"
          onClick={() => {
            setValue(skill.payoutAccountId ?? '');
            setEditing(true);
          }}
          className="block max-w-full truncate text-left font-mono text-xs text-primary hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
        >
          {skill.payoutAccountId ?? t('developerPortal.table.setPayout')}
        </button>
        {error !== null && <p className="mt-1 text-xs text-error">{error}</p>}
      </div>
    );
  }

  return (
    <div className="max-w-56">
      <input
        type="text"
        value={value}
        onChange={(event) => setValue(event.target.value)}
        aria-label={t('developerPortal.table.payoutLabel', { name: skill.name })}
        className="w-full rounded-lg border border-outline bg-surface-container px-2 py-1 font-mono text-xs text-on-surface outline-none focus:border-primary"
      />
      <div className="mt-1 flex gap-2">
        <button
          type="button"
          onClick={() => mutation.mutate(value)}
          disabled={mutation.isPending || value.trim() === ''}
          className="rounded-lg bg-primary px-2 py-1 text-[11px] font-semibold text-on-primary disabled:opacity-60"
        >
          {t('developerPortal.table.save')}
        </button>
        <button
          type="button"
          onClick={() => {
            setEditing(false);
            setError(null);
          }}
          className="rounded-lg border border-outline px-2 py-1 text-[11px] font-semibold text-on-surface-variant"
        >
          {t('developerPortal.table.cancel')}
        </button>
      </div>
    </div>
  );
}

function AuditFindingsList({ findings }: { findings: AuditFinding[] }) {
  const { t } = useTranslation();

  if (findings.length === 0) {
    return null;
  }

  return (
    <div className="mt-4 rounded-xl border border-error/30 bg-error-container p-4 text-on-error-container">
      <p className="text-sm font-semibold">
        {t('developerPortal.publish.findingsTitle')}
      </p>
      <ul className="mt-2 space-y-2">
        {findings.map((finding, index) => (
          <li
            key={`${finding.code}-${index}`}
            className="flex flex-wrap items-start gap-2 text-sm"
          >
            <span
              className={`inline-flex shrink-0 rounded-full border px-2 py-0.5 text-[10px] font-semibold ${SEVERITY_CLASSES[finding.severity]}`}
            >
              {t(`developerPortal.severity.${finding.severity}`)}
            </span>
            <span className="font-mono text-xs">{finding.code}</span>
            <span className="min-w-0 flex-1 break-words">{finding.message}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

export function DeveloperPortalPage() {
  const { t, i18n } = useTranslation();
  const accessToken = useAuthStore((state) => state.accessToken);
  const [manifestYaml, setManifestYaml] = useState(MANIFEST_TEMPLATE);
  const [payoutAccountId, setPayoutAccountId] = useState('');
  const [notice, setNotice] = useState<string | null>(null);

  const dashboardQuery = useQuery({
    queryKey: developerPortalQueryKey,
    queryFn: fetchDeveloperDashboard,
    enabled: accessToken !== null,
    staleTime: 15_000,
  });

  const publishMutation = useMutation({
    mutationFn: (input: { manifestYaml: string; payoutAccountId?: string }) =>
      publishDeveloperSkill(input),
    onSuccess: () => {
      setNotice(t('developerPortal.publish.success'));
      void dashboardQuery.refetch();
    },
  });

  function handleSubmit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    setNotice(null);
    publishMutation.mutate({
      manifestYaml,
      payoutAccountId: payoutAccountId.trim() === '' ? undefined : payoutAccountId,
    });
  }

  const dashboard = dashboardQuery.data;
  const findings =
    publishMutation.error instanceof DeveloperPortalError
      ? publishMutation.error.findings
      : [];

  const numberFormat = new Intl.NumberFormat(i18n.language, {
    maximumFractionDigits: 2,
  });

  return (
    <div className="min-h-svh bg-surface text-on-surface">
      <header className="sticky top-0 z-20 border-b border-outline-variant bg-surface/90 backdrop-blur">
        <div className="mx-auto flex h-16 max-w-7xl items-center justify-between gap-3 px-4 sm:px-6">
          <div className="flex min-w-0 items-center gap-2 sm:gap-4">
            <Link
              to="/app/chat"
              aria-label={t('developerPortal.backToChat')}
              className="inline-flex size-10 items-center justify-center rounded-full border border-outline text-on-surface-variant transition hover:bg-surface-container-high hover:text-on-surface focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
            >
              <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" className="size-5">
                <path d="M19 12H5M11 18l-6-6 6-6" />
              </svg>
            </Link>
            <nav aria-label={t('nav.primary')} className="hidden items-center gap-1 sm:flex">
              <NavLink to="/app/chat" className={navLinkClasses}>{t('nav.chat')}</NavLink>
              <NavLink to="/app/skills" className={navLinkClasses}>{t('nav.skills')}</NavLink>
              <NavLink to="/app/team" className={navLinkClasses}>{t('nav.team')}</NavLink>
              <NavLink to="/app/marketplace" className={navLinkClasses}>{t('nav.marketplace')}</NavLink>
              <NavLink to="/app/developer" className={navLinkClasses}>{t('nav.developer')}</NavLink>
              <NavLink to="/app/office" className={navLinkClasses}>{t('nav.office')}</NavLink>
            </nav>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <LanguageSwitcher />
            <ThemeToggle />
          </div>
        </div>
      </header>

      <main className="mx-auto w-full max-w-7xl px-4 py-8 sm:px-6 lg:py-10">
        <h1 className="font-display text-3xl font-bold tracking-tight text-on-surface">
          {t('developerPortal.title')}
        </h1>
        <p className="mt-2 max-w-2xl text-sm leading-relaxed text-on-surface-variant">
          {t('developerPortal.subtitle')}
        </p>

        <div className="mt-8 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <KpiCard
            label={t('developerPortal.kpi.skills')}
            value={numberFormat.format(dashboard?.totalSkills ?? 0)}
          />
          <KpiCard
            label={t('developerPortal.kpi.downloads')}
            value={numberFormat.format(dashboard?.totalDownloads ?? 0)}
          />
          <KpiCard
            label={t('developerPortal.kpi.revenue')}
            value={`${numberFormat.format(dashboard?.totalRevenueRub ?? 0)} ₽`}
          />
          <KpiCard
            label={t('developerPortal.kpi.pending')}
            value={`${numberFormat.format(dashboard?.pendingPayoutRub ?? 0)} ₽`}
          />
        </div>

        <div className="mt-6 grid gap-6 lg:grid-cols-2">
          <form onSubmit={handleSubmit} className={SECTION_CLASSES}>
            <h2 className="font-display text-xl font-bold text-on-surface">
              {t('developerPortal.publish.title')}
            </h2>
            <p className="mt-1 text-sm text-on-surface-variant">
              {t('developerPortal.publish.subtitle')}
            </p>

            <label htmlFor="developer-manifest" className="mt-4 block text-sm font-medium text-on-surface">
              {t('developerPortal.publish.manifestLabel')}
            </label>
            <textarea
              id="developer-manifest"
              rows={14}
              spellCheck={false}
              value={manifestYaml}
              onChange={(event) => setManifestYaml(event.target.value)}
              className={`${INPUT_CLASSES} font-mono text-xs`}
            />
            <p className="mt-2 text-xs leading-relaxed text-on-surface-variant">
              {t('developerPortal.publish.manifestHint')}
            </p>

            <label htmlFor="developer-payout" className="mt-4 block text-sm font-medium text-on-surface">
              {t('developerPortal.publish.payoutLabel')}
            </label>
            <input
              id="developer-payout"
              type="text"
              value={payoutAccountId}
              onChange={(event) => setPayoutAccountId(event.target.value)}
              placeholder={t('developerPortal.publish.payoutPlaceholder')}
              className={INPUT_CLASSES}
            />

            {publishMutation.isError && (
              <div role="alert" className="mt-4">
                <p className="text-sm font-semibold text-error">
                  {getDeveloperPortalErrorMessage(publishMutation.error)}
                </p>
                <AuditFindingsList findings={findings} />
              </div>
            )}
            {notice !== null && (
              <p role="status" className="mt-4 text-sm font-medium text-success">
                {notice}
              </p>
            )}

            <button
              type="submit"
              disabled={publishMutation.isPending || manifestYaml.trim() === ''}
              aria-busy={publishMutation.isPending}
              className={`${PRIMARY_BUTTON_CLASSES} mt-5`}
            >
              {publishMutation.isPending
                ? t('developerPortal.publish.publishing')
                : t('developerPortal.publish.submit')}
            </button>
          </form>

          <section className={SECTION_CLASSES} aria-labelledby="developer-skills-title">
            <h2 id="developer-skills-title" className="font-display text-xl font-bold text-on-surface">
              {t('developerPortal.table.title')}
            </h2>

            {dashboardQuery.isPending ? (
              <p className="mt-4 text-sm text-on-surface-variant">
                {t('developerPortal.table.loading')}
              </p>
            ) : dashboardQuery.isError ? (
              <div role="alert" className="mt-4 rounded-xl border border-error/30 bg-error-container px-3 py-2.5 text-sm text-on-error-container">
                {getDeveloperPortalErrorMessage(dashboardQuery.error)}
                <button
                  type="button"
                  onClick={() => { void dashboardQuery.refetch(); }}
                  className="mt-2 rounded-lg bg-primary px-3 py-2 text-xs font-semibold text-on-primary"
                >
                  {t('developerPortal.table.retry')}
                </button>
              </div>
            ) : (dashboard?.skills.length ?? 0) === 0 ? (
              <p className="mt-4 text-sm text-on-surface-variant">
                {t('developerPortal.table.empty')}
              </p>
            ) : (
              <div className="mt-4 overflow-x-auto rounded-2xl border border-outline-variant">
                <table className="w-full min-w-[720px] text-left text-sm">
                  <thead className="border-b border-outline-variant bg-surface-container-high text-[11px] uppercase tracking-wider text-on-surface-variant">
                    <tr>
                      <th scope="col" className="px-4 py-3 font-semibold">{t('developerPortal.table.columns.skill')}</th>
                      <th scope="col" className="px-4 py-3 font-semibold">{t('developerPortal.table.columns.pricing')}</th>
                      <th scope="col" className="px-4 py-3 font-semibold">{t('developerPortal.table.columns.downloads')}</th>
                      <th scope="col" className="px-4 py-3 font-semibold">{t('developerPortal.table.columns.audit')}</th>
                      <th scope="col" className="px-4 py-3 font-semibold">{t('developerPortal.table.columns.payout')}</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-outline-variant">
                    {(dashboard?.skills ?? []).map((skill) => (
                      <tr key={skill.id}>
                        <td className="px-4 py-3">
                          <p className="font-medium text-on-surface">{skill.name}</p>
                          <p className="font-mono text-[11px] text-on-surface-variant">v{skill.version} · {skill.slug}</p>
                        </td>
                        <td className="px-4 py-3 text-xs text-on-surface-variant">
                          {skill.pricingModel}
                          {skill.price > 0 ? ` · ${numberFormat.format(skill.price)} ₽` : ''}
                        </td>
                        <td className="px-4 py-3 text-xs text-on-surface-variant">
                          {numberFormat.format(skill.downloadsCount)}
                        </td>
                        <td className="px-4 py-3"><AuditBadge skill={skill} /></td>
                        <td className="px-4 py-3"><PayoutCell skill={skill} /></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>
        </div>
      </main>
    </div>
  );
}

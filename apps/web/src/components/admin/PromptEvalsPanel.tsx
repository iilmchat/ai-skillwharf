import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { ZodError } from 'zod';
import {
  adminQueryKeys,
  fetchPromptEvals,
  formatAdminDate,
  getAdminErrorMessage,
  PROMPT_EVAL_TRACK_IDS,
  runPromptEval,
  type PromptEvalRun,
  type PromptEvalTrackId,
  type PromptVersion,
  type RunPromptEvalInput,
} from '../../lib/admin';

interface PromptEvalsPanelProps {
  promptId: string;
  versions: PromptVersion[];
}

function versionLabel(id: string, versions: PromptVersion[]): string {
  const version = versions.find((item) => item.id === id);

  if (version === undefined) {
    return id;
  }

  return version.version === undefined ? version.id : `v${version.version}`;
}

function formatNumber(value: number, fractionDigits = 1): string {
  return new Intl.NumberFormat('ru-RU', {
    minimumFractionDigits: fractionDigits,
    maximumFractionDigits: fractionDigits,
  }).format(value);
}

function StatusBadge({ status }: { status: PromptEvalRun['status'] }) {
  const { t } = useTranslation();
  const classes =
    status === 'passed'
      ? 'bg-success/15 text-success'
      : status === 'failed'
        ? 'bg-error-container text-on-error-container'
        : 'bg-primary-container text-on-primary-container';

  return (
    <span
      className={`inline-flex shrink-0 rounded-full px-2.5 py-1 text-[10px] font-semibold uppercase tracking-wide ${classes}`}
    >
      {t(`admin.evals.status.${status}`)}
    </span>
  );
}

function CaseDetails({ run }: { run: PromptEvalRun }): ReactNode {
  const { t } = useTranslation();

  return (
    <details className="group mt-3 rounded-lg border border-outline-variant bg-surface">
      <summary className="cursor-pointer list-none px-3 py-2 text-xs font-semibold text-on-surface-variant transition hover:text-on-surface focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary [&::-webkit-details-marker]:hidden">
        <span className="inline-flex items-center gap-2">
          <svg
            aria-hidden="true"
            viewBox="0 0 20 20"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.8"
            strokeLinecap="round"
            strokeLinejoin="round"
            className="size-3.5 transition group-open:rotate-90"
          >
            <path d="m7 4 6 6-6 6" />
          </svg>
          {t('admin.evals.details', { count: run.results?.length ?? 0 })}
        </span>
      </summary>

      <div className="border-t border-outline-variant px-3 py-2">
        {run.results === undefined || run.results.length === 0 ? (
          <p className="py-2 text-xs text-on-surface-variant">
            {t('admin.evals.noResults')}
          </p>
        ) : (
          <ul className="divide-y divide-outline-variant">
            {run.results.map((result) => (
              <li key={result.caseId} className="py-2.5 text-xs">
                <div className="flex flex-wrap items-center gap-2">
                  <span
                    className={`rounded-full px-2 py-0.5 font-semibold ${
                      result.passed
                        ? 'bg-success/15 text-success'
                        : 'bg-error-container text-on-error-container'
                    }`}
                  >
                    {result.passed
                      ? t('admin.evals.case.passed')
                      : t('admin.evals.case.failed')}
                  </span>
                  <span className="font-mono text-on-surface-variant">
                    {result.caseId}
                  </span>
                  <span className="text-on-surface-variant">{result.trackId}</span>
                  <span className="tabular-nums text-on-surface-variant">
                    {t('admin.evals.case.score', {
                      score: formatNumber(result.score),
                    })}
                  </span>
                </div>
                <p className="mt-1 font-medium text-on-surface">{result.title}</p>
                <p
                  className={`mt-1 leading-relaxed ${
                    result.passed
                      ? 'text-on-surface-variant'
                      : 'text-on-error-container'
                  }`}
                >
                  {result.reasoning}
                </p>
              </li>
            ))}
          </ul>
        )}
      </div>
    </details>
  );
}

function EvalRunCard({
  run,
  versions,
  language,
}: {
  run: PromptEvalRun;
  versions: PromptVersion[];
  language: string;
}) {
  const { t } = useTranslation();

  return (
    <li className="rounded-xl border border-outline-variant bg-surface-container p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h4 className="font-display text-base font-bold text-on-surface">
              {versionLabel(run.versionId, versions)}
            </h4>
            <StatusBadge status={run.status} />
          </div>
          <p className="mt-1 text-xs text-on-surface-variant">
            {run.trackFilter == null
              ? t('admin.evals.allTracks')
              : t('admin.evals.track', { track: run.trackFilter })}
          </p>
          <p className="mt-0.5 text-[11px] text-on-surface-variant">
            {t('admin.evals.createdAt', {
              date: formatAdminDate(run.createdAt, language),
            })}
          </p>
        </div>
        <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-on-surface-variant">
          <span className="tabular-nums">
            {t('admin.evals.passRate', {
              value: formatNumber(run.passRate),
            })}
          </span>
          <span className="tabular-nums">
            {t('admin.evals.avgScore', {
              value: (run.avgScore / 100).toFixed(2),
            })}
          </span>
          <span className="tabular-nums">
            {t('admin.evals.cases', {
              passed: run.passedCases,
              total: run.totalCases,
            })}
          </span>
        </div>
      </div>

      <CaseDetails run={run} />
    </li>
  );
}

/** Панель автоматической оценки качества промптов в drawer'е версий. */
export function PromptEvalsPanel({
  promptId,
  versions,
}: PromptEvalsPanelProps) {
  const { t, i18n } = useTranslation();
  const queryClient = useQueryClient();
  const [versionId, setVersionId] = useState('');
  const [trackId, setTrackId] = useState<PromptEvalTrackId | ''>('');
  const [notice, setNotice] = useState<{
    tone: 'success' | 'error';
    message: string;
  } | null>(null);

  const versionValue =
    versionId !== '' && versions.some((item) => item.id === versionId)
      ? versionId
      : (versions[0]?.id ?? '');

  const evalsQuery = useQuery({
    queryKey: adminQueryKeys.promptEvals(promptId),
    queryFn: () => fetchPromptEvals(promptId),
    staleTime: 15_000,
  });

  const runMutation = useMutation({
    mutationFn: (input: RunPromptEvalInput) =>
      runPromptEval(promptId, input),
    onSuccess: () => {
      setNotice({ tone: 'success', message: t('admin.evals.started') });
      void queryClient.invalidateQueries({
        queryKey: adminQueryKeys.promptEvals(promptId),
      });
    },
    onError: (error) => {
      setNotice({
        tone: 'error',
        message:
          error instanceof ZodError
            ? t('admin.evals.errors.invalid')
            : getAdminErrorMessage(error, 'admin.evals.errors.run'),
      });
    },
  });

  const runs = evalsQuery.data ?? [];

  function handleSubmit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();

    if (versionValue === '') {
      setNotice({
        tone: 'error',
        message: t('admin.evals.errors.needVersion'),
      });
      return;
    }

    setNotice(null);
    runMutation.mutate({
      versionId: versionValue,
      ...(trackId === '' ? {} : { trackId }),
    });
  }

  function queryError(error: unknown): string {
    return error instanceof ZodError
      ? t('admin.evals.errors.invalid')
      : getAdminErrorMessage(error, 'admin.evals.errors.load');
  }

  return (
    <section className="mt-8 border-t border-outline-variant pt-6">
      <h3 className="font-display text-lg font-bold text-on-surface">
        {t('admin.evals.title')}
      </h3>
      <p className="mt-1 text-sm leading-relaxed text-on-surface-variant">
        {t('admin.evals.subtitle')}
      </p>

      <form
        onSubmit={handleSubmit}
        className="mt-4 rounded-xl border border-outline-variant bg-surface p-4"
      >
        <div className="grid gap-3 sm:grid-cols-2">
          <div>
            <label
              htmlFor="admin-eval-version"
              className="block text-xs font-semibold uppercase tracking-wide text-on-surface-variant"
            >
              {t('admin.evals.versionLabel')}
            </label>
            <select
              id="admin-eval-version"
              value={versionValue}
              disabled={versions.length === 0}
              onChange={(event) => setVersionId(event.target.value)}
              className="mt-1.5 w-full rounded-lg border border-outline bg-surface-container px-3 py-2 text-sm text-on-surface focus:border-primary disabled:opacity-60"
            >
              <option value="">{t('admin.evals.selectVersion')}</option>
              {versions.map((version) => (
                <option key={version.id} value={version.id}>
                  {versionLabel(version.id, [version])}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label
              htmlFor="admin-eval-track"
              className="block text-xs font-semibold uppercase tracking-wide text-on-surface-variant"
            >
              {t('admin.evals.trackLabel')}
            </label>
            <select
              id="admin-eval-track"
              value={trackId}
              onChange={(event) =>
                setTrackId(event.target.value as PromptEvalTrackId | '')
              }
              className="mt-1.5 w-full rounded-lg border border-outline bg-surface-container px-3 py-2 text-sm text-on-surface focus:border-primary"
            >
              <option value="">{t('admin.evals.allTracks')}</option>
              {PROMPT_EVAL_TRACK_IDS.map((id) => (
                <option key={id} value={id}>
                  {id} · {t(`marketplace.tracks.${id}`)}
                </option>
              ))}
            </select>
          </div>
        </div>

        <button
          type="submit"
          disabled={runMutation.isPending || versionValue === ''}
          aria-busy={runMutation.isPending}
          className="mt-4 inline-flex items-center gap-2 rounded-xl bg-primary px-4 py-2 text-sm font-semibold text-on-primary transition hover:brightness-95 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary disabled:cursor-not-allowed disabled:opacity-60"
        >
          {runMutation.isPending && (
            <svg
              aria-hidden="true"
              viewBox="0 0 20 20"
              fill="none"
              className="size-4 animate-spin"
            >
              <circle
                cx="10"
                cy="10"
                r="8"
                stroke="currentColor"
                strokeOpacity="0.25"
                strokeWidth="2.5"
              />
              <path
                d="M10 2a8 8 0 0 1 8 8"
                stroke="currentColor"
                strokeWidth="2.5"
                strokeLinecap="round"
              />
            </svg>
          )}
          {runMutation.isPending
            ? t('admin.evals.running')
            : t('admin.evals.run')}
        </button>
      </form>

      {notice !== null && (
        <p
          role="status"
          className={`mt-4 text-sm ${
            notice.tone === 'success' ? 'text-success' : 'text-error'
          }`}
        >
          {notice.message}
        </p>
      )}

      <div className="mt-6" aria-live="polite" aria-busy={evalsQuery.isFetching}>
        {evalsQuery.isPending ? (
          <p className="text-sm text-on-surface-variant">
            {t('admin.evals.loading')}
          </p>
        ) : evalsQuery.isError ? (
          <div
            role="alert"
            className="rounded-xl border border-error/30 bg-error-container p-4 text-sm text-on-error-container"
          >
            <p>{queryError(evalsQuery.error)}</p>
            <button
              type="button"
              onClick={() => {
                void evalsQuery.refetch();
              }}
              className="mt-2 rounded-lg bg-primary px-3 py-1.5 text-xs font-semibold text-on-primary"
            >
              {t('admin.retry')}
            </button>
          </div>
        ) : runs.length === 0 ? (
          <p className="text-sm text-on-surface-variant">
            {t('admin.evals.empty')}
          </p>
        ) : (
          <ul className="space-y-3">
            {runs.map((run) => (
              <EvalRunCard
                key={run.id}
                run={run}
                versions={versions}
                language={i18n.resolvedLanguage ?? i18n.language}
              />
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}

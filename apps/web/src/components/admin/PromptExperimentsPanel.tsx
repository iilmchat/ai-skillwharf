import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { ZodError } from 'zod';
import {
  adminQueryKeys,
  createPromptExperiment,
  type CreatePromptExperimentInput,
  createPromptExperimentSchema,
  fetchPromptExperiments,
  formatAdminDate,
  getAdminErrorMessage,
  isPromptExperimentActive,
  stopPromptExperiment,
  type PromptExperiment,
  type PromptVersion,
} from '../../lib/admin';

interface PromptExperimentsPanelProps {
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

function StatsValue({
  value,
  suffix,
}: {
  value: number | undefined;
  suffix: string;
}): ReactNode {
  if (value === undefined) {
    return '—';
  }

  return `${new Intl.NumberFormat('ru-RU', {
    maximumFractionDigits: 2,
  }).format(value)}${suffix}`;
}

function ExperimentCard({
  experiment,
  versions,
  isStopping,
  onStop,
  onPromote,
}: {
  experiment: PromptExperiment;
  versions: PromptVersion[];
  isStopping: boolean;
  onStop: (experiment: PromptExperiment) => void;
  onPromote: (experiment: PromptExperiment) => void;
}) {
  const { t, i18n } = useTranslation();
  const isActive = isPromptExperimentActive(experiment);
  const statsA = experiment.metrics?.A;
  const statsB = experiment.metrics?.B;

  return (
    <li className="rounded-xl border border-outline-variant bg-surface-container p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h4 className="font-display text-base font-bold text-on-surface">
              {experiment.name}
            </h4>
            <span
              className={`rounded-full px-2.5 py-1 text-[10px] font-semibold uppercase tracking-wide ${
                isActive
                  ? 'bg-primary-container text-on-primary-container'
                  : 'border border-outline-variant text-on-surface-variant'
              }`}
            >
              {isActive
                ? t('admin.experiments.status.active')
                : t('admin.experiments.status.stopped')}
            </span>
          </div>
          <p className="mt-1 text-xs text-on-surface-variant">
            {t('admin.experiments.traffic', {
              a: 100 - experiment.trafficSplitB,
              b: experiment.trafficSplitB,
            })}
          </p>
          <p className="mt-0.5 text-[11px] text-on-surface-variant">
            {t('admin.experiments.createdAt', {
              date: formatAdminDate(experiment.createdAt, i18n.language),
            })}
          </p>
        </div>

        {isActive && (
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              disabled={isStopping}
              onClick={() => onStop(experiment)}
              className="rounded-lg border border-outline px-3 py-1.5 text-xs font-semibold text-on-surface-variant transition hover:border-primary/40 hover:text-on-surface focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary disabled:cursor-not-allowed disabled:opacity-60"
            >
              {t('admin.experiments.stop')}
            </button>
            <button
              type="button"
              disabled={isStopping}
              onClick={() => onPromote(experiment)}
              title={t('admin.experiments.promoteHint')}
              className="rounded-lg bg-primary px-3 py-1.5 text-xs font-semibold text-on-primary transition hover:brightness-95 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary disabled:cursor-not-allowed disabled:opacity-60"
            >
              {t('admin.experiments.promoteB')}
            </button>
          </div>
        )}
      </div>

      <div className="mt-4 overflow-x-auto">
        <table className="w-full min-w-72 border-collapse text-left text-sm">
          <thead>
            <tr className="border-b border-outline-variant text-xs text-on-surface-variant">
              <th scope="col" className="py-2 pr-3 font-medium">
                {t('admin.experiments.metrics.metric')}
              </th>
              <th scope="col" className="py-2 pr-3 font-medium">
                {t('admin.experiments.metrics.variant', {
                  letter: 'A',
                  version: versionLabel(experiment.variantAVersionId, versions),
                })}
              </th>
              <th scope="col" className="py-2 font-medium">
                {t('admin.experiments.metrics.variant', {
                  letter: 'B',
                  version: versionLabel(experiment.variantBVersionId, versions),
                })}
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-outline-variant">
            <tr>
              <th scope="row" className="py-2 pr-3 font-normal text-on-surface-variant">
                {t('admin.experiments.metrics.calls')}
              </th>
              <td className="py-2 pr-3 tabular-nums text-on-surface">
                <StatsValue value={statsA?.calls} suffix="" />
              </td>
              <td className="py-2 tabular-nums text-on-surface">
                <StatsValue value={statsB?.calls} suffix="" />
              </td>
            </tr>
            <tr>
              <th scope="row" className="py-2 pr-3 font-normal text-on-surface-variant">
                {t('admin.experiments.metrics.latency')}
              </th>
              <td className="py-2 pr-3 tabular-nums text-on-surface">
                <StatsValue
                  value={statsA?.avgLatencyMs}
                  suffix={t('admin.experiments.units.ms')}
                />
              </td>
              <td className="py-2 tabular-nums text-on-surface">
                <StatsValue
                  value={statsB?.avgLatencyMs}
                  suffix={t('admin.experiments.units.ms')}
                />
              </td>
            </tr>
            <tr>
              <th scope="row" className="py-2 pr-3 font-normal text-on-surface-variant">
                {t('admin.experiments.metrics.cost')}
              </th>
              <td className="py-2 pr-3 tabular-nums text-on-surface">
                <StatsValue
                  value={statsA?.avgCost}
                  suffix={t('admin.experiments.units.rub')}
                />
              </td>
              <td className="py-2 tabular-nums text-on-surface">
                <StatsValue
                  value={statsB?.avgCost}
                  suffix={t('admin.experiments.units.rub')}
                />
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </li>
  );
}

/** Блок A/B-тестирования в drawer'е версий шаблона. */
export function PromptExperimentsPanel({
  promptId,
  versions,
}: PromptExperimentsPanelProps) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [name, setName] = useState('');
  const [variantA, setVariantA] = useState('');
  const [variantB, setVariantB] = useState('');
  const [trafficSplitB, setTrafficSplitB] = useState(50);
  const [formError, setFormError] = useState<string | null>(null);
  const [notice, setNotice] = useState<{
    tone: 'success' | 'error';
    message: string;
  } | null>(null);

  // Значения по умолчанию выводим из актуального списка версий во время
  // рендера: effect с setState здесь создавал бы лишний проход рендера.
  const versionAValue =
    variantA !== '' && versions.some((item) => item.id === variantA)
      ? variantA
      : (versions[0]?.id ?? '');
  const versionBValue =
    variantB !== '' && versions.some((item) => item.id === variantB)
      ? variantB
      : (versions[1]?.id ?? '');

  const experimentsQuery = useQuery({
    queryKey: adminQueryKeys.promptExperiments(promptId),
    queryFn: () => fetchPromptExperiments(promptId),
    staleTime: 15_000,
  });

  const createMutation = useMutation({
    mutationFn: (input: CreatePromptExperimentInput) =>
      createPromptExperiment(promptId, input),
    onSuccess: () => {
      setName('');
      setFormError(null);
      setNotice({ tone: 'success', message: t('admin.experiments.created') });
      void queryClient.invalidateQueries({
        queryKey: adminQueryKeys.promptExperiments(promptId),
      });
    },
    onError: (error) => {
      setFormError(
        error instanceof ZodError
          ? t('admin.experiments.errors.invalid')
          : getAdminErrorMessage(error, 'admin.experiments.errors.create'),
      );
    },
  });

  const stopMutation = useMutation({
    mutationFn: ({
      expId,
      promoteVersionId,
    }: {
      expId: string;
      promoteVersionId?: string;
    }) => stopPromptExperiment(expId, promoteVersionId),
    onSuccess: (_result, { promoteVersionId }) => {
      setNotice({
        tone: 'success',
        message:
          promoteVersionId === undefined
            ? t('admin.experiments.stopped')
            : t('admin.experiments.promoted'),
      });
      void queryClient.invalidateQueries({
        queryKey: adminQueryKeys.promptExperiments(promptId),
      });
    },
    onError: (error) => {
      // errors.eval_gate_failed приходит в ApiErrorBody.code и переводится
      // getAdminErrorMessage: версию B нельзя повысить без пройденного Eval.
      setNotice({
        tone: 'error',
        message:
          error instanceof ZodError
            ? t('admin.experiments.errors.invalid')
            : getAdminErrorMessage(error, 'admin.experiments.errors.stop'),
      });
    },
  });

  const experiments = experimentsQuery.data ?? [];

  function handleSubmit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();

    if (versions.length < 2) {
      setFormError(t('admin.experiments.errors.needVersions'));
      return;
    }

    if (versionAValue === versionBValue) {
      setFormError(t('admin.experiments.errors.sameVersion'));
      return;
    }

    const payload = createPromptExperimentSchema.safeParse({
      name,
      variantAVersionId: versionAValue,
      variantBVersionId: versionBValue,
      trafficSplitB,
    });

    if (!payload.success) {
      setFormError(t('admin.experiments.errors.invalid'));
      return;
    }

    setFormError(null);
    setNotice(null);
    createMutation.mutate(payload.data);
  }

  function queryError(error: unknown): string {
    return error instanceof ZodError
      ? t('admin.experiments.errors.invalid')
      : getAdminErrorMessage(error, 'admin.experiments.errors.load');
  }

  return (
    <section className="mt-8 border-t border-outline-variant pt-6">
      <h3 className="font-display text-lg font-bold text-on-surface">
        {t('admin.experiments.title')}
      </h3>
      <p className="mt-1 text-sm leading-relaxed text-on-surface-variant">
        {t('admin.experiments.subtitle')}
      </p>

      <form
        onSubmit={handleSubmit}
        className="mt-4 rounded-xl border border-outline-variant bg-surface p-4"
      >
        <label
          htmlFor="admin-experiment-name"
          className="block text-xs font-semibold uppercase tracking-wide text-on-surface-variant"
        >
          {t('admin.experiments.nameLabel')}
        </label>
        <input
          id="admin-experiment-name"
          type="text"
          value={name}
          maxLength={128}
          onChange={(event) => setName(event.target.value)}
          placeholder={t('admin.experiments.namePlaceholder')}
          className="mt-1.5 w-full rounded-lg border border-outline bg-surface-container px-3 py-2 text-sm text-on-surface outline-none transition placeholder:text-on-surface-variant/60 focus:border-primary"
        />

        <div className="mt-4 grid gap-3 sm:grid-cols-2">
          <div>
            <label
              htmlFor="admin-experiment-variant-a"
              className="block text-xs font-semibold uppercase tracking-wide text-on-surface-variant"
            >
              {t('admin.experiments.variantA')}
            </label>
            <select
              id="admin-experiment-variant-a"
              value={versionAValue}
              onChange={(event) => setVariantA(event.target.value)}
              className="mt-1.5 w-full rounded-lg border border-outline bg-surface-container px-3 py-2 text-sm text-on-surface focus:border-primary"
            >
              <option value="">{t('admin.experiments.selectVersion')}</option>
              {versions.map((version) => (
                <option key={version.id} value={version.id}>
                  {versionLabel(version.id, [version])}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label
              htmlFor="admin-experiment-variant-b"
              className="block text-xs font-semibold uppercase tracking-wide text-on-surface-variant"
            >
              {t('admin.experiments.variantB')}
            </label>
            <select
              id="admin-experiment-variant-b"
              value={versionBValue}
              onChange={(event) => setVariantB(event.target.value)}
              className="mt-1.5 w-full rounded-lg border border-outline bg-surface-container px-3 py-2 text-sm text-on-surface focus:border-primary"
            >
              <option value="">{t('admin.experiments.selectVersion')}</option>
              {versions.map((version) => (
                <option key={version.id} value={version.id}>
                  {versionLabel(version.id, [version])}
                </option>
              ))}
            </select>
          </div>
        </div>

        <div className="mt-4">
          <label
            htmlFor="admin-experiment-traffic"
            className="flex flex-wrap items-center justify-between gap-2 text-xs font-semibold uppercase tracking-wide text-on-surface-variant"
          >
            <span>{t('admin.experiments.trafficLabel')}</span>
            <span className="tabular-nums text-on-surface">
              {t('admin.experiments.traffic', { a: 100 - trafficSplitB, b: trafficSplitB })}
            </span>
          </label>
          <input
            id="admin-experiment-traffic"
            type="range"
            min={10}
            max={90}
            step={5}
            value={trafficSplitB}
            onChange={(event) => setTrafficSplitB(Number(event.target.value))}
            className="mt-3 w-full accent-primary"
          />
        </div>

        {formError !== null && (
          <p role="alert" className="mt-3 text-sm text-error">
            {formError}
          </p>
        )}

        <button
          type="submit"
          disabled={createMutation.isPending}
          className="mt-4 inline-flex items-center justify-center rounded-xl bg-primary px-4 py-2 text-sm font-semibold text-on-primary transition hover:brightness-95 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary disabled:cursor-not-allowed disabled:opacity-60"
        >
          {createMutation.isPending
            ? t('admin.experiments.starting')
            : t('admin.experiments.start')}
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

      <div className="mt-6" aria-live="polite" aria-busy={experimentsQuery.isFetching}>
        {experimentsQuery.isPending ? (
          <p className="text-sm text-on-surface-variant">
            {t('admin.experiments.loading')}
          </p>
        ) : experimentsQuery.isError ? (
          <div
            role="alert"
            className="rounded-xl border border-error/30 bg-error-container p-4 text-sm text-on-error-container"
          >
            <p>{queryError(experimentsQuery.error)}</p>
            <button
              type="button"
              onClick={() => {
                void experimentsQuery.refetch();
              }}
              className="mt-2 rounded-lg bg-primary px-3 py-1.5 text-xs font-semibold text-on-primary"
            >
              {t('admin.retry')}
            </button>
          </div>
        ) : experiments.length === 0 ? (
          <p className="text-sm text-on-surface-variant">
            {t('admin.experiments.empty')}
          </p>
        ) : (
          <ul className="space-y-3">
            {experiments.map((experiment) => (
              <ExperimentCard
                key={experiment.id}
                experiment={experiment}
                versions={versions}
                isStopping={stopMutation.isPending}
                onStop={(item) => {
                  setNotice(null);
                  stopMutation.mutate({ expId: item.id });
                }}
                onPromote={(item) => {
                  setNotice(null);
                  stopMutation.mutate({
                    expId: item.id,
                    promoteVersionId: item.variantBVersionId,
                  });
                }}
              />
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}

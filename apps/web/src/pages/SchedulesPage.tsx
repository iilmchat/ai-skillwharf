import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { Brand } from '../components/Brand';
import { ErrorToast } from '../components/ErrorToast';
import { LanguageSwitcher } from '../components/LanguageSwitcher';
import { ThemeToggle } from '../components/ThemeToggle';
import { fetchCorpChannels } from '../lib/corp-channels';
import {
  createWorkspaceSchedule,
  CRON_PRESETS,
  deleteWorkspaceSchedule,
  fetchWorkspaceSchedules,
  getCronPresetId,
  getSchedulesErrorKind,
  runScheduleNow,
  schedulesQueryKey,
  updateWorkspaceSchedule,
  type CronPresetId,
  type DeliveryChannelType,
  type ScheduledJob,
} from '../lib/schedules';
import { fetchTelegramChannels } from '../lib/telegram-channels';
import {
  createScheduledJobSchema,
  type CreateScheduledJobInput,
} from '../lib/schedules';
import {
  fetchWorkspaces,
  resolveActiveWorkspace,
  workspaceQueryKeys,
} from '../lib/workspaces';
import { useAuthStore } from '../store/auth.store';
import { useWorkspaceStore } from '../store/workspace.store';

const SECTION_CLASSES =
  'rounded-2xl border border-outline-variant bg-surface-container p-5 shadow-sm sm:p-6';

const BUTTON_CLASSES =
  'inline-flex items-center justify-center rounded-lg bg-primary px-3 py-2 text-xs font-semibold text-on-primary transition hover:brightness-95 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary disabled:cursor-not-allowed disabled:opacity-40';

const INPUT_CLASSES =
  'mt-1 h-10 w-full rounded-lg border border-outline-variant bg-surface px-3 text-sm text-on-surface outline-none transition placeholder:text-on-surface-variant/60 focus:border-primary focus:ring-4 focus:ring-primary/15 disabled:opacity-60';

type PresetChoice = CronPresetId | 'custom';

const PRESET_CHOICES: readonly PresetChoice[] = [
  'weekdays_morning',
  'hourly',
  'monday_morning',
  'custom',
];

function formatIso(value: string): string {
  return value.replace('T', ' ').slice(0, 16);
}

function JobCard({
  job,
  onToggle,
  onRun,
  onDelete,
  isRunning,
  isMutating,
}: {
  job: ScheduledJob;
  onToggle: (job: ScheduledJob) => void;
  onRun: (job: ScheduledJob) => void;
  onDelete: (job: ScheduledJob) => void;
  isRunning: boolean;
  isMutating: boolean;
}) {
  const { t } = useTranslation();
  const presetId = getCronPresetId(job.cronExpression);
  const description =
    presetId === null
      ? t('schedules.cron.custom', { expression: job.cronExpression })
      : t(`schedules.presets.${presetId}.label`);

  return (
    <li className="rounded-xl border border-outline-variant bg-surface-container-high p-4">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <h3 className="truncate text-sm font-semibold text-on-surface">
            {job.name}
          </h3>
          <p className="mt-1 text-xs text-on-surface-variant">{description}</p>
          <p className="mt-0.5 font-mono text-[11px] text-on-surface-variant">
            {job.cronExpression} · {job.timezone}
          </p>
        </div>
        <span
          className={`rounded-full px-2 py-0.5 text-[10px] font-semibold ${
            job.isActive
              ? 'bg-tertiary-container text-on-tertiary-container'
              : 'bg-surface-container text-on-surface-variant'
          }`}
        >
          {t(job.isActive ? 'schedules.job.active' : 'schedules.job.paused')}
        </span>
      </div>

      <p className="mt-3 line-clamp-2 text-xs leading-relaxed text-on-surface">
        {job.prompt}
      </p>

      <div className="mt-3 grid gap-1 text-[11px] text-on-surface-variant sm:grid-cols-2">
        <span>{t('schedules.job.nextRun', { date: formatIso(job.nextRunAt) })}</span>
        {job.lastRunAt !== undefined && job.lastRunAt !== null && (
          <span>{t('schedules.job.lastRun', { date: formatIso(job.lastRunAt) })}</span>
        )}
        {job.lastRunStatus !== undefined && job.lastRunStatus !== null && (
          <span
            className={
              job.lastRunStatus === 'failed' ? 'text-error' : 'text-tertiary'
            }
          >
            {t(`schedules.job.status.${job.lastRunStatus}`)}
            {job.lastRunDurationMs !== undefined &&
              ` · ${t('schedules.job.duration', {
                seconds: (job.lastRunDurationMs / 1000).toFixed(1),
              })}`}
          </span>
        )}
        {job.lastRunSummary !== undefined &&
          job.lastRunSummary !== null &&
          job.lastRunSummary !== '' && (
            <span className="sm:col-span-2">{job.lastRunSummary}</span>
          )}
      </div>

      <div className="mt-4 flex flex-wrap gap-2">
        <button
          type="button"
          onClick={() => onToggle(job)}
          disabled={isMutating}
          aria-pressed={job.isActive}
          className="rounded-lg border border-outline px-3 py-2 text-[11px] font-medium text-on-surface-variant transition hover:bg-surface-container focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary disabled:opacity-40"
        >
          {t(job.isActive ? 'schedules.job.pause' : 'schedules.job.resume')}
        </button>
        <button
          type="button"
          onClick={() => onRun(job)}
          disabled={isRunning}
          aria-busy={isRunning}
          className="rounded-lg border border-primary/40 px-3 py-2 text-[11px] font-medium text-primary transition hover:bg-primary-container focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary disabled:opacity-40"
        >
          {t('schedules.job.runNow')}
        </button>
        <button
          type="button"
          onClick={() => onDelete(job)}
          disabled={isMutating}
          className="rounded-lg border border-error/40 px-3 py-2 text-[11px] font-medium text-on-error transition hover:bg-error-container focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-error disabled:opacity-40"
        >
          {t('schedules.job.delete')}
        </button>
      </div>
    </li>
  );
}

/** Управление расписаниями и утренними дайджестами (CRON-43.3). */
export function SchedulesPage() {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const accessToken = useAuthStore((state) => state.accessToken);
  const activeWorkspaceId = useWorkspaceStore(
    (state) => state.activeWorkspaceId,
  );
  const [preset, setPreset] = useState<PresetChoice>('weekdays_morning');
  const [name, setName] = useState('');
  const [cronExpression, setCronExpression] = useState<string>(
    CRON_PRESETS.weekdays_morning.cronExpression,
  );
  const [timezone, setTimezone] = useState<string>(
    CRON_PRESETS.weekdays_morning.timezone,
  );
  const [prompt, setPrompt] = useState('');
  const [deliveryChannelType, setDeliveryChannelType] =
    useState<DeliveryChannelType>('none');
  const [deliveryChannelId, setDeliveryChannelId] = useState('');
  const [deliveryChatId, setDeliveryChatId] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const workspacesQuery = useQuery({
    queryKey: workspaceQueryKeys.workspaces,
    queryFn: fetchWorkspaces,
    enabled: accessToken !== null,
    staleTime: 30_000,
  });
  const workspaceId =
    resolveActiveWorkspace(workspacesQuery.data ?? [], activeWorkspaceId)?.id ??
    null;

  const jobsQuery = useQuery({
    queryKey: schedulesQueryKey(workspaceId ?? ''),
    queryFn: () => fetchWorkspaceSchedules(workspaceId ?? ''),
    enabled: workspaceId !== null,
    retry: false,
  });
  const telegramQuery = useQuery({
    queryKey: ['telegram', 'channels', workspaceId ?? ''],
    queryFn: () => fetchTelegramChannels(workspaceId ?? ''),
    enabled: workspaceId !== null && deliveryChannelType === 'telegram',
    retry: false,
  });
  const corpQuery = useQuery({
    queryKey: ['corporate', 'channels', workspaceId ?? ''],
    queryFn: () => fetchCorpChannels(workspaceId ?? ''),
    enabled: workspaceId !== null && deliveryChannelType === 'corporate',
    retry: false,
  });

  function handleError(cause: unknown): void {
    setError(t(`schedules.errors.${getSchedulesErrorKind(cause)}`));
  }

  function invalidate(): void {
    void queryClient.invalidateQueries({
      queryKey: schedulesQueryKey(workspaceId ?? ''),
    });
  }

  const createMutation = useMutation({
    mutationFn: (payload: CreateScheduledJobInput) =>
      createWorkspaceSchedule(workspaceId ?? '', payload),
    onSuccess: () => {
      setName('');
      setPrompt('');
      setError(null);
      setNotice(t('schedules.created'));
      invalidate();
    },
    onError: handleError,
  });

  const deleteMutation = useMutation({
    mutationFn: (jobId: string) =>
      deleteWorkspaceSchedule(workspaceId ?? '', jobId),
    onSuccess: () => {
      setError(null);
      setNotice(t('schedules.deleted'));
      invalidate();
    },
    onError: handleError,
  });

  const toggleMutation = useMutation({
    mutationFn: (job: ScheduledJob) =>
      updateWorkspaceSchedule(workspaceId ?? '', job.id, {
        isActive: !job.isActive,
      }),
    onSuccess: () => {
      setError(null);
      invalidate();
    },
    onError: handleError,
  });

  const runMutation = useMutation({
    mutationFn: (job: ScheduledJob) =>
      runScheduleNow(workspaceId ?? '', job.id),
    onSuccess: () => {
      setError(null);
      setNotice(t('schedules.runStarted'));
      invalidate();
    },
    onError: handleError,
  });

  function handlePresetChange(value: PresetChoice): void {
    setPreset(value);
    setDeliveryChannelId('');

    if (value === 'custom') {
      return;
    }

    setCronExpression(CRON_PRESETS[value].cronExpression);
    setTimezone(CRON_PRESETS[value].timezone);
  }

  function handleSubmit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    setError(null);
    setNotice(null);

    const parsed = createScheduledJobSchema.safeParse({
      name,
      cronExpression,
      timezone,
      prompt,
      deliveryChannelType,
      ...(deliveryChannelId === '' ? {} : { deliveryChannelId }),
      ...(deliveryChatId === '' ? {} : { deliveryChatId }),
    });

    if (!parsed.success || workspaceId === null) {
      setError(t('schedules.errors.invalid'));
      return;
    }

    createMutation.mutate(parsed.data);
  }

  const channels =
    deliveryChannelType === 'telegram'
      ? (telegramQuery.data ?? []).map((channel) => ({
          id: channel.id,
          label: channel.botUsername ?? channel.id,
        }))
      : deliveryChannelType === 'corporate'
        ? (corpQuery.data ?? []).map((channel) => ({
            id: channel.id,
            label: channel.name,
          }))
        : [];
  const jobs = jobsQuery.data ?? [];

  return (
    <div className="min-h-svh bg-surface text-on-surface">
      <header className="flex h-16 items-center justify-between gap-4 border-b border-outline-variant px-4 sm:px-6">
        <div className="flex min-w-0 items-center gap-4">
          <Brand compact />
          <Link
            to="/app/chat"
            className="text-xs font-medium text-primary hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
          >
            {t('schedules.backToChat')}
          </Link>
        </div>
        <div className="flex items-center gap-2">
          <LanguageSwitcher />
          <ThemeToggle />
        </div>
      </header>

      <main className="mx-auto w-full max-w-5xl px-4 py-6 sm:px-6">
        <h1 className="font-display text-2xl font-bold tracking-tight">
          {t('schedules.title')}
        </h1>
        <p className="mt-1 max-w-2xl text-sm text-on-surface-variant">
          {t('schedules.subtitle')}
        </p>

        {workspaceId === null && (
          <p role="status" className="mt-4 text-xs text-on-surface-variant">
            {t('schedules.noWorkspace')}
          </p>
        )}

        <div className="mt-6 grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.2fr)]">
          <section aria-label={t('schedules.form.title')} className={SECTION_CLASSES}>
            <h2 className="text-sm font-semibold">{t('schedules.form.title')}</h2>
            <form onSubmit={handleSubmit} className="mt-4 space-y-3">
              <div>
                <label htmlFor="schedule-name" className="text-xs font-medium">
                  {t('schedules.form.name')}
                </label>
                <input
                  id="schedule-name"
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                  placeholder={t('schedules.form.namePlaceholder')}
                  disabled={workspaceId === null || createMutation.isPending}
                  className={INPUT_CLASSES}
                />
              </div>

              <div>
                <label htmlFor="schedule-preset" className="text-xs font-medium">
                  {t('schedules.form.preset')}
                </label>
                <select
                  id="schedule-preset"
                  value={preset}
                  onChange={(event) =>
                    handlePresetChange(event.target.value as PresetChoice)
                  }
                  disabled={createMutation.isPending}
                  className={INPUT_CLASSES}
                >
                  {PRESET_CHOICES.map((item) => (
                    <option key={item} value={item}>
                      {t(`schedules.presets.${item}.label`)}
                    </option>
                  ))}
                </select>
              </div>

              <div className="grid grid-cols-2 gap-2">
                <div>
                  <label htmlFor="schedule-cron" className="text-xs font-medium">
                    {t('schedules.form.cron')}
                  </label>
                  <input
                    id="schedule-cron"
                    value={cronExpression}
                    onChange={(event) => {
                      setCronExpression(event.target.value);
                      setPreset('custom');
                    }}
                    disabled={createMutation.isPending}
                    className={`${INPUT_CLASSES} font-mono`}
                  />
                </div>
                <div>
                  <label htmlFor="schedule-timezone" className="text-xs font-medium">
                    {t('schedules.form.timezone')}
                  </label>
                  <input
                    id="schedule-timezone"
                    value={timezone}
                    onChange={(event) => setTimezone(event.target.value)}
                    disabled={createMutation.isPending}
                    className={INPUT_CLASSES}
                  />
                </div>
              </div>

              <div>
                <label htmlFor="schedule-prompt" className="text-xs font-medium">
                  {t('schedules.form.prompt')}
                </label>
                <textarea
                  id="schedule-prompt"
                  value={prompt}
                  onChange={(event) => setPrompt(event.target.value)}
                  rows={3}
                  placeholder={t('schedules.form.promptPlaceholder')}
                  disabled={createMutation.isPending}
                  className={`${INPUT_CLASSES} h-auto py-2`}
                />
              </div>

              <div>
                <label
                  htmlFor="schedule-delivery"
                  className="text-xs font-medium"
                >
                  {t('schedules.form.delivery')}
                </label>
                <select
                  id="schedule-delivery"
                  value={deliveryChannelType}
                  onChange={(event) => {
                    setDeliveryChannelType(
                      event.target.value as DeliveryChannelType,
                    );
                    setDeliveryChannelId('');
                  }}
                  disabled={createMutation.isPending}
                  className={INPUT_CLASSES}
                >
                  <option value="none">
                    {t('schedules.delivery.none')}
                  </option>
                  <option value="telegram">
                    {t('schedules.delivery.telegram')}
                  </option>
                  <option value="corporate">
                    {t('schedules.delivery.corporate')}
                  </option>
                </select>
              </div>

              {deliveryChannelType !== 'none' && (
                <div>
                  <label
                    htmlFor="schedule-channel"
                    className="text-xs font-medium"
                  >
                    {t('schedules.form.channel')}
                  </label>
                  <select
                    id="schedule-channel"
                    value={deliveryChannelId}
                    onChange={(event) => setDeliveryChannelId(event.target.value)}
                    disabled={createMutation.isPending}
                    className={INPUT_CLASSES}
                  >
                    <option value="">{t('schedules.form.selectChannel')}</option>
                    {channels.map((channel) => (
                      <option key={channel.id} value={channel.id}>
                        {channel.label}
                      </option>
                    ))}
                  </select>
                </div>
              )}

              {deliveryChannelType === 'corporate' && (
                <div>
                  <label
                    htmlFor="schedule-chat-id"
                    className="text-xs font-medium"
                  >
                    {t('schedules.form.chatId')}
                  </label>
                  <input
                    id="schedule-chat-id"
                    value={deliveryChatId}
                    onChange={(event) => setDeliveryChatId(event.target.value)}
                    placeholder={t('schedules.form.chatIdPlaceholder')}
                    disabled={createMutation.isPending}
                    className={INPUT_CLASSES}
                  />
                </div>
              )}

              <button
                type="submit"
                disabled={workspaceId === null || createMutation.isPending}
                className={BUTTON_CLASSES}
              >
                {t('schedules.form.create')}
              </button>
            </form>
            {error !== null && (
              <p role="alert" className="mt-3 text-sm text-error">
                {error}
              </p>
            )}
            {notice !== null && (
              <p role="status" className="mt-3 text-sm text-tertiary">
                {notice}
              </p>
            )}
          </section>

          <section aria-label={t('schedules.list.title')} className={SECTION_CLASSES}>
            <h2 className="text-sm font-semibold">{t('schedules.list.title')}</h2>
            {jobsQuery.isLoading ? (
              <p role="status" className="mt-3 text-xs text-on-surface-variant">
                {t('schedules.list.loading')}
              </p>
            ) : jobs.length === 0 ? (
              <p className="mt-3 rounded-xl border border-dashed border-outline px-4 py-10 text-center text-xs text-on-surface-variant">
                {t('schedules.list.empty')}
              </p>
            ) : (
              <ul className="mt-3 space-y-3">
                {jobs.map((job) => (
                  <JobCard
                    key={job.id}
                    job={job}
                    onToggle={(item) => toggleMutation.mutate(item)}
                    onRun={(item) => runMutation.mutate(item)}
                    onDelete={(item) => deleteMutation.mutate(item.id)}
                    isRunning={runMutation.isPending && runMutation.variables?.id === job.id}
                    isMutating={toggleMutation.isPending || deleteMutation.isPending}
                  />
                ))}
              </ul>
            )}
          </section>
        </div>
      </main>

      {error !== null && notice === null && (
        <ErrorToast message={error} onClose={() => setError(null)} />
      )}
    </div>
  );
}

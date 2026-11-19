import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, NavLink } from 'react-router-dom';
import { LanguageSwitcher } from '../components/LanguageSwitcher';
import { ThemeToggle } from '../components/ThemeToggle';
import {
  createCustomAgentSchema,
  createWorkspaceAgent,
  deleteWorkspaceAgent,
  fetchWorkspaceAgents,
  getAgentBuilderErrorMessage,
  updateWorkspaceAgent,
  workspaceAgentsQueryKey,
  type CreateCustomAgentRawInput,
  type CustomAgentRole,
  type HitlPolicy,
} from '../lib/agent-builder';
import { fetchWorkspaces, resolveActiveWorkspace, workspaceQueryKeys } from '../lib/workspaces';
import { useSkills } from '../hooks/useSkills';
import { useAuthStore } from '../store/auth.store';
import { useWorkspaceStore } from '../store/workspace.store';

const SECTION_CLASSES =
  'rounded-2xl border border-outline-variant bg-surface p-5 shadow-sm sm:p-6';

const INPUT_CLASSES =
  'mt-2 block w-full rounded-xl border border-outline bg-surface-container px-4 py-2.5 text-sm text-on-surface outline-none transition placeholder:text-on-surface-variant/60 hover:border-primary/40 focus:border-primary focus:ring-4 focus:ring-primary/15 disabled:cursor-not-allowed disabled:opacity-60';

const PRIMARY_BUTTON_CLASSES =
  'inline-flex items-center justify-center gap-2 rounded-xl bg-primary px-4 py-2.5 text-sm font-semibold text-on-primary shadow-lg shadow-primary/20 transition hover:brightness-95 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary disabled:cursor-not-allowed disabled:opacity-60';

const HITL_POLICIES: readonly HitlPolicy[] = ['never', 'high_risk', 'always'];

const PRESETS = [
  { key: 'sales', hitl: 'high_risk' as const, budget: '5000' },
  { key: 'warehouse', hitl: 'always' as const, budget: '3000' },
  { key: 'documents', hitl: 'always' as const, budget: '2000' },
] as const;

type PresetKey = (typeof PRESETS)[number]['key'];

function navLinkClasses({ isActive }: { isActive: boolean }): string {
  return `rounded-lg px-3 py-2 text-sm font-medium transition focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary ${
    isActive
      ? 'bg-primary-container text-on-primary-container'
      : 'text-on-surface-variant hover:bg-surface-container-high hover:text-on-surface'
  }`;
}

function hitlBadgeClasses(policy: HitlPolicy): string {
  switch (policy) {
    case 'never':
      return 'border-outline-variant bg-surface-container-high text-on-surface-variant';
    case 'high_risk':
      return 'border-warning/30 bg-warning-container text-on-warning-container';
    case 'always':
      return 'border-error/30 bg-error-container text-on-error-container';
  }
}

/** Живое превью карточки стола AI-Офиса. */
function AgentPreview({
  name,
  description,
  roleKey,
  skillNames,
  hitlPolicy,
  dailyBudgetRub,
  isActive,
}: {
  name: string;
  description: string;
  roleKey: string;
  skillNames: string[];
  hitlPolicy: HitlPolicy;
  dailyBudgetRub: string;
  isActive: boolean;
}) {
  const { t, i18n } = useTranslation();
  const budget = Number(dailyBudgetRub);

  return (
    <article
      aria-label={t('builder.preview.label')}
      className="rounded-2xl border border-primary/30 bg-gradient-to-br from-primary-container/40 to-surface p-5 shadow-sm"
    >
      <div className="flex items-start justify-between gap-3">
        <span className="grid size-12 shrink-0 place-items-center rounded-2xl bg-primary text-xl text-on-primary">
          <span aria-hidden="true">🤖</span>
        </span>
        <span
          className={`inline-flex rounded-full border px-2.5 py-1 text-[11px] font-semibold ${hitlBadgeClasses(hitlPolicy)}`}
        >
          {t(`builder.hitl.${hitlPolicy}`)}
        </span>
      </div>

      <h3 className="mt-4 font-display text-lg font-bold text-on-surface">
        {name.trim() === '' ? t('builder.preview.untitled') : name.trim()}
      </h3>
      <p className="mt-0.5 break-all font-mono text-[11px] text-on-surface-variant">
        {roleKey === '' ? t('builder.preview.roleKeyPending') : roleKey}
      </p>
      <p className="mt-2 line-clamp-3 text-sm leading-snug text-on-surface-variant">
        {description.trim() === ''
          ? t('builder.preview.noDescription')
          : description.trim()}
      </p>

      <div className="mt-4 flex flex-wrap gap-1.5">
        {skillNames.length === 0 ? (
          <span className="text-xs text-on-surface-variant">
            {t('builder.preview.noSkills')}
          </span>
        ) : (
          skillNames.map((skillName) => (
            <span
              key={skillName}
              className="rounded-full border border-outline-variant bg-surface px-2.5 py-1 text-[11px] font-medium text-on-surface-variant"
            >
              {skillName}
            </span>
          ))
        )}
      </div>

      <div className="mt-5 flex flex-wrap items-center justify-between gap-2 border-t border-outline-variant pt-4 text-xs">
        <span className="text-on-surface-variant">
          {Number.isFinite(budget) && budget > 0
            ? t('builder.preview.budget', {
                amount: new Intl.NumberFormat(i18n.language).format(budget),
              })
            : t('builder.preview.noBudget')}
        </span>
        <span className="font-semibold text-primary">
          {isActive ? t('builder.preview.active') : t('builder.preview.inactive')}
        </span>
      </div>
    </article>
  );
}

function AgentListItem({
  agent,
  isBusy,
  error,
  onToggle,
  onDelete,
}: {
  agent: CustomAgentRole;
  isBusy: boolean;
  error: string | null;
  onToggle: () => void;
  onDelete: () => void;
}) {
  const { t } = useTranslation();

  return (
    <li className="rounded-xl border border-outline-variant bg-surface-container px-4 py-3">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="font-display text-sm font-bold text-on-surface">
            {agent.name}
          </p>
          <p className="mt-0.5 break-all font-mono text-[11px] text-on-surface-variant">
            {agent.roleKey}
          </p>
        </div>
        <label className="inline-flex shrink-0 cursor-pointer items-center gap-2 text-xs font-medium text-on-surface-variant">
          <input
            type="checkbox"
            checked={agent.isActive}
            disabled={isBusy}
            onChange={onToggle}
            aria-label={t('builder.list.toggle', { name: agent.name })}
          />
          {agent.isActive ? t('builder.list.active') : t('builder.list.inactive')}
        </label>
      </div>
      <div className="mt-3 flex flex-wrap items-center gap-3">
        <span
          className={`rounded-full border px-2 py-0.5 text-[10px] font-semibold ${hitlBadgeClasses(agent.hitlPolicy)}`}
        >
          {t(`builder.hitl.${agent.hitlPolicy}`)}
        </span>
        <button
          type="button"
          onClick={onDelete}
          disabled={isBusy}
          className="rounded-lg border border-error/40 px-2.5 py-1 text-xs font-semibold text-error transition hover:bg-error-container focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-error disabled:cursor-not-allowed disabled:opacity-60"
        >
          {t('builder.list.delete')}
        </button>
      </div>
      {error !== null && (
        <p role="alert" className="mt-2 text-xs text-error">
          {error}
        </p>
      )}
    </li>
  );
}

export function AgentBuilderPage() {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const accessToken = useAuthStore((state) => state.accessToken);
  const role = useAuthStore((state) => state.user?.role);
  const selectedWorkspaceId = useWorkspaceStore(
    (state) => state.activeWorkspaceId,
  );
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [roleKey, setRoleKey] = useState('');
  const [systemPrompt, setSystemPrompt] = useState('');
  const [skillSlugs, setSkillSlugs] = useState<string[]>([]);
  const [hitlPolicy, setHitlPolicy] = useState<HitlPolicy>('high_risk');
  const [dailyBudgetRub, setDailyBudgetRub] = useState('');
  const [isActive, setIsActive] = useState(true);
  const [fieldError, setFieldError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [rowError, setRowError] = useState<string | null>(null);

  const workspacesQuery = useQuery({
    queryKey: workspaceQueryKeys.workspaces,
    queryFn: fetchWorkspaces,
    enabled: accessToken !== null,
    staleTime: 30_000,
  });
  const workspace = resolveActiveWorkspace(
    workspacesQuery.data ?? [],
    selectedWorkspaceId,
  );
  const workspaceId = workspace?.id ?? null;
  const canManage = role === 'owner' || role === 'admin';

  const skillsQuery = useSkills();
  const skills = skillsQuery.data ?? [];

  const agentsQuery = useQuery({
    queryKey: workspaceId === null ? ['workspace-agents', null] : workspaceAgentsQueryKey(workspaceId),
    queryFn: () => fetchWorkspaceAgents(workspaceId ?? ''),
    enabled: workspaceId !== null,
    staleTime: 15_000,
  });

  function refreshAgents(): void {
    void queryClient.invalidateQueries({ queryKey: ['workspace-agents'] });
  }

  const createMutation = useMutation({
    mutationFn: (input: CreateCustomAgentRawInput) =>
      createWorkspaceAgent(workspaceId ?? '', input),
    onSuccess: () => {
      setName('');
      setDescription('');
      setRoleKey('');
      setSystemPrompt('');
      setSkillSlugs([]);
      setDailyBudgetRub('');
      setFieldError(null);
      setNotice(t('builder.form.created'));
      refreshAgents();
    },
  });

  const toggleMutation = useMutation({
    mutationFn: ({ agentId, isActive: next }: { agentId: string; isActive: boolean }) =>
      updateWorkspaceAgent(workspaceId ?? '', agentId, { isActive: next }),
    onMutate: ({ agentId }) => {
      setBusyId(agentId);
      setRowError(null);
    },
    onSuccess: refreshAgents,
    onError: (error) => {
      setRowError(getAgentBuilderErrorMessage(error, 'builder.errors.update'));
    },
    onSettled: () => setBusyId(null),
  });

  const deleteMutation = useMutation({
    mutationFn: (agentId: string) => deleteWorkspaceAgent(workspaceId ?? '', agentId),
    onMutate: (agentId) => {
      setBusyId(agentId);
      setRowError(null);
    },
    onSuccess: refreshAgents,
    onError: (error) => {
      setRowError(getAgentBuilderErrorMessage(error, 'builder.errors.delete'));
    },
    onSettled: () => setBusyId(null),
  });

  function applyPreset(key: PresetKey): void {
    const preset = PRESETS.find((item) => item.key === key);

    if (preset === undefined) {
      return;
    }

    setSystemPrompt(t(`builder.presets.${key}.prompt`));
    setHitlPolicy(preset.hitl);
    setDailyBudgetRub(preset.budget);
    setFieldError(null);
  }

  function toggleSkill(slug: string): void {
    setSkillSlugs((current) =>
      current.includes(slug)
        ? current.filter((item) => item !== slug)
        : [...current, slug],
    );
  }

  function handleSubmit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    const parsed = createCustomAgentSchema.safeParse({
      name,
      roleKey: roleKey.trim() === '' ? undefined : roleKey,
      description: description.trim() === '' ? undefined : description,
      systemPrompt,
      skillSlugs,
      hitlPolicy,
      dailyBudgetRub: dailyBudgetRub.trim() === '' ? null : dailyBudgetRub,
      isActive,
    });

    if (!parsed.success) {
      setFieldError(t('builder.errors.invalid'));
      return;
    }

    setFieldError(null);
    setNotice(null);
    createMutation.mutate({
      name,
      roleKey: roleKey.trim() === '' ? undefined : roleKey,
      description: description.trim() === '' ? undefined : description,
      systemPrompt,
      skillSlugs,
      hitlPolicy,
      dailyBudgetRub: dailyBudgetRub.trim() === '' ? null : dailyBudgetRub,
      isActive,
    });
  }

  const selectedSkillNames = skills
    .filter((skill) => skillSlugs.includes(skill.id))
    .map((skill) => skill.name);

  return (
    <div className="min-h-svh bg-surface text-on-surface">
      <header className="sticky top-0 z-20 border-b border-outline-variant bg-surface/90 backdrop-blur">
        <div className="mx-auto flex h-16 max-w-7xl items-center justify-between gap-3 px-4 sm:px-6">
          <div className="flex min-w-0 items-center gap-2 sm:gap-4">
            <Link
              to="/app/chat"
              aria-label={t('builder.backToChat')}
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
              <NavLink to="/app/office" className={navLinkClasses}>{t('nav.office')}</NavLink>
              <NavLink to="/app/builder" className={navLinkClasses}>{t('nav.builder')}</NavLink>
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
          {t('builder.title')}
        </h1>
        <p className="mt-2 max-w-2xl text-sm leading-relaxed text-on-surface-variant">
          {t('builder.subtitle')}
        </p>
        {workspace !== undefined && (
          <p className="mt-1 text-xs text-on-surface-variant">
            {t('builder.workspace', { name: workspace.name })}
          </p>
        )}

        {!canManage && (
          <p role="alert" className="mt-4 rounded-xl border border-warning/30 bg-warning-container px-4 py-3 text-sm text-on-warning-container">
            {t('builder.readOnly')}
          </p>
        )}

        <div className="mt-8 grid gap-6 lg:grid-cols-2">
          <form onSubmit={handleSubmit} className={SECTION_CLASSES}>
            <h2 className="font-display text-xl font-bold text-on-surface">
              {t('builder.form.title')}
            </h2>

            <div className="mt-4">
              <label htmlFor="builder-name" className="block text-sm font-medium text-on-surface">
                {t('builder.form.name')}
              </label>
              <input
                id="builder-name"
                type="text"
                value={name}
                onChange={(event) => setName(event.target.value)}
                placeholder={t('builder.form.namePlaceholder')}
                disabled={!canManage || createMutation.isPending}
                className={INPUT_CLASSES}
              />
            </div>

            <div className="mt-4">
              <label htmlFor="builder-description" className="block text-sm font-medium text-on-surface">
                {t('builder.form.description')}
              </label>
              <textarea
                id="builder-description"
                rows={2}
                value={description}
                onChange={(event) => setDescription(event.target.value)}
                disabled={!canManage || createMutation.isPending}
                className={INPUT_CLASSES}
              />
            </div>

            <div className="mt-4">
              <label htmlFor="builder-role-key" className="block text-sm font-medium text-on-surface">
                {t('builder.form.roleKey')}
              </label>
              <input
                id="builder-role-key"
                type="text"
                value={roleKey}
                onChange={(event) => setRoleKey(event.target.value)}
                placeholder={t('builder.form.roleKeyPlaceholder')}
                disabled={!canManage || createMutation.isPending}
                className={`${INPUT_CLASSES} font-mono`}
              />
              <p className="mt-2 text-xs text-on-surface-variant">
                {t('builder.form.roleKeyHint')}
              </p>
            </div>

            <fieldset className="mt-4">
              <legend className="text-sm font-medium text-on-surface">
                {t('builder.form.skills')}
              </legend>
              {skills.length === 0 ? (
                <p className="mt-2 text-xs text-on-surface-variant">
                  {t('builder.form.noSkills')}
                </p>
              ) : (
                <div className="mt-2 grid gap-2 sm:grid-cols-2">
                  {skills.map((skill) => (
                    <label
                      key={skill.id}
                      className="flex items-center gap-2 rounded-xl border border-outline-variant bg-surface-container px-3 py-2 text-sm"
                    >
                      <input
                        type="checkbox"
                        checked={skillSlugs.includes(skill.id)}
                        disabled={!canManage || createMutation.isPending}
                        onChange={() => toggleSkill(skill.id)}
                      />
                      <span className="min-w-0 truncate">{skill.name}</span>
                    </label>
                  ))}
                </div>
              )}
            </fieldset>

            <div className="mt-4">
              <label htmlFor="builder-prompt" className="block text-sm font-medium text-on-surface">
                {t('builder.form.systemPrompt')}
              </label>
              <div className="mt-2 flex flex-wrap gap-2">
                {PRESETS.map((preset) => (
                  <button
                    key={preset.key}
                    type="button"
                    onClick={() => applyPreset(preset.key)}
                    disabled={!canManage || createMutation.isPending}
                    className="rounded-full border border-outline px-3 py-1.5 text-xs font-semibold text-on-surface-variant transition hover:bg-surface-container-high hover:text-on-surface focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary disabled:cursor-not-allowed disabled:opacity-60"
                  >
                    {t(`builder.presets.${preset.key}.label`)}
                  </button>
                ))}
              </div>
              <textarea
                id="builder-prompt"
                rows={6}
                value={systemPrompt}
                onChange={(event) => setSystemPrompt(event.target.value)}
                disabled={!canManage || createMutation.isPending}
                className={`${INPUT_CLASSES} font-mono`}
              />
            </div>

            <fieldset className="mt-4">
              <legend className="text-sm font-medium text-on-surface">
                {t('builder.form.hitl')}
              </legend>
              <div className="mt-2 grid gap-2">
                {HITL_POLICIES.map((policy) => (
                  <label key={policy} className="flex items-center gap-2 text-sm">
                    <input
                      type="radio"
                      name="hitlPolicy"
                      value={policy}
                      checked={hitlPolicy === policy}
                      disabled={!canManage || createMutation.isPending}
                      onChange={() => setHitlPolicy(policy)}
                    />
                    {t(`builder.hitl.${policy}`)}
                  </label>
                ))}
              </div>
            </fieldset>

            <div className="mt-4">
              <label htmlFor="builder-budget" className="block text-sm font-medium text-on-surface">
                {t('builder.form.budget')}
              </label>
              <input
                id="builder-budget"
                type="number"
                min={0}
                step="0.01"
                value={dailyBudgetRub}
                onChange={(event) => setDailyBudgetRub(event.target.value)}
                placeholder="5000"
                disabled={!canManage || createMutation.isPending}
                className={INPUT_CLASSES}
              />
              <p className="mt-2 text-xs text-on-surface-variant">
                {t('builder.form.budgetHint')}
              </p>
            </div>

            <label className="mt-4 flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={isActive}
                disabled={!canManage || createMutation.isPending}
                onChange={(event) => setIsActive(event.target.checked)}
              />
              {t('builder.form.isActive')}
            </label>

            {fieldError !== null && (
              <p role="alert" className="mt-4 text-sm text-error">{fieldError}</p>
            )}
            {createMutation.isError && (
              <p role="alert" className="mt-4 text-sm text-error">
                {getAgentBuilderErrorMessage(createMutation.error, 'builder.errors.create')}
              </p>
            )}

            <div className="mt-5 flex flex-wrap items-center gap-3">
              <button
                type="submit"
                disabled={!canManage || createMutation.isPending || workspaceId === null}
                aria-busy={createMutation.isPending}
                className={PRIMARY_BUTTON_CLASSES}
              >
                {createMutation.isPending ? t('builder.form.creating') : t('builder.form.create')}
              </button>
              {notice !== null && (
                <p role="status" className="text-sm font-medium text-success">{notice}</p>
              )}
            </div>
          </form>

          <div className="space-y-6">
            <section className={SECTION_CLASSES} aria-labelledby="builder-preview-title">
              <h2 id="builder-preview-title" className="font-display text-xl font-bold text-on-surface">
                {t('builder.preview.title')}
              </h2>
              <p className="mt-1 text-sm text-on-surface-variant">
                {t('builder.preview.subtitle')}
              </p>
              <div className="mt-5">
                <AgentPreview
                  name={name}
                  description={description}
                  roleKey={roleKey.trim() === '' ? 'custom-agent' : roleKey}
                  skillNames={selectedSkillNames}
                  hitlPolicy={hitlPolicy}
                  dailyBudgetRub={dailyBudgetRub}
                  isActive={isActive}
                />
              </div>
            </section>

            <section className={SECTION_CLASSES} aria-labelledby="builder-list-title">
              <h2 id="builder-list-title" className="font-display text-xl font-bold text-on-surface">
                {t('builder.list.title')}
              </h2>
              {agentsQuery.isPending ? (
                <p className="mt-3 text-sm text-on-surface-variant">{t('builder.list.loading')}</p>
              ) : agentsQuery.isError ? (
                <div role="alert" className="mt-3 rounded-xl border border-error/30 bg-error-container px-3 py-2.5 text-sm text-on-error-container">
                  {getAgentBuilderErrorMessage(agentsQuery.error, 'builder.errors.load')}
                  <button
                    type="button"
                    onClick={() => { void agentsQuery.refetch(); }}
                    className="mt-2 rounded-lg bg-primary px-3 py-2 text-xs font-semibold text-on-primary"
                  >
                    {t('builder.list.retry')}
                  </button>
                </div>
              ) : (agentsQuery.data ?? []).length === 0 ? (
                <p className="mt-3 text-sm text-on-surface-variant">{t('builder.list.empty')}</p>
              ) : (
                <ul className="mt-3 space-y-3">
                  {(agentsQuery.data ?? []).map((agent) => (
                    <AgentListItem
                      key={agent.id}
                      agent={agent}
                      isBusy={busyId === agent.id && (toggleMutation.isPending || deleteMutation.isPending)}
                      error={busyId === agent.id ? rowError : null}
                      onToggle={() => toggleMutation.mutate({ agentId: agent.id, isActive: !agent.isActive })}
                      onDelete={() => deleteMutation.mutate(agent.id)}
                    />
                  ))}
                </ul>
              )}
            </section>
          </div>
        </div>
      </main>
    </div>
  );
}

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, NavLink } from 'react-router-dom';
import { Brand } from '../components/Brand';
import { ErrorToast } from '../components/ErrorToast';
import { LanguageSwitcher } from '../components/LanguageSwitcher';
import { StatusToast } from '../components/StatusToast';
import { ThemeToggle } from '../components/ThemeToggle';
import { WorkspaceSwitcher } from '../components/WorkspaceSwitcher';
import { isAdminRole } from '../lib/roles';
import {
  addWorkspaceMember,
  canManageWorkspaceMembers,
  fetchWorkspaceMembers,
  fetchWorkspaces,
  parseHitlLimit,
  resolveActiveWorkspace,
  updateWorkspaceMember,
  workspaceErrorKey,
  workspaceQueryKeys,
  type WorkspaceMember,
  type WorkspaceRole,
} from '../lib/workspaces';
import { useAuthStore } from '../store/auth.store';
import { useWorkspaceStore } from '../store/workspace.store';

const ASSIGNABLE_ROLES = ['admin', 'operator', 'viewer'] as const;

function navLinkClasses({ isActive }: { isActive: boolean }): string {
  return `rounded-lg px-3 py-2 text-sm font-medium transition focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary ${
    isActive
      ? 'bg-primary-container text-on-primary-container'
      : 'text-on-surface-variant hover:bg-surface-container-high hover:text-on-surface'
  }`;
}

function limitToInput(value: WorkspaceMember['hitlApprovalLimitRub']): string {
  const parsed = parseHitlLimit(value);

  return parsed === null ? '' : String(parsed);
}

function MemberRow({
  member,
  canManage,
  workspaceId,
  onSaved,
  onError,
}: {
  member: WorkspaceMember;
  canManage: boolean;
  workspaceId: string;
  onSaved: (message: string) => void;
  onError: (error: unknown, t: (key: string) => string) => void;
}) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [role, setRole] = useState<WorkspaceRole>(member.role);
  const [limit, setLimit] = useState(() => limitToInput(member.hitlApprovalLimitRub));

  const updateMutation = useMutation({
    mutationFn: (payload: {
      role: WorkspaceRole;
      hitlApprovalLimitRub: number | null;
    }) => updateWorkspaceMember(workspaceId, member.id, payload),
    onSuccess: () => {
      onSaved(t('workspace.team.saved'));
      void queryClient.invalidateQueries({
        queryKey: workspaceQueryKeys.members(workspaceId),
      });
    },
    onError: (error) => onError(error, t),
  });

  const canSave =
    canManage &&
    (role !== member.role ||
      limit !== limitToInput(member.hitlApprovalLimitRub));

  return (
    <tr className="border-t border-outline-variant">
      <td className="px-4 py-3">
        <p className="text-sm font-medium text-on-surface">
          {member.name ?? member.email ?? member.userId}
        </p>
        {member.name !== undefined && member.email !== undefined && (
          <p className="mt-0.5 text-xs text-on-surface-variant">
            {member.email}
          </p>
        )}
      </td>
      <td className="px-4 py-3">
        <select
          aria-label={t('workspace.team.table.role')}
          value={role}
          disabled={!canManage || updateMutation.isPending}
          onChange={(event) => setRole(event.target.value as WorkspaceRole)}
          className="rounded-lg border border-outline-variant bg-surface px-2 py-1.5 text-sm text-on-surface focus:border-primary disabled:opacity-60"
        >
          {(['owner', 'admin', 'operator', 'viewer'] as const).map((item) => (
            <option key={item} value={item}>
              {t(`workspace.roles.${item}`)}
            </option>
          ))}
        </select>
      </td>
      <td className="px-4 py-3">
        <input
          aria-label={t('workspace.team.table.hitlLimit')}
          type="number"
          min={0}
          step={100}
          value={limit}
          disabled={!canManage || updateMutation.isPending}
          onChange={(event) => setLimit(event.target.value)}
          placeholder={t('workspace.team.unlimited')}
          className="w-28 rounded-lg border border-outline-variant bg-surface px-2 py-1.5 text-sm tabular-nums text-on-surface focus:border-primary disabled:opacity-60"
        />
      </td>
      <td className="px-4 py-3 text-right">
        <button
          type="button"
          disabled={!canSave || updateMutation.isPending}
          onClick={() =>
            updateMutation.mutate({
              role,
              hitlApprovalLimitRub:
                limit.trim() === '' ? null : Number(limit),
            })
          }
          className="rounded-lg bg-primary px-3 py-1.5 text-xs font-semibold text-on-primary transition hover:brightness-95 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary disabled:cursor-not-allowed disabled:opacity-50"
        >
          {t('workspace.team.save')}
        </button>
      </td>
    </tr>
  );
}

export function TeamPage() {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const accessToken = useAuthStore((state) => state.accessToken);
  const isAdmin = isAdminRole(useAuthStore((state) => state.user?.role));
  const selectedWorkspaceId = useWorkspaceStore(
    (state) => state.activeWorkspaceId,
  );
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<(typeof ASSIGNABLE_ROLES)[number]>('viewer');
  const [limit, setLimit] = useState('');
  const [notice, setNotice] = useState<{
    tone: 'success' | 'error';
    message: string;
  } | null>(null);

  const workspacesQuery = useQuery({
    queryKey: workspaceQueryKeys.workspaces,
    queryFn: fetchWorkspaces,
    enabled: accessToken !== null,
    staleTime: 30_000,
  });
  const active = resolveActiveWorkspace(
    workspacesQuery.data ?? [],
    selectedWorkspaceId,
  );
  const workspaceId = active?.id ?? null;

  const membersQuery = useQuery({
    queryKey: workspaceQueryKeys.members(workspaceId ?? 'none'),
    queryFn: () => fetchWorkspaceMembers(workspaceId ?? ''),
    enabled: workspaceId !== null,
    staleTime: 15_000,
  });

  const addMutation = useMutation({
    mutationFn: (payload: {
      email: string;
      role: 'admin' | 'operator' | 'viewer';
      hitlApprovalLimitRub?: number;
    }) => addWorkspaceMember(workspaceId ?? '', payload),
    onSuccess: () => {
      setEmail('');
      setLimit('');
      setNotice({ tone: 'success', message: t('workspace.team.added') });
      void queryClient.invalidateQueries({
        queryKey: workspaceQueryKeys.members(workspaceId ?? ''),
      });
    },
    onError: (error) =>
      setNotice({
        tone: 'error',
        message: t(workspaceErrorKey(error, 'workspace.errors.add')),
      }),
  });

  const canManage =
    canManageWorkspaceMembers(active?.role) || isAdmin;
  const members = membersQuery.data ?? [];

  function handleAdd(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();

    addMutation.mutate({
      email,
      role,
      ...(limit.trim() === '' ? {} : { hitlApprovalLimitRub: Number(limit) }),
    });
  }

  function handleRowError(
    error: unknown,
    translate: (key: string) => string,
  ): void {
    setNotice({
      tone: 'error',
      message: translate(workspaceErrorKey(error, 'workspace.errors.update')),
    });
  }

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
              aria-label={t('skills.backToChat')}
              title={t('skills.backToChat')}
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
              className="hidden items-center gap-1 lg:flex"
            >
              <NavLink to="/app/chat" className={navLinkClasses}>
                {t('nav.chat')}
              </NavLink>
              <NavLink to="/app/skills" className={navLinkClasses}>
                {t('nav.skills')}
              </NavLink>
              <NavLink to="/app/team" className={navLinkClasses}>
                {t('nav.team')}
              </NavLink>
              <NavLink to="/app/marketplace" className={navLinkClasses}>
                {t('nav.marketplace')}
              </NavLink>
              <NavLink to="/app/settings" className={navLinkClasses}>
                {t('nav.settings')}
              </NavLink>
            </nav>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <WorkspaceSwitcher />
            <LanguageSwitcher />
            <ThemeToggle />
          </div>
        </div>
      </header>

      <main className="mx-auto w-full max-w-6xl px-4 py-8 sm:px-6 lg:py-10">
        <h1 className="font-display text-3xl font-bold tracking-tight text-on-surface">
          {t('workspace.team.title')}
        </h1>
        <p className="mt-2 max-w-2xl text-sm leading-relaxed text-on-surface-variant">
          {t('workspace.team.subtitle')}
        </p>

        {active === undefined ? (
          <div className="mt-8 rounded-2xl border border-dashed border-outline px-6 py-14 text-center text-sm text-on-surface-variant">
            {t('workspace.team.noWorkspace')}
          </div>
        ) : (
          <>
            {canManage && (
              <form
                onSubmit={handleAdd}
                className="mt-8 rounded-2xl border border-outline-variant bg-surface-container p-5"
              >
                <h2 className="font-display text-lg font-bold text-on-surface">
                  {t('workspace.team.invite.title')}
                </h2>
                <div className="mt-4 grid gap-3 sm:grid-cols-3">
                  <div>
                    <label
                      htmlFor="workspace-member-email"
                      className="block text-xs font-semibold uppercase tracking-wide text-on-surface-variant"
                    >
                      {t('workspace.team.invite.email')}
                    </label>
                    <input
                      id="workspace-member-email"
                      type="email"
                      required
                      value={email}
                      onChange={(event) => setEmail(event.target.value)}
                      className="mt-1.5 w-full rounded-lg border border-outline bg-surface px-3 py-2 text-sm text-on-surface focus:border-primary"
                    />
                  </div>
                  <div>
                    <label
                      htmlFor="workspace-member-role"
                      className="block text-xs font-semibold uppercase tracking-wide text-on-surface-variant"
                    >
                      {t('workspace.team.invite.role')}
                    </label>
                    <select
                      id="workspace-member-role"
                      value={role}
                      onChange={(event) =>
                        setRole(
                          event.target.value as (typeof ASSIGNABLE_ROLES)[number],
                        )
                      }
                      className="mt-1.5 w-full rounded-lg border border-outline bg-surface px-3 py-2 text-sm text-on-surface focus:border-primary"
                    >
                      {ASSIGNABLE_ROLES.map((item) => (
                        <option key={item} value={item}>
                          {t(`workspace.roles.${item}`)}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div>
                    <label
                      htmlFor="workspace-member-limit"
                      className="block text-xs font-semibold uppercase tracking-wide text-on-surface-variant"
                    >
                      {t('workspace.team.invite.hitlLimit')}
                    </label>
                    <input
                      id="workspace-member-limit"
                      type="number"
                      min={0}
                      step={100}
                      value={limit}
                      onChange={(event) => setLimit(event.target.value)}
                      placeholder={t('workspace.team.unlimited')}
                      className="mt-1.5 w-full rounded-lg border border-outline bg-surface px-3 py-2 text-sm tabular-nums text-on-surface focus:border-primary"
                    />
                  </div>
                </div>
                <button
                  type="submit"
                  disabled={addMutation.isPending || email.trim() === ''}
                  className="mt-4 rounded-lg bg-primary px-4 py-2 text-sm font-semibold text-on-primary transition hover:brightness-95 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary disabled:cursor-not-allowed disabled:opacity-60"
                >
                  {addMutation.isPending
                    ? t('workspace.team.invite.adding')
                    : t('workspace.team.invite.action')}
                </button>
              </form>
            )}

            <section className="mt-8">
              <h2 className="font-display text-lg font-bold text-on-surface">
                {t('workspace.team.membersTitle')}
              </h2>
              {membersQuery.isPending ? (
                <p className="mt-4 text-sm text-on-surface-variant">
                  {t('workspace.team.loading')}
                </p>
              ) : membersQuery.isError ? (
                <div
                  role="alert"
                  className="mt-4 rounded-xl border border-error/30 bg-error-container p-4 text-sm text-on-error-container"
                >
                  <p>
                    {t(
                      workspaceErrorKey(
                        membersQuery.error,
                        'workspace.errors.loadMembers',
                      ),
                    )}
                  </p>
                  <button
                    type="button"
                    onClick={() => {
                      void membersQuery.refetch();
                    }}
                    className="mt-2 rounded-lg bg-primary px-3 py-1.5 text-xs font-semibold text-on-primary"
                  >
                    {t('admin.retry')}
                  </button>
                </div>
              ) : members.length === 0 ? (
                <p className="mt-4 text-sm text-on-surface-variant">
                  {t('workspace.team.empty')}
                </p>
              ) : (
                <div className="mt-4 overflow-x-auto rounded-2xl border border-outline-variant bg-surface-container">
                  <table className="w-full min-w-[36rem] text-left text-sm">
                    <thead className="text-xs uppercase tracking-wide text-on-surface-variant">
                      <tr>
                        <th className="px-4 py-3 font-medium">
                          {t('workspace.team.table.member')}
                        </th>
                        <th className="px-4 py-3 font-medium">
                          {t('workspace.team.table.role')}
                        </th>
                        <th className="px-4 py-3 font-medium">
                          {t('workspace.team.table.hitlLimit')}
                        </th>
                        <th className="px-4 py-3" />
                      </tr>
                    </thead>
                    <tbody>
                      {members.map((member) => (
                        <MemberRow
                          key={`${member.id}-${member.role}-${member.hitlApprovalLimitRub ?? ''}`}
                          member={member}
                          canManage={canManage}
                          workspaceId={active.id}
                          onSaved={(message) =>
                            setNotice({ tone: 'success', message })
                          }
                          onError={handleRowError}
                        />
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </section>
          </>
        )}
      </main>

      {notice !== null &&
        (notice.tone === 'success' ? (
          <StatusToast
            message={notice.message}
            tone="success"
            onClose={() => setNotice(null)}
          />
        ) : (
          <ErrorToast message={notice.message} onClose={() => setNotice(null)} />
        ))}
    </div>
  );
}

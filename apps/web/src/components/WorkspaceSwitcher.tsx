import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import {
  createWorkspace,
  fetchWorkspaces,
  invalidateWorkspaceScopedCaches,
  resolveActiveWorkspace,
  workspaceErrorKey,
  workspaceQueryKeys,
} from '../lib/workspaces';
import { useAuthStore } from '../store/auth.store';
import { useWorkspaceStore } from '../store/workspace.store';

/** Компактный выбор активного воркспейса в шапке/сайдбаре приложения. */
export function WorkspaceSwitcher() {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const accessToken = useAuthStore((state) => state.accessToken);
  const activeWorkspaceId = useWorkspaceStore(
    (state) => state.activeWorkspaceId,
  );
  const setActiveWorkspace = useWorkspaceStore(
    (state) => state.setActiveWorkspace,
  );
  const [isCreateOpen, setIsCreateOpen] = useState(false);
  const [name, setName] = useState('');
  const [slug, setSlug] = useState('');
  const dialogRef = useRef<HTMLDialogElement>(null);

  const workspacesQuery = useQuery({
    queryKey: workspaceQueryKeys.workspaces,
    queryFn: fetchWorkspaces,
    enabled: accessToken !== null,
    staleTime: 30_000,
  });

  const createMutation = useMutation({
    mutationFn: createWorkspace,
    onSuccess: (created) => {
      setActiveWorkspace(created.id);
      invalidateWorkspaceScopedCaches(queryClient);
      void queryClient.invalidateQueries({
        queryKey: workspaceQueryKeys.workspaces,
      });
      setName('');
      setSlug('');
      setIsCreateOpen(false);
    },
  });

  useEffect(() => {
    const dialog = dialogRef.current;

    if (dialog === null) {
      return;
    }

    if (isCreateOpen) {
      if (!dialog.open) {
        dialog.showModal();
      }

      return;
    }

    if (dialog.open) {
      dialog.close();
    }
  }, [isCreateOpen]);

  useEffect(() => {
    const dialog = dialogRef.current;

    if (dialog === null) {
      return;
    }

    const handleClose = () => setIsCreateOpen(false);
    dialog.addEventListener('close', handleClose);

    return () => dialog.removeEventListener('close', handleClose);
  }, []);

  const workspaces = workspacesQuery.data ?? [];
  const active = resolveActiveWorkspace(workspaces, activeWorkspaceId);
  const value = activeWorkspaceId ?? active?.id ?? '';

  function handleSubmit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();

    const payload: { name: string; slug?: string } = { name };

    if (slug.trim() !== '') {
      payload.slug = slug.trim();
    }

    createMutation.mutate(payload);
  }

  return (
    <>
      <div className="flex min-w-0 items-center gap-1.5">
        <label className="sr-only" htmlFor="workspace-switcher">
          {t('workspace.switcherLabel')}
        </label>
        <select
          id="workspace-switcher"
          value={value}
          disabled={workspaces.length === 0}
          title={
            workspacesQuery.isError
              ? t(workspaceErrorKey(workspacesQuery.error, 'workspace.errors.load'))
              : undefined
          }
          onChange={(event) => {
            setActiveWorkspace(event.target.value === '' ? null : event.target.value);
            invalidateWorkspaceScopedCaches(queryClient);
            void queryClient.invalidateQueries({
              queryKey: workspaceQueryKeys.workspaces,
            });
          }}
          className="min-w-0 max-w-44 rounded-lg border border-outline-variant bg-surface-container px-2 py-1.5 text-xs font-medium text-on-surface focus:border-primary disabled:opacity-60 sm:max-w-56"
        >
          <option value="">
            {active?.name ?? t('workspace.defaultOption')}
          </option>
          {workspaces.map((workspace) => (
            <option key={workspace.id} value={workspace.id}>
              {workspace.name}
            </option>
          ))}
        </select>
        {active !== undefined && (
          <span className="hidden shrink-0 rounded-full bg-primary-container px-2 py-0.5 text-[10px] font-semibold text-on-primary-container lg:inline">
            {t(`workspace.roles.${active.role}`)}
          </span>
        )}
        <button
          type="button"
          onClick={() => {
            createMutation.reset();
            setIsCreateOpen(true);
          }}
          aria-label={t('workspace.create')}
          title={t('workspace.create')}
          className="inline-flex size-7 shrink-0 items-center justify-center rounded-lg border border-outline-variant text-lg leading-none text-on-surface-variant transition hover:border-primary/40 hover:text-on-surface focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
        >
          +
        </button>
      </div>

      <dialog
        ref={dialogRef}
        aria-labelledby="workspace-create-title"
        className="m-auto w-[calc(100%-2rem)] max-w-md rounded-2xl border border-outline-variant bg-surface p-0 text-on-surface shadow-2xl"
      >
        <form onSubmit={handleSubmit} className="p-6">
          <h2
            id="workspace-create-title"
            className="font-display text-xl font-bold tracking-tight text-on-surface"
          >
            {t('workspace.createTitle')}
          </h2>
          <p className="mt-1 text-sm text-on-surface-variant">
            {t('workspace.createSubtitle')}
          </p>

          <label
            htmlFor="workspace-create-name"
            className="mt-5 block text-xs font-semibold uppercase tracking-wide text-on-surface-variant"
          >
            {t('workspace.nameLabel')}
          </label>
          <input
            id="workspace-create-name"
            type="text"
            value={name}
            maxLength={128}
            onChange={(event) => setName(event.target.value)}
            className="mt-1.5 w-full rounded-lg border border-outline bg-surface-container px-3 py-2 text-sm text-on-surface focus:border-primary"
          />

          <label
            htmlFor="workspace-create-slug"
            className="mt-3 block text-xs font-semibold uppercase tracking-wide text-on-surface-variant"
          >
            {t('workspace.slugLabel')}
          </label>
          <input
            id="workspace-create-slug"
            type="text"
            value={slug}
            onChange={(event) => setSlug(event.target.value)}
            placeholder="my-team"
            className="mt-1.5 w-full rounded-lg border border-outline bg-surface-container px-3 py-2 text-sm text-on-surface focus:border-primary"
          />

          {createMutation.isError && (
            <p role="alert" className="mt-3 text-sm text-error">
              {t(
                workspaceErrorKey(
                  createMutation.error,
                  'workspace.errors.create',
                ),
              )}
            </p>
          )}
          {createMutation.isSuccess && (
            <p role="status" className="mt-3 text-sm text-success">
              {t('workspace.created')}
            </p>
          )}

          <div className="mt-5 flex justify-end gap-2">
            <button
              type="button"
              onClick={() => setIsCreateOpen(false)}
              className="rounded-lg border border-outline px-3 py-2 text-sm font-medium text-on-surface-variant transition hover:border-primary/40 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
            >
              {t('common.cancel')}
            </button>
            <button
              type="submit"
              disabled={createMutation.isPending || name.trim() === ''}
              aria-busy={createMutation.isPending}
              className="rounded-lg bg-primary px-3 py-2 text-sm font-semibold text-on-primary transition hover:brightness-95 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary disabled:cursor-not-allowed disabled:opacity-60"
            >
              {createMutation.isPending
                ? t('workspace.creating')
                : t('workspace.createAction')}
            </button>
          </div>
        </form>
      </dialog>
    </>
  );
}

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import {
  adminQueryKeys,
  createPromptVersion,
  fetchPromptVersions,
  fetchPrompts,
  formatAdminDate,
  getAdminErrorMessage,
  getPromptVersionLabel,
  type PromptTemplate,
  type PromptVersion,
} from '../../lib/admin';

function PromptSkeleton() {
  return (
    <ul aria-hidden="true" className="mt-6 space-y-3">
      {[0, 1, 2, 3].map((index) => (
        <li
          key={index}
          className="h-28 animate-pulse rounded-2xl border border-outline-variant bg-surface-container"
        />
      ))}
    </ul>
  );
}

function VersionItem({ version }: { version: PromptVersion }) {
  const { t, i18n } = useTranslation();
  const versionLabel =
    version.version === undefined ? '—' : String(version.version);

  return (
    <li className="rounded-xl border border-outline-variant bg-surface-container p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="inline-flex items-center rounded-full bg-primary-container px-2.5 py-1 text-xs font-semibold text-on-primary-container">
          {t('admin.drawer.version', { version: versionLabel })}
        </span>
        <div className="flex flex-wrap items-center gap-2 text-[11px] text-on-surface-variant">
          {version.environment !== undefined && (
            <span className="rounded-full border border-outline-variant px-2 py-0.5 font-medium">
              {version.environment}
            </span>
          )}
          <span>{formatAdminDate(version.createdAt, i18n.language)}</span>
        </div>
      </div>

      {version.createdBy !== undefined && (
        <p className="mt-2 text-xs text-on-surface-variant">
          {t('admin.drawer.author', { author: version.createdBy })}
        </p>
      )}

      <pre className="mt-3 max-h-40 overflow-y-auto whitespace-pre-wrap break-words rounded-lg bg-surface p-3 font-sans text-sm leading-relaxed text-on-surface">
        {version.content === '' ? t('admin.drawer.noContent') : version.content}
      </pre>
    </li>
  );
}

function VersionsDrawer({
  prompt,
  successMessage,
  onCreateVersion,
  onClose,
}: {
  prompt: PromptTemplate;
  successMessage: string | null;
  onCreateVersion: () => void;
  onClose: () => void;
}) {
  const { t, i18n } = useTranslation();
  const closeButtonRef = useRef<HTMLButtonElement>(null);

  const versionsQuery = useQuery({
    queryKey: adminQueryKeys.promptVersions(prompt.id),
    queryFn: () => fetchPromptVersions(prompt.id),
    staleTime: 15_000,
  });

  useEffect(() => {
    closeButtonRef.current?.focus();

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        onClose();
      }
    };

    document.addEventListener('keydown', handleKeyDown);
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';

    return () => {
      document.removeEventListener('keydown', handleKeyDown);
      document.body.style.overflow = previousOverflow;
    };
  }, [onClose]);

  const versions = versionsQuery.data ?? [];
  const activeVersion =
    versions[0]?.version ?? getPromptVersionLabel(prompt);

  return (
    <>
      <div
        aria-hidden="true"
        className="fixed inset-0 z-40 bg-slate-950/50 backdrop-blur-sm"
        onClick={onClose}
      />
      <aside
        role="dialog"
        aria-modal="true"
        aria-labelledby="admin-prompt-title"
        className="fixed inset-y-0 right-0 z-50 flex w-full max-w-lg flex-col border-l border-outline-variant bg-surface shadow-2xl"
      >
        <div className="flex items-start justify-between gap-4 border-b border-outline-variant p-5">
          <div className="min-w-0">
            <p className="text-xs font-semibold uppercase tracking-[0.16em] text-on-surface-variant">
              {t('admin.drawer.eyebrow')}
            </p>
            <h2
              id="admin-prompt-title"
              className="mt-1 truncate font-display text-2xl font-bold tracking-tight text-on-surface"
            >
              {prompt.name}
            </h2>
            {prompt.description !== undefined && (
              <p className="mt-1 text-sm leading-relaxed text-on-surface-variant">
                {prompt.description}
              </p>
            )}
          </div>

          <button
            ref={closeButtonRef}
            type="button"
            onClick={onClose}
            aria-label={t('admin.drawer.close')}
            title={t('admin.drawer.close')}
            className="rounded-lg p-1.5 text-on-surface-variant transition hover:bg-surface-container-high hover:text-on-surface focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
          >
            <svg
              aria-hidden="true"
              viewBox="0 0 20 20"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.8"
              strokeLinecap="round"
              className="size-4"
            >
              <path d="m5 5 10 10M15 5 5 15" />
            </svg>
          </button>
        </div>

        <div className="flex-1 overflow-y-auto p-5">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <h3 className="font-display text-lg font-bold text-on-surface">
                {t('admin.drawer.versions')}
              </h3>
              <p className="mt-0.5 text-xs text-on-surface-variant">
                {t('admin.drawer.activeVersion', {
                  version: activeVersion,
                })}
              </p>
            </div>
            <button
              type="button"
              onClick={onCreateVersion}
              className="inline-flex items-center gap-1.5 rounded-xl bg-primary px-3.5 py-2 text-sm font-semibold text-on-primary shadow-lg shadow-primary/20 transition hover:brightness-95 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
            >
              <svg
                aria-hidden="true"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.8"
                strokeLinecap="round"
                className="size-4"
              >
                <path d="M12 5v14M5 12h14" />
              </svg>
              {t('admin.drawer.create')}
            </button>
          </div>

          {successMessage !== null && (
            <div
              role="status"
              className="mt-4 rounded-xl border border-success/30 bg-success/10 px-3 py-2.5 text-sm text-success"
            >
              {successMessage}
            </div>
          )}

          {versionsQuery.isPending ? (
            <div aria-hidden="true" className="mt-4 space-y-3">
              {[0, 1, 2].map((index) => (
                <div
                  key={index}
                  className="h-32 animate-pulse rounded-xl bg-surface-container-high"
                />
              ))}
              <span className="sr-only">{t('admin.drawer.loading')}</span>
            </div>
          ) : versionsQuery.isError ? (
            <div
              role="alert"
              className="mt-4 rounded-xl border border-error/30 bg-error-container p-4 text-sm text-on-error-container"
            >
              <p className="font-semibold">{t('admin.drawer.error')}</p>
              <p className="mt-1">
                {getAdminErrorMessage(
                  versionsQuery.error,
                  'admin.errors.versions',
                )}
              </p>
              <button
                type="button"
                onClick={() => {
                  void versionsQuery.refetch();
                }}
                className="mt-3 rounded-lg bg-primary px-3 py-2 text-xs font-semibold text-on-primary transition hover:brightness-95 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
              >
                {t('admin.retry')}
              </button>
            </div>
          ) : versions.length === 0 ? (
            <div className="mt-4 rounded-xl border border-dashed border-outline px-4 py-10 text-center">
              <p className="text-sm text-on-surface-variant">
                {t('admin.drawer.empty')}
              </p>
            </div>
          ) : (
            <ul className="mt-4 space-y-3">
              {versions.map((version) => (
                <VersionItem key={version.id} version={version} />
              ))}
            </ul>
          )}

          <p className="mt-6 text-xs text-on-surface-variant">
            {t('admin.drawer.updatedAt', {
              date: formatAdminDate(prompt.updatedAt, i18n.language),
            })}
          </p>
        </div>
      </aside>
    </>
  );
}

function CreateVersionModal({
  prompt,
  isSaving,
  error,
  onClose,
  onSubmit,
}: {
  prompt: PromptTemplate;
  isSaving: boolean;
  error: string | null;
  onClose: () => void;
  onSubmit: (content: string) => void;
}) {
  const { t } = useTranslation();
  const dialogRef = useRef<HTMLDialogElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const [content, setContent] = useState('');
  const [validationError, setValidationError] = useState<string | null>(null);

  useEffect(() => {
    const dialog = dialogRef.current;

    if (dialog === null) {
      return;
    }

    if (!dialog.open) {
      dialog.showModal();
    }

    const timeoutId = window.setTimeout(() => {
      textareaRef.current?.focus();
    }, 0);

    return () => window.clearTimeout(timeoutId);
  }, []);

  useEffect(() => {
    const dialog = dialogRef.current;

    if (dialog === null) {
      return;
    }

    const handleClose = () => onClose();
    dialog.addEventListener('close', handleClose);

    return () => dialog.removeEventListener('close', handleClose);
  }, [onClose]);

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    if (content.trim() === '') {
      setValidationError(t('admin.versionModal.required'));
      return;
    }

    setValidationError(null);
    onSubmit(content);
  }

  const message = validationError ?? error;

  return (
    <dialog
      ref={dialogRef}
      aria-labelledby="admin-version-title"
      aria-describedby="admin-version-description"
      className="m-auto w-[calc(100%-2rem)] max-w-xl overflow-hidden rounded-2xl border border-outline-variant bg-surface p-0 text-on-surface shadow-2xl"
    >
      <form onSubmit={handleSubmit} className="max-h-[85svh] overflow-y-auto p-6">
        <h2
          id="admin-version-title"
          className="font-display text-xl font-bold tracking-tight text-on-surface"
        >
          {t('admin.versionModal.title')}
        </h2>
        <p
          id="admin-version-description"
          className="mt-1 text-sm text-on-surface-variant"
        >
          {t('admin.versionModal.subtitle', { name: prompt.name })}
        </p>

        <label
          htmlFor="admin-version-content"
          className="mt-5 block text-sm font-medium text-on-surface"
        >
          {t('admin.versionModal.label')}
        </label>
        <textarea
          ref={textareaRef}
          id="admin-version-content"
          name="content"
          rows={10}
          value={content}
          onChange={(event) => {
            setContent(event.target.value);
            setValidationError(null);
          }}
          placeholder={t('admin.versionModal.placeholder')}
          disabled={isSaving}
          aria-invalid={message !== null ? true : undefined}
          aria-describedby={message !== null ? 'admin-version-error' : undefined}
          className="mt-2 block w-full resize-y rounded-xl border border-outline bg-surface-container px-4 py-3 font-mono text-sm leading-relaxed text-on-surface outline-none transition placeholder:text-on-surface-variant/60 hover:border-primary/40 focus:border-primary focus:ring-4 focus:ring-primary/15 disabled:cursor-not-allowed disabled:opacity-60"
        />

        {message !== null && (
          <div
            id="admin-version-error"
            role="alert"
            className="mt-4 rounded-xl border border-error/30 bg-error-container px-4 py-3 text-sm text-on-error-container"
          >
            {message}
          </div>
        )}

        <div className="mt-6 flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            disabled={isSaving}
            className="rounded-xl border border-outline px-4 py-2.5 text-sm font-medium text-on-surface-variant transition hover:border-primary/40 hover:text-on-surface focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary disabled:cursor-not-allowed disabled:opacity-60"
          >
            {t('common.cancel')}
          </button>
          <button
            type="submit"
            disabled={isSaving}
            aria-busy={isSaving}
            className="inline-flex items-center justify-center gap-2 rounded-xl bg-primary px-4 py-2.5 text-sm font-semibold text-on-primary shadow-lg shadow-primary/25 transition hover:brightness-95 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary disabled:cursor-not-allowed disabled:opacity-60"
          >
            {isSaving && (
              <svg
                aria-hidden="true"
                viewBox="0 0 24 24"
                fill="none"
                className="size-4 animate-spin"
              >
                <circle
                  cx="12"
                  cy="12"
                  r="9"
                  stroke="currentColor"
                  strokeOpacity="0.25"
                  strokeWidth="3"
                />
                <path
                  d="M21 12a9 9 0 0 0-9-9"
                  stroke="currentColor"
                  strokeWidth="3"
                  strokeLinecap="round"
                />
              </svg>
            )}
            {isSaving
              ? t('admin.versionModal.saving')
              : t('admin.versionModal.save')}
          </button>
        </div>
      </form>
    </dialog>
  );
}

export function PromptsTab() {
  const { t, i18n } = useTranslation();
  const queryClient = useQueryClient();
  const [selectedPrompt, setSelectedPrompt] = useState<PromptTemplate | null>(
    null,
  );
  const [versionPrompt, setVersionPrompt] = useState<PromptTemplate | null>(
    null,
  );
  const [successMessage, setSuccessMessage] = useState<string | null>(null);

  const promptsQuery = useQuery({
    queryKey: adminQueryKeys.prompts,
    queryFn: fetchPrompts,
    staleTime: 30_000,
  });

  const createVersionMutation = useMutation({
    mutationFn: ({
      promptId,
      content,
    }: {
      promptId: string;
      content: string;
    }) => createPromptVersion(promptId, content),
    onSuccess: (created, { promptId }) => {
      queryClient.setQueryData<PromptVersion[]>(
        adminQueryKeys.promptVersions(promptId),
        (current) => [
          created,
          ...(current ?? []).filter(
            (version) => version.id !== created.id,
          ),
        ],
      );
      queryClient.setQueryData<PromptTemplate[]>(
        adminQueryKeys.prompts,
        (current) =>
          current?.map((prompt) =>
            prompt.id === promptId
              ? {
                  ...prompt,
                  versions: [created],
                  updatedAt: created.createdAt ?? prompt.updatedAt,
                }
              : prompt,
          ),
      );

      void queryClient.invalidateQueries({
        queryKey: adminQueryKeys.promptVersions(promptId),
      });
      void queryClient.invalidateQueries({
        queryKey: adminQueryKeys.prompts,
      });
      setVersionPrompt(null);
      setSuccessMessage(t('admin.versionModal.success'));
    },
  });

  const prompts = promptsQuery.data ?? [];

  function openPrompt(prompt: PromptTemplate) {
    setSelectedPrompt(prompt);
    setSuccessMessage(null);
  }

  function closePrompt() {
    setSelectedPrompt(null);
    setSuccessMessage(null);
  }

  function submitVersion(content: string) {
    if (versionPrompt === null) {
      return;
    }

    createVersionMutation.mutate({
      promptId: versionPrompt.id,
      content,
    });
  }

  return (
    <div>
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 className="font-display text-xl font-bold text-on-surface">
            {t('admin.prompts.title')}
          </h2>
          <p className="mt-1 text-sm text-on-surface-variant">
            {t('admin.prompts.subtitle')}
          </p>
        </div>
        {promptsQuery.data !== undefined && (
          <span className="rounded-full border border-outline-variant bg-surface-container px-3 py-1 text-xs font-medium text-on-surface-variant">
            {t('admin.prompts.count', { count: prompts.length })}
          </span>
        )}
      </div>

      {promptsQuery.isPending ? (
        <>
          <span className="sr-only">{t('admin.prompts.loading')}</span>
          <PromptSkeleton />
        </>
      ) : promptsQuery.isError ? (
        <div
          role="alert"
          className="mt-6 rounded-2xl border border-error/30 bg-error-container p-5 text-on-error-container"
        >
          <h3 className="font-display text-lg font-bold">
            {t('admin.prompts.errorTitle')}
          </h3>
          <p className="mt-2 text-sm">
            {getAdminErrorMessage(
              promptsQuery.error,
              'admin.errors.prompts',
            )}
          </p>
          <button
            type="button"
            onClick={() => {
              void promptsQuery.refetch();
            }}
            className="mt-3 rounded-lg bg-primary px-3 py-2 text-xs font-semibold text-on-primary transition hover:brightness-95 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
          >
            {t('admin.retry')}
          </button>
        </div>
      ) : prompts.length === 0 ? (
        <div className="mt-6 rounded-2xl border border-dashed border-outline px-6 py-14 text-center">
          <h3 className="font-display text-lg font-bold text-on-surface">
            {t('admin.prompts.emptyTitle')}
          </h3>
          <p className="mx-auto mt-2 max-w-md text-sm text-on-surface-variant">
            {t('admin.prompts.emptyBody')}
          </p>
        </div>
      ) : (
        <ul className="mt-6 space-y-3">
          {prompts.map((prompt) => (
            <li key={prompt.id}>
              <button
                type="button"
                onClick={() => openPrompt(prompt)}
                className="group flex w-full items-start justify-between gap-4 rounded-2xl border border-outline-variant bg-surface-container p-5 text-left transition hover:border-primary/40 hover:shadow-md focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
              >
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <h3 className="font-display text-lg font-bold text-on-surface">
                      {prompt.name}
                    </h3>
                    {prompt.isActive === false && (
                      <span className="rounded-full border border-outline-variant px-2 py-0.5 text-[10px] uppercase tracking-wide text-on-surface-variant">
                        {t('admin.prompts.inactive')}
                      </span>
                    )}
                  </div>
                  {prompt.slug !== undefined && (
                    <p className="mt-0.5 font-mono text-xs text-on-surface-variant">
                      {prompt.slug}
                    </p>
                  )}
                  {prompt.description !== undefined && (
                    <p className="mt-2 line-clamp-2 text-sm leading-relaxed text-on-surface-variant">
                      {prompt.description}
                    </p>
                  )}
                  <div className="mt-3 flex flex-wrap items-center gap-2 text-xs text-on-surface-variant">
                    <span className="rounded-full bg-primary-container px-2.5 py-1 font-semibold text-on-primary-container">
                      v{getPromptVersionLabel(prompt)}
                    </span>
                    {prompt.updatedAt !== undefined && (
                      <span>
                        {t('admin.prompts.updatedAt', {
                          date: formatAdminDate(
                            prompt.updatedAt,
                            i18n.language,
                          ),
                        })}
                      </span>
                    )}
                  </div>
                </div>

                <svg
                  aria-hidden="true"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.8"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  className="mt-1 size-5 shrink-0 text-on-surface-variant transition group-hover:translate-x-0.5 group-hover:text-primary"
                >
                  <path d="M9 6l6 6-6 6" />
                </svg>
              </button>
            </li>
          ))}
        </ul>
      )}

      {selectedPrompt !== null && (
        <VersionsDrawer
          prompt={selectedPrompt}
          successMessage={successMessage}
          onCreateVersion={() => {
            createVersionMutation.reset();
            setVersionPrompt(selectedPrompt);
          }}
          onClose={closePrompt}
        />
      )}

      {versionPrompt !== null && (
        <CreateVersionModal
          prompt={versionPrompt}
          isSaving={createVersionMutation.isPending}
          error={
            createVersionMutation.isError
              ? getAdminErrorMessage(
                  createVersionMutation.error,
                  'admin.errors.createVersion',
                )
              : null
          }
          onClose={() => setVersionPrompt(null)}
          onSubmit={submitVersion}
        />
      )}
    </div>
  );
}

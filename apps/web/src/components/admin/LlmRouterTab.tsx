import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import {
  adminQueryKeys,
  createLlmRoute,
  fetchLlmRoutes,
  getAdminErrorMessage,
  getLlmRouteBaseUrl,
  getLlmRouteModel,
  getLlmRouteProvider,
  type CreateLlmRouteInput,
  type LlmProviderType,
  type LlmRoute,
} from '../../lib/admin';

const INPUT_CLASSES =
  'mt-2 block w-full rounded-xl border border-outline bg-surface-container px-4 py-2.5 text-sm text-on-surface outline-none transition placeholder:text-on-surface-variant/60 hover:border-primary/40 focus:border-primary focus:ring-4 focus:ring-primary/15 disabled:cursor-not-allowed disabled:opacity-60';

const PROVIDERS: readonly LlmProviderType[] = [
  'OpenAI',
  'YandexGPT',
  'GigaChat',
];

const MODEL_PLACEHOLDERS: Record<LlmProviderType, string> = {
  OpenAI: 'gpt-4o-mini',
  YandexGPT: 'gpt://<folder-id>/yandexgpt-lite',
  GigaChat: 'GigaChat-Pro',
};

function providerBadgeClasses(provider: LlmProviderType): string {
  if (provider === 'YandexGPT') {
    return 'bg-warning-container text-on-warning-container';
  }

  if (provider === 'GigaChat') {
    return 'bg-success/10 text-success';
  }

  return 'bg-primary-container text-on-primary-container';
}

function RouteSkeleton() {
  return (
    <div aria-hidden="true" className="mt-6 space-y-2">
      {[0, 1, 2, 3].map((index) => (
        <div
          key={index}
          className="h-14 animate-pulse rounded-xl bg-surface-container"
        />
      ))}
    </div>
  );
}

function AddRouteModal({
  isSaving,
  error,
  onClose,
  onSubmit,
}: {
  isSaving: boolean;
  error: string | null;
  onClose: () => void;
  onSubmit: (input: CreateLlmRouteInput) => void;
}) {
  const { t } = useTranslation();
  const dialogRef = useRef<HTMLDialogElement>(null);
  const nameInputRef = useRef<HTMLInputElement>(null);
  const [name, setName] = useState('');
  const [providerType, setProviderType] =
    useState<LlmProviderType>('OpenAI');
  const [modelName, setModelName] = useState('');
  const [baseUrl, setBaseUrl] = useState('');
  const [priority, setPriority] = useState('100');
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
      nameInputRef.current?.focus();
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

    const parsedPriority = Number(priority);

    if (
      name.trim() === '' ||
      modelName.trim() === '' ||
      baseUrl.trim() === '' ||
      !Number.isFinite(parsedPriority)
    ) {
      setValidationError(t('admin.router.modal.invalid'));
      return;
    }

    setValidationError(null);
    onSubmit({
      name: name.trim(),
      modelName: modelName.trim(),
      providerType,
      baseUrl: baseUrl.trim(),
      priority: parsedPriority,
    });
  }

  const message = validationError ?? error;

  return (
    <dialog
      ref={dialogRef}
      aria-labelledby="admin-route-title"
      aria-describedby="admin-route-description"
      className="m-auto w-[calc(100%-2rem)] max-w-lg overflow-hidden rounded-2xl border border-outline-variant bg-surface p-0 text-on-surface shadow-2xl"
    >
      <form onSubmit={handleSubmit} className="max-h-[85svh] overflow-y-auto p-6">
        <h2
          id="admin-route-title"
          className="font-display text-xl font-bold tracking-tight text-on-surface"
        >
          {t('admin.router.modal.title')}
        </h2>
        <p
          id="admin-route-description"
          className="mt-1 text-sm text-on-surface-variant"
        >
          {t('admin.router.modal.subtitle')}
        </p>

        <div className="mt-5 space-y-4">
          <div>
            <label
              htmlFor="admin-route-name"
              className="block text-sm font-medium text-on-surface"
            >
              {t('admin.router.modal.name')}
            </label>
            <input
              ref={nameInputRef}
              id="admin-route-name"
              name="name"
              type="text"
              required
              value={name}
              onChange={(event) => {
                setName(event.target.value);
                setValidationError(null);
              }}
              placeholder={t('admin.router.modal.namePlaceholder')}
              disabled={isSaving}
              className={INPUT_CLASSES}
            />
          </div>

          <div>
            <label
              htmlFor="admin-route-provider"
              className="block text-sm font-medium text-on-surface"
            >
              {t('admin.router.modal.provider')}
            </label>
            <select
              id="admin-route-provider"
              name="providerType"
              value={providerType}
              onChange={(event) => {
                setProviderType(event.target.value as LlmProviderType);
                setValidationError(null);
              }}
              disabled={isSaving}
              className={INPUT_CLASSES}
            >
              {PROVIDERS.map((provider) => (
                <option key={provider} value={provider}>
                  {provider}
                </option>
              ))}
            </select>
          </div>

          <div>
            <label
              htmlFor="admin-route-model"
              className="block text-sm font-medium text-on-surface"
            >
              {t('admin.router.modal.model')}
            </label>
            <input
              id="admin-route-model"
              name="modelName"
              type="text"
              required
              value={modelName}
              onChange={(event) => {
                setModelName(event.target.value);
                setValidationError(null);
              }}
              placeholder={MODEL_PLACEHOLDERS[providerType]}
              disabled={isSaving}
              className={INPUT_CLASSES}
            />
            {providerType === 'YandexGPT' && (
              <p className="mt-2 rounded-xl border border-warning/30 bg-warning-container/40 px-3 py-2 text-xs leading-relaxed text-on-warning-container">
                {t('admin.router.modal.yandexHint')}
              </p>
            )}
            {providerType === 'GigaChat' && (
              <p className="mt-2 rounded-xl border border-warning/30 bg-warning-container/40 px-3 py-2 text-xs leading-relaxed text-on-warning-container">
                {t('admin.router.modal.gigachatHint')}
              </p>
            )}
          </div>

          <div>
            <label
              htmlFor="admin-route-base-url"
              className="block text-sm font-medium text-on-surface"
            >
              {t('admin.router.modal.baseUrl')}
            </label>
            <input
              id="admin-route-base-url"
              name="baseUrl"
              type="text"
              required
              value={baseUrl}
              onChange={(event) => {
                setBaseUrl(event.target.value);
                setValidationError(null);
              }}
              placeholder={t('admin.router.modal.baseUrlPlaceholder')}
              disabled={isSaving}
              className={`${INPUT_CLASSES} font-mono`}
            />
          </div>

          <div>
            <label
              htmlFor="admin-route-priority"
              className="block text-sm font-medium text-on-surface"
            >
              {t('admin.router.modal.priority')}
            </label>
            <input
              id="admin-route-priority"
              name="priority"
              type="number"
              min="0"
              step="1"
              required
              value={priority}
              onChange={(event) => {
                setPriority(event.target.value);
                setValidationError(null);
              }}
              disabled={isSaving}
              className={INPUT_CLASSES}
            />
          </div>
        </div>

        {message !== null && (
          <div
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
              ? t('admin.router.modal.saving')
              : t('admin.router.modal.save')}
          </button>
        </div>
      </form>
    </dialog>
  );
}

function RouteRow({ route }: { route: LlmRoute }) {
  const provider = getLlmRouteProvider(route);

  return (
    <tr className="transition hover:bg-surface-container/60">
      <td className="px-4 py-3">
        <div className="flex items-center gap-2">
          <span className="font-medium text-on-surface">{route.name}</span>
          {route.isActive === false && (
            <span className="rounded-full border border-outline-variant px-2 py-0.5 text-[10px] uppercase tracking-wide text-on-surface-variant">
              off
            </span>
          )}
        </div>
      </td>
      <td className="px-4 py-3">
        <span
          className={`inline-flex rounded-full px-2.5 py-1 text-[11px] font-semibold ${providerBadgeClasses(provider)}`}
        >
          {provider}
        </span>
      </td>
      <td className="px-4 py-3">
        <span className="rounded-md bg-surface-container-high px-2 py-1 font-mono text-xs text-on-surface">
          {getLlmRouteModel(route)}
        </span>
      </td>
      <td
        className="max-w-xs truncate px-4 py-3 font-mono text-xs text-on-surface-variant"
        title={getLlmRouteBaseUrl(route)}
      >
        {getLlmRouteBaseUrl(route)}
      </td>
      <td className="px-4 py-3 text-right tabular-nums text-on-surface">
        {route.priority ?? '—'}
      </td>
    </tr>
  );
}

export function LlmRouterTab() {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);

  const routesQuery = useQuery({
    queryKey: adminQueryKeys.llmRoutes,
    queryFn: fetchLlmRoutes,
    staleTime: 30_000,
  });

  const createRouteMutation = useMutation({
    mutationFn: (input: CreateLlmRouteInput) => createLlmRoute(input),
    onSuccess: () => {
      void queryClient.invalidateQueries({
        queryKey: adminQueryKeys.llmRoutes,
      });
      setIsModalOpen(false);
      setSuccessMessage(t('admin.router.modal.success'));
    },
  });

  const routes = routesQuery.data ?? [];

  function openModal() {
    createRouteMutation.reset();
    setSuccessMessage(null);
    setIsModalOpen(true);
  }

  return (
    <div>
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 className="font-display text-xl font-bold text-on-surface">
            {t('admin.router.title')}
          </h2>
          <p className="mt-1 text-sm text-on-surface-variant">
            {t('admin.router.subtitle')}
          </p>
        </div>
        <div className="flex items-center gap-2">
          {routesQuery.data !== undefined && (
            <span className="rounded-full border border-outline-variant bg-surface-container px-3 py-1 text-xs font-medium text-on-surface-variant">
              {t('admin.router.count', { count: routes.length })}
            </span>
          )}
          <button
            type="button"
            onClick={openModal}
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
            {t('admin.router.add')}
          </button>
        </div>
      </div>

      {successMessage !== null && (
        <div
          role="status"
          className="mt-4 rounded-xl border border-success/30 bg-success/10 px-3 py-2.5 text-sm text-success"
        >
          {successMessage}
        </div>
      )}

      {routesQuery.isPending ? (
        <>
          <span className="sr-only">{t('admin.router.loading')}</span>
          <RouteSkeleton />
        </>
      ) : routesQuery.isError ? (
        <div
          role="alert"
          className="mt-6 rounded-2xl border border-error/30 bg-error-container p-5 text-on-error-container"
        >
          <h3 className="font-display text-lg font-bold">
            {t('admin.router.errorTitle')}
          </h3>
          <p className="mt-2 text-sm">
            {getAdminErrorMessage(routesQuery.error, 'admin.errors.router')}
          </p>
          <button
            type="button"
            onClick={() => {
              void routesQuery.refetch();
            }}
            className="mt-3 rounded-lg bg-primary px-3 py-2 text-xs font-semibold text-on-primary transition hover:brightness-95 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
          >
            {t('admin.retry')}
          </button>
        </div>
      ) : routes.length === 0 ? (
        <div className="mt-6 rounded-2xl border border-dashed border-outline px-6 py-14 text-center">
          <h3 className="font-display text-lg font-bold text-on-surface">
            {t('admin.router.emptyTitle')}
          </h3>
          <p className="mx-auto mt-2 max-w-md text-sm text-on-surface-variant">
            {t('admin.router.emptyBody')}
          </p>
          <button
            type="button"
            onClick={openModal}
            className="mt-4 rounded-xl bg-primary px-4 py-2.5 text-sm font-semibold text-on-primary transition hover:brightness-95 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
          >
            {t('admin.router.add')}
          </button>
        </div>
      ) : (
        <div className="mt-6 overflow-x-auto rounded-2xl border border-outline-variant bg-surface-container">
          <table className="w-full min-w-[760px] text-left text-sm">
            <thead className="border-b border-outline-variant bg-surface-container-high text-[11px] uppercase tracking-wider text-on-surface-variant">
              <tr>
                <th scope="col" className="px-4 py-3 font-semibold">
                  {t('admin.router.columns.name')}
                </th>
                <th scope="col" className="px-4 py-3 font-semibold">
                  {t('admin.router.columns.provider')}
                </th>
                <th scope="col" className="px-4 py-3 font-semibold">
                  {t('admin.router.columns.model')}
                </th>
                <th scope="col" className="px-4 py-3 font-semibold">
                  {t('admin.router.columns.baseUrl')}
                </th>
                <th
                  scope="col"
                  className="px-4 py-3 text-right font-semibold"
                >
                  {t('admin.router.columns.priority')}
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-outline-variant">
              {routes.map((route) => (
                <RouteRow key={route.id} route={route} />
              ))}
            </tbody>
          </table>
        </div>
      )}

      {isModalOpen && (
        <AddRouteModal
          isSaving={createRouteMutation.isPending}
          error={
            createRouteMutation.isError
              ? getAdminErrorMessage(
                  createRouteMutation.error,
                  'admin.errors.createRoute',
                )
              : null
          }
          onClose={() => setIsModalOpen(false)}
          onSubmit={(input) => createRouteMutation.mutate(input)}
        />
      )}
    </div>
  );
}

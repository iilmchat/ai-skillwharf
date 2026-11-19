import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import {
  createTrigger,
  createTriggerInputSchema,
  deleteTrigger,
  fetchTriggers,
  getTriggerErrorKind,
  getTriggerWebhookUrl,
  triggersQueryKeyFor,
  type CreatedTrigger,
  type Trigger,
  type TriggerErrorKind,
  type TriggerSource,
} from '../lib/triggers';
import { useAuthStore } from '../store/auth.store';

const SECTION_CLASSES =
  'rounded-2xl border border-outline-variant bg-surface-container p-5 shadow-sm sm:p-6';

const CARD_CLASSES =
  'rounded-xl border border-outline-variant bg-surface p-4 sm:p-5';

const INPUT_CLASSES =
  'mt-2 block w-full rounded-xl border border-outline bg-surface-container px-4 py-2.5 text-sm text-on-surface outline-none transition placeholder:text-on-surface-variant/60 hover:border-primary/40 focus:border-primary focus:ring-4 focus:ring-primary/15 disabled:cursor-not-allowed disabled:opacity-60';

const PRIMARY_BUTTON_CLASSES =
  'inline-flex items-center justify-center gap-2 rounded-xl bg-primary px-4 py-2.5 text-sm font-semibold text-on-primary shadow-lg shadow-primary/20 transition hover:brightness-95 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary disabled:cursor-not-allowed disabled:opacity-60';

const DANGER_BUTTON_CLASSES =
  'inline-flex items-center justify-center gap-2 rounded-xl border border-error/40 px-4 py-2.5 text-sm font-semibold text-error transition hover:bg-error-container hover:text-on-error-container focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-error disabled:cursor-not-allowed disabled:opacity-60';

const SECONDARY_BUTTON_CLASSES =
  'inline-flex items-center justify-center gap-2 rounded-xl border border-outline px-3 py-2 text-xs font-semibold text-on-surface-variant transition hover:bg-surface-container-high hover:text-on-surface focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary disabled:cursor-not-allowed disabled:opacity-60';

const SOURCE_KEYS: Record<TriggerSource, string> = {
  bitrix24: 'settings.triggers.sources.bitrix24',
  moysklad: 'settings.triggers.sources.moysklad',
  '1c': 'settings.triggers.sources.1c',
  custom: 'settings.triggers.sources.custom',
};

const ERROR_KEYS: Record<TriggerErrorKind, string> = {
  network: 'settings.triggers.errors.network',
  sessionExpired: 'settings.triggers.errors.sessionExpired',
  forbidden: 'settings.triggers.errors.forbidden',
  notFound: 'settings.triggers.errors.notFound',
  slugConflict: 'settings.triggers.errors.slugConflict',
  unavailable: 'settings.triggers.errors.unavailable',
  invalidResponse: 'settings.triggers.errors.invalidResponse',
  requestFailed: 'settings.triggers.errors.requestFailed',
  unknown: 'settings.triggers.errors.unknown',
};

function TriggerErrorAlert({ error }: { error: unknown }) {
  const { t } = useTranslation();

  return (
    <div
      role="alert"
      className="mt-3 rounded-xl border border-error/30 bg-error-container px-3 py-2.5 text-sm leading-relaxed text-on-error-container"
    >
      {t(ERROR_KEYS[getTriggerErrorKind(error)])}
    </div>
  );
}

/** Поле для копирования: URL показывается открыто, секрет — маскируется. */
function CopyableValue({
  id,
  label,
  hint,
  value,
  masked,
}: {
  id: string;
  label: string;
  hint: string;
  value: string;
  masked: boolean;
}) {
  const { t } = useTranslation();
  const [visible, setVisible] = useState(!masked);
  const [copyState, setCopyState] = useState<'idle' | 'copied' | 'failed'>(
    'idle',
  );
  const isHidden = masked && !visible;

  async function handleCopy(): Promise<void> {
    try {
      await navigator.clipboard.writeText(value);
      setCopyState('copied');
    } catch {
      setCopyState('failed');
    }
  }

  return (
    <div className="mt-4">
      <label
        htmlFor={id}
        className="block text-sm font-medium text-on-surface"
      >
        {label}
      </label>
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <input
          id={id}
          type={isHidden ? 'password' : 'text'}
          readOnly
          spellCheck={false}
          value={value}
          className={`${INPUT_CLASSES} mt-0 min-w-0 flex-1 font-mono`}
        />
        {masked && (
          <button
            type="button"
            onClick={() => setVisible(!visible)}
            aria-pressed={visible}
            aria-controls={id}
            className={SECONDARY_BUTTON_CLASSES}
          >
            {visible
              ? t('settings.integrations.secret.hide')
              : t('settings.integrations.secret.show')}
          </button>
        )}
        <button
          type="button"
          onClick={() => {
            void handleCopy();
          }}
          className={SECONDARY_BUTTON_CLASSES}
        >
          {t('settings.triggers.created.copy')}
        </button>
      </div>
      <p className="mt-2 text-xs leading-relaxed text-on-surface-variant">
        {hint}
      </p>
      {copyState !== 'idle' && (
        <p
          role="status"
          className={`mt-1 text-xs font-medium ${copyState === 'copied' ? 'text-success' : 'text-error'}`}
        >
          {copyState === 'copied'
            ? t('settings.triggers.created.copied')
            : t('settings.triggers.created.copyFailed')}
        </p>
      )}
    </div>
  );
}

/** Карточка с одноразовым секретом: показывается сразу после создания. */
function CreatedTriggerCard({
  created,
  onClose,
}: {
  created: CreatedTrigger;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const webhookUrl = getTriggerWebhookUrl(
    created.slug,
    typeof window === 'undefined' ? '' : window.location.origin,
  );

  return (
    <div
      role="dialog"
      aria-modal="false"
      aria-labelledby="trigger-created-title"
      className={`${CARD_CLASSES} mt-5 border-primary/40 bg-primary-container/20`}
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h3
            id="trigger-created-title"
            className="font-display text-base font-bold text-on-surface"
          >
            {t('settings.triggers.created.title')}
          </h3>
          <p className="mt-1 text-sm leading-relaxed text-on-surface-variant">
            {t('settings.triggers.created.description', { name: created.name })}
          </p>
        </div>
        <button type="button" onClick={onClose} className={SECONDARY_BUTTON_CLASSES}>
          {t('settings.triggers.created.done')}
        </button>
      </div>

      <CopyableValue
        id="trigger-webhook-url"
        label={t('settings.triggers.created.webhookUrl')}
        hint={t('settings.triggers.created.webhookUrlHint')}
        value={webhookUrl}
        masked={false}
      />
      <CopyableValue
        id="trigger-secret"
        label={t('settings.triggers.created.secret')}
        hint={t('settings.triggers.created.secretHint')}
        value={created.secret}
        masked
      />
    </div>
  );
}

function TriggerCard({
  trigger,
  isDeleting,
  onDelete,
  deleteError,
}: {
  trigger: Trigger;
  isDeleting: boolean;
  onDelete: () => void;
  deleteError: unknown;
}) {
  const { t } = useTranslation();

  return (
    <li className={CARD_CLASSES}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="font-display text-sm font-bold text-on-surface">
            {trigger.name}
          </p>
          <p className="mt-1 text-xs text-on-surface-variant">
            {t(SOURCE_KEYS[trigger.source])}
          </p>
        </div>
        <span className="shrink-0 rounded-full border border-outline-variant bg-surface-container px-2.5 py-1 text-[11px] font-semibold text-on-surface-variant">
          {t('settings.triggers.list.invocations', {
            invocations: trigger.triggerCount,
          })}
        </span>
      </div>
      <p className="mt-3 break-words rounded-lg bg-surface-container px-3 py-2 font-mono text-xs text-on-surface-variant">
        {trigger.promptTemplate}
      </p>
      <div className="mt-3 flex flex-wrap items-center gap-3">
        <button
          type="button"
          onClick={onDelete}
          disabled={isDeleting}
          aria-busy={isDeleting}
          className={DANGER_BUTTON_CLASSES}
        >
          {isDeleting
            ? t('settings.triggers.list.deleting')
            : t('settings.triggers.list.delete')}
        </button>
        {trigger.status === 'paused' && (
          <span className="text-xs font-medium text-on-surface-variant">
            {t('settings.triggers.list.paused')}
          </span>
        )}
      </div>
      {deleteError !== undefined && deleteError !== null && (
        <TriggerErrorAlert error={deleteError} />
      )}
    </li>
  );
}

export function TriggersSection() {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const accessToken = useAuthStore((state) => state.accessToken);
  const userId = useAuthStore((state) => state.user?.id ?? null);
  const [name, setName] = useState('');
  const [source, setSource] = useState<TriggerSource>('1c');
  const [promptTemplate, setPromptTemplate] = useState('');
  const [formError, setFormError] = useState<string | null>(null);
  const [created, setCreated] = useState<CreatedTrigger | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [deleteError, setDeleteError] = useState<unknown>(null);
  const queryKey = triggersQueryKeyFor(userId);

  const triggersQuery = useQuery({
    queryKey,
    queryFn: fetchTriggers,
    enabled: accessToken !== null && userId !== null,
    staleTime: 30_000,
  });

  function refresh(): void {
    void queryClient.invalidateQueries({ queryKey });
  }

  const createMutation = useMutation({
    mutationFn: createTrigger,
    onSuccess: (data) => {
      setCreated(data);
      setName('');
      setPromptTemplate('');
      setFormError(null);
      refresh();
    },
  });

  const deleteMutation = useMutation({
    mutationFn: deleteTrigger,
    onMutate: (id: string) => {
      setDeletingId(id);
      setDeleteError(null);
    },
    onSettled: () => {
      setDeletingId(null);
      refresh();
    },
    onError: (error) => {
      setDeleteError(error);
    },
  });

  function handleSubmit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    const parsed = createTriggerInputSchema.safeParse({
      name,
      source,
      promptTemplate,
    });

    if (!parsed.success) {
      setFormError(t('settings.triggers.errors.invalidFields'));

      return;
    }

    setFormError(null);
    createMutation.mutate(parsed.data);
  }

  return (
    <section
      aria-labelledby="triggers-title"
      aria-describedby="triggers-description"
      className={SECTION_CLASSES}
    >
      <div className="min-w-0 max-w-2xl">
        <h2
          id="triggers-title"
          className="font-display text-lg font-bold text-on-surface"
        >
          {t('settings.triggers.title')}
        </h2>
        <p
          id="triggers-description"
          className="mt-2 text-sm leading-relaxed text-on-surface-variant"
        >
          {t('settings.triggers.description')}
        </p>
      </div>

      {created !== null && (
        <CreatedTriggerCard created={created} onClose={() => setCreated(null)} />
      )}

      <form onSubmit={handleSubmit} className={`${CARD_CLASSES} mt-5`}>
        <h3 className="font-display text-base font-bold text-on-surface">
          {t('settings.triggers.form.title')}
        </h3>

        <div className="mt-4">
          <label
            htmlFor="trigger-name"
            className="block text-sm font-medium text-on-surface"
          >
            {t('settings.triggers.form.name')}
          </label>
          <input
            id="trigger-name"
            name="name"
            type="text"
            value={name}
            onChange={(event) => {
              setName(event.target.value);
              setFormError(null);
            }}
            placeholder={t('settings.triggers.form.namePlaceholder')}
            disabled={createMutation.isPending}
            className={INPUT_CLASSES}
          />
        </div>

        <div className="mt-4">
          <label
            htmlFor="trigger-source"
            className="block text-sm font-medium text-on-surface"
          >
            {t('settings.triggers.form.source')}
          </label>
          <select
            id="trigger-source"
            name="source"
            value={source}
            onChange={(event) => setSource(event.target.value as TriggerSource)}
            disabled={createMutation.isPending}
            className={INPUT_CLASSES}
          >
            {(Object.keys(SOURCE_KEYS) as TriggerSource[]).map((key) => (
              <option key={key} value={key}>
                {t(SOURCE_KEYS[key])}
              </option>
            ))}
          </select>
        </div>

        <div className="mt-4">
          <label
            htmlFor="trigger-prompt"
            className="block text-sm font-medium text-on-surface"
          >
            {t('settings.triggers.form.promptTemplate')}
          </label>
          <textarea
            id="trigger-prompt"
            name="promptTemplate"
            rows={3}
            value={promptTemplate}
            onChange={(event) => {
              setPromptTemplate(event.target.value);
              setFormError(null);
            }}
            placeholder={t('settings.triggers.form.promptPlaceholder', {
              payload: '{{payload}}',
            })}
            disabled={createMutation.isPending}
            className={INPUT_CLASSES}
          />
          <p className="mt-2 text-xs leading-relaxed text-on-surface-variant">
            {t('settings.triggers.form.promptHint', {
              payload: '{{payload}}',
            })}
          </p>
        </div>

        {formError !== null && (
          <p role="alert" className="mt-3 text-sm text-error">
            {formError}
          </p>
        )}

        <div className="mt-4 flex flex-wrap items-center gap-3">
          <button
            type="submit"
            disabled={createMutation.isPending}
            aria-busy={createMutation.isPending}
            className={PRIMARY_BUTTON_CLASSES}
          >
            {createMutation.isPending
              ? t('settings.triggers.form.creating')
              : t('settings.triggers.form.create')}
          </button>
          {createMutation.isSuccess && (
            <p role="status" className="text-sm font-medium text-success">
              {t('settings.triggers.form.created')}
            </p>
          )}
        </div>
        {createMutation.isError && (
          <TriggerErrorAlert error={createMutation.error} />
        )}
      </form>

      <div className="mt-6">
        <h3 className="font-display text-base font-bold text-on-surface">
          {t('settings.triggers.list.title')}
        </h3>

        {triggersQuery.isPending ? (
          <p className="mt-3 text-sm text-on-surface-variant">
            {t('settings.triggers.list.loading')}
          </p>
        ) : triggersQuery.isError || triggersQuery.data === undefined ? (
          <div className="mt-3">
            <TriggerErrorAlert error={triggersQuery.error} />
            <button
              type="button"
              onClick={() => {
                void triggersQuery.refetch();
              }}
              className={SECONDARY_BUTTON_CLASSES}
            >
              {t('settings.triggers.list.retry')}
            </button>
          </div>
        ) : triggersQuery.data.length === 0 ? (
          <p className="mt-3 text-sm text-on-surface-variant">
            {t('settings.triggers.list.empty')}
          </p>
        ) : (
          <ul className="mt-3 space-y-3">
            {triggersQuery.data.map((trigger) => (
              <TriggerCard
                key={trigger.id}
                trigger={trigger}
                isDeleting={deletingId === trigger.id && deleteMutation.isPending}
                onDelete={() => deleteMutation.mutate(trigger.id)}
                deleteError={deletingId === trigger.id ? deleteError : null}
              />
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}

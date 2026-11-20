import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import {
  connectCorpChannel,
  connectCorpChannelSchema,
  deleteCorpChannel,
  fetchCorpChannels,
  getCorpChannelsErrorKind,
  corpChannelsQueryKey,
  type CorpChannel,
  type CorpProvider,
} from '../lib/corp-channels';
import {
  fetchWorkspaces,
  resolveActiveWorkspace,
  workspaceQueryKeys,
} from '../lib/workspaces';
import { useAuthStore } from '../store/auth.store';
import { useWorkspaceStore } from '../store/workspace.store';
import { SecretField } from './SecretField';

const SECTION_CLASSES =
  'rounded-2xl border border-outline-variant bg-surface-container p-5 shadow-sm sm:p-6';

const BUTTON_CLASSES =
  'inline-flex items-center justify-center rounded-lg bg-primary px-3 py-2 text-xs font-semibold text-on-primary transition hover:brightness-95 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary disabled:cursor-not-allowed disabled:opacity-40';

const PROVIDERS: readonly CorpProvider[] = [
  'vk_teams',
  'pachca',
  'yandex_messenger',
];

function CopyButton({
  value,
  label,
  onCopied,
}: {
  value: string;
  label: string;
  onCopied: () => void;
}) {
  async function handleCopy(): Promise<void> {
    try {
      await navigator.clipboard.writeText(value);
      onCopied();
    } catch {
      // Буфер обмена недоступен — значение остаётся видимым для ручного копирования.
    }
  }

  return (
    <button
      type="button"
      onClick={() => void handleCopy()}
      className="shrink-0 rounded-lg border border-outline px-2 py-1 text-[11px] font-medium text-on-surface-variant transition hover:bg-surface-container focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
    >
      {label}
    </button>
  );
}

function ChannelCard({
  channel,
  onDelete,
  onCopied,
}: {
  channel: CorpChannel;
  onDelete: (channel: CorpChannel) => void;
  onCopied: () => void;
}) {
  const { t } = useTranslation();

  return (
    <li className="rounded-xl border border-outline-variant bg-surface-container-high p-4">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="truncate text-sm font-semibold text-on-surface">
            {channel.name}
          </p>
          <p className="mt-0.5 text-[11px] text-on-surface-variant">
            {t(`settings.corp.providers.${channel.provider}.label`)} ·{' '}
            {channel.tokenMasked}
          </p>
        </div>
        <span
          className={`rounded-full px-2 py-0.5 text-[10px] font-semibold ${
            channel.isActive
              ? 'bg-tertiary-container text-on-tertiary-container'
              : 'bg-surface-container text-on-surface-variant'
          }`}
        >
          {t(
            channel.isActive
              ? 'settings.corp.active'
              : 'settings.corp.inactive',
          )}
        </span>
      </div>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <code className="min-w-0 flex-1 truncate rounded-lg bg-surface px-2 py-1 text-[11px] text-on-surface-variant">
          {channel.webhookUrl}
        </code>
        <CopyButton
          value={channel.webhookUrl}
          label={t('settings.corp.copyUrl')}
          onCopied={onCopied}
        />
        <button
          type="button"
          onClick={() => onDelete(channel)}
          className="shrink-0 rounded-lg border border-error/40 px-2 py-1 text-[11px] font-medium text-on-error transition hover:bg-error-container focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-error"
        >
          {t('settings.corp.disconnect')}
        </button>
      </div>
      <p className="mt-2 text-[11px] text-on-surface-variant">
        {t('settings.corp.allowedChats', {
          ids: channel.allowedChatIds.join(', ') || '—',
        })}
      </p>
    </li>
  );
}

/** Управление корпоративными мессенджерами воркспейса (OMNI-40.3/40.4). */
export function CorpChannelsSection() {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const accessToken = useAuthStore((state) => state.accessToken);
  const activeWorkspaceId = useWorkspaceStore(
    (state) => state.activeWorkspaceId,
  );
  const [provider, setProvider] = useState<CorpProvider>('vk_teams');
  const [name, setName] = useState('');
  const [botToken, setBotToken] = useState('');
  const [apiBaseUrl, setApiBaseUrl] = useState('');
  const [allowedChatIds, setAllowedChatIds] = useState('');
  const [showToken, setShowToken] = useState(false);
  const [created, setCreated] = useState<CorpChannel | null>(null);
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

  const channelsQuery = useQuery({
    queryKey: corpChannelsQueryKey(workspaceId ?? ''),
    queryFn: () => fetchCorpChannels(workspaceId ?? ''),
    enabled: workspaceId !== null,
    retry: false,
  });

  function handleError(cause: unknown): void {
    setError(t(`settings.corp.errors.${getCorpChannelsErrorKind(cause)}`));
  }

  const connectMutation = useMutation({
    mutationFn: (payload: {
      provider: CorpProvider;
      name: string;
      botToken: string;
      allowedChatIds: string[];
      apiBaseUrl?: string;
    }) => connectCorpChannel(workspaceId ?? '', payload),
    onSuccess: (channel) => {
      setCreated(channel);
      setName('');
      setBotToken('');
      setApiBaseUrl('');
      setAllowedChatIds('');
      setError(null);
      setNotice(t('settings.corp.connected'));
      void queryClient.invalidateQueries({
        queryKey: corpChannelsQueryKey(workspaceId ?? ''),
      });
    },
    onError: handleError,
  });

  const deleteMutation = useMutation({
    mutationFn: (channelId: string) =>
      deleteCorpChannel(workspaceId ?? '', channelId),
    onSuccess: () => {
      setError(null);
      setNotice(t('settings.corp.disconnectedDone'));
      void queryClient.invalidateQueries({
        queryKey: corpChannelsQueryKey(workspaceId ?? ''),
      });
    },
    onError: handleError,
  });

  function handleSubmit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    setError(null);
    setNotice(null);
    setCreated(null);

    const parsed = connectCorpChannelSchema.safeParse({
      provider,
      name,
      botToken,
      apiBaseUrl,
      allowedChatIds,
    });

    if (!parsed.success || workspaceId === null) {
      setError(t('settings.corp.errors.invalid'));
      return;
    }

    connectMutation.mutate(parsed.data);
  }

  const channels = channelsQuery.data ?? [];

  return (
    <section className={SECTION_CLASSES}>
      <h2 className="font-display text-lg font-bold text-on-surface">
        {t('settings.corp.title')}
      </h2>
      <p className="mt-2 text-sm leading-relaxed text-on-surface-variant">
        {t('settings.corp.subtitle')}
      </p>

      <div role="radiogroup" aria-label={t('settings.corp.providerLabel')} className="mt-4 grid gap-2 sm:grid-cols-3">
        {PROVIDERS.map((item) => (
          <button
            key={item}
            type="button"
            role="radio"
            aria-checked={provider === item}
            onClick={() => setProvider(item)}
            className={`rounded-xl border px-3 py-2 text-left text-xs transition focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary ${
              provider === item
                ? 'border-primary bg-primary-container text-on-primary-container'
                : 'border-outline-variant text-on-surface-variant hover:border-primary/40'
            }`}
          >
            <span className="block font-semibold">
              {t(`settings.corp.providers.${item}.label`)}
            </span>
            <span className="mt-1 block text-[11px] opacity-80">
              {t(`settings.corp.providers.${item}.hint`)}
            </span>
          </button>
        ))}
      </div>

      {workspaceId === null && (
        <p role="status" className="mt-4 text-xs text-on-surface-variant">
          {t('settings.corp.noWorkspace')}
        </p>
      )}

      <form onSubmit={handleSubmit} className="mt-4">
        <div>
          <label htmlFor="corp-name" className="block text-sm font-medium">
            {t('settings.corp.nameLabel')}
          </label>
          <input
            id="corp-name"
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder={t('settings.corp.namePlaceholder')}
            disabled={workspaceId === null || connectMutation.isPending}
            className="mt-2 h-10 w-full rounded-lg border border-outline-variant bg-surface px-3 text-sm outline-none focus:border-primary focus:ring-4 focus:ring-primary/15"
          />
        </div>

        <SecretField
          id="corp-bot-token"
          name="botToken"
          label={t('settings.corp.tokenLabel')}
          hint={t(`settings.corp.providers.${provider}.tokenHint`)}
          value={botToken}
          onValueChange={setBotToken}
          visible={showToken}
          onVisibleChange={setShowToken}
          revealable
          revealLabel={t('settings.integrations.secret.show')}
          concealLabel={t('settings.integrations.secret.hide')}
          disabled={workspaceId === null || connectMutation.isPending}
          className="h-10 w-full rounded-lg border border-outline-variant bg-surface px-3 font-mono text-xs outline-none focus:border-primary focus:ring-4 focus:ring-primary/15"
        />

        {provider === 'vk_teams' && (
          <div className="mt-4">
            <label htmlFor="corp-api-base-url" className="block text-sm font-medium">
              {t('settings.corp.apiBaseUrlLabel')}
            </label>
            <input
              id="corp-api-base-url"
              value={apiBaseUrl}
              onChange={(event) => setApiBaseUrl(event.target.value)}
              placeholder={t('settings.corp.apiBaseUrlPlaceholder')}
              disabled={workspaceId === null || connectMutation.isPending}
              className="mt-2 h-10 w-full rounded-lg border border-outline-variant bg-surface px-3 font-mono text-xs outline-none focus:border-primary focus:ring-4 focus:ring-primary/15"
            />
            <p className="mt-1 text-xs text-on-surface-variant">
              {t('settings.corp.apiBaseUrlHint')}
            </p>
          </div>
        )}

        <div className="mt-4">
          <label htmlFor="corp-chat-ids" className="block text-sm font-medium">
            {t('settings.corp.chatIdsLabel')}
          </label>
          <textarea
            id="corp-chat-ids"
            value={allowedChatIds}
            onChange={(event) => setAllowedChatIds(event.target.value)}
            rows={2}
            placeholder={t('settings.corp.chatIdsPlaceholder')}
            disabled={workspaceId === null || connectMutation.isPending}
            className="mt-2 w-full rounded-lg border border-outline-variant bg-surface px-3 py-2 font-mono text-xs outline-none focus:border-primary focus:ring-4 focus:ring-primary/15"
          />
        </div>

        <button
          type="submit"
          disabled={workspaceId === null || connectMutation.isPending}
          className={`mt-4 ${BUTTON_CLASSES}`}
        >
          {t('settings.corp.connect')}
        </button>
      </form>

      {error !== null && (
        <p role="alert" className="mt-4 text-sm text-error">
          {error}
        </p>
      )}
      {notice !== null && (
        <p role="status" className="mt-4 text-sm text-tertiary">
          {notice}
        </p>
      )}

      {created !== null && (
        <div className="mt-4 rounded-xl border border-primary/30 bg-primary-container p-4 text-xs text-on-primary-container">
          <p className="font-semibold">{t('settings.corp.createdTitle')}</p>
          <p className="mt-1">{t('settings.corp.createdHint')}</p>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <code className="min-w-0 flex-1 truncate rounded bg-surface px-2 py-1">
              {created.webhookUrl}
            </code>
            <CopyButton
              value={created.webhookUrl}
              label={t('settings.corp.copyUrl')}
              onCopied={() => setNotice(t('settings.corp.copied'))}
            />
          </div>
          {created.webhookSecret !== undefined && (
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <code className="min-w-0 flex-1 truncate rounded bg-surface px-2 py-1">
                {created.webhookSecret}
              </code>
              <CopyButton
                value={created.webhookSecret}
                label={t('settings.corp.copySecret')}
                onCopied={() => setNotice(t('settings.corp.copiedSecret'))}
              />
            </div>
          )}
        </div>
      )}

      <div className="mt-6">
        <h3 className="text-sm font-semibold">
          {t('settings.corp.connectedTitle')}
        </h3>
        {channelsQuery.isLoading ? (
          <p role="status" className="mt-2 text-xs text-on-surface-variant">
            {t('settings.corp.loading')}
          </p>
        ) : channels.length === 0 ? (
          <p className="mt-2 rounded-xl border border-dashed border-outline px-4 py-6 text-center text-xs text-on-surface-variant">
            {t('settings.corp.empty')}
          </p>
        ) : (
          <ul className="mt-3 space-y-3">
            {channels.map((channel) => (
              <ChannelCard
                key={channel.id}
                channel={channel}
                onDelete={(item) => deleteMutation.mutate(item.id)}
                onCopied={() => setNotice(t('settings.corp.copied'))}
              />
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}

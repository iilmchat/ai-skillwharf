import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import {
  connectTelegramChannel,
  connectTelegramChannelSchema,
  deleteTelegramChannel,
  fetchTelegramChannels,
  getTelegramChannelsErrorKind,
  telegramChannelsQueryKey,
  type TelegramChannel,
} from '../lib/telegram-channels';
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

function ChannelCard({
  channel,
  onDelete,
  onCopied,
}: {
  channel: TelegramChannel;
  onDelete: (channel: TelegramChannel) => void;
  onCopied: () => void;
}) {
  const { t } = useTranslation();

  async function handleCopy(): Promise<void> {
    try {
      await navigator.clipboard.writeText(channel.webhookUrl);
      onCopied();
    } catch {
      // Кнопка лучшего эффекта: при недоступном Clipboard API URL виден текстом.
    }
  }

  return (
    <li className="rounded-xl border border-outline-variant bg-surface-container-high p-4">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="truncate text-sm font-semibold text-on-surface">
            {channel.botUsername ?? t('settings.telegram.unknownBot')}
          </p>
          <p className="mt-0.5 text-[11px] text-on-surface-variant">
            {channel.maskedToken}
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
              ? 'settings.telegram.active'
              : 'settings.telegram.inactive',
          )}
        </span>
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-2">
        <code className="min-w-0 flex-1 truncate rounded-lg bg-surface px-2 py-1 text-[11px] text-on-surface-variant">
          {channel.webhookUrl}
        </code>
        <button
          type="button"
          onClick={() => void handleCopy()}
          className="shrink-0 rounded-lg border border-outline px-2 py-1 text-[11px] font-medium text-on-surface-variant transition hover:bg-surface-container focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
        >
          {t('settings.telegram.copyWebhook')}
        </button>
        <button
          type="button"
          onClick={() => onDelete(channel)}
          className="shrink-0 rounded-lg border border-error/40 px-2 py-1 text-[11px] font-medium text-on-error transition hover:bg-error-container focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-error"
        >
          {t('settings.telegram.disconnect')}
        </button>
      </div>
      <p className="mt-2 text-[11px] text-on-surface-variant">
        {t('settings.telegram.allowedChats', {
          ids: channel.allowedChatIds.join(', ') || '—',
        })}
      </p>
    </li>
  );
}

/** Управление Telegram-ботами воркспейса (OMNI-39.1). */
export function TelegramChannelsSection() {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const accessToken = useAuthStore((state) => state.accessToken);
  const activeWorkspaceId = useWorkspaceStore(
    (state) => state.activeWorkspaceId,
  );
  const [token, setToken] = useState('');
  const [allowedChatIds, setAllowedChatIds] = useState('');
  const [showToken, setShowToken] = useState(false);
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
    queryKey: telegramChannelsQueryKey(workspaceId ?? ''),
    queryFn: () => fetchTelegramChannels(workspaceId ?? ''),
    enabled: workspaceId !== null,
    retry: false,
  });

  function handleError(cause: unknown): void {
    setError(
      t(`settings.telegram.errors.${getTelegramChannelsErrorKind(cause)}`),
    );
  }

  const connectMutation = useMutation({
    mutationFn: (payload: { botToken: string; allowedChatIds: string[] }) =>
      connectTelegramChannel(workspaceId ?? '', payload),
    onSuccess: () => {
      setToken('');
      setAllowedChatIds('');
      setError(null);
      setNotice(t('settings.telegram.connected'));
      void queryClient.invalidateQueries({
        queryKey: telegramChannelsQueryKey(workspaceId ?? ''),
      });
    },
    onError: handleError,
  });

  const deleteMutation = useMutation({
    mutationFn: (channelId: string) =>
      deleteTelegramChannel(workspaceId ?? '', channelId),
    onSuccess: () => {
      setError(null);
      setNotice(t('settings.telegram.disconnectedDone'));
      void queryClient.invalidateQueries({
        queryKey: telegramChannelsQueryKey(workspaceId ?? ''),
      });
    },
    onError: handleError,
  });

  function handleSubmit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    setError(null);
    setNotice(null);

    const parsed = connectTelegramChannelSchema.safeParse({
      botToken: token,
      allowedChatIds,
    });

    if (!parsed.success || workspaceId === null) {
      setError(t('settings.telegram.errors.invalid'));
      return;
    }

    connectMutation.mutate(parsed.data);
  }

  const channels = channelsQuery.data ?? [];

  return (
    <section className={SECTION_CLASSES}>
      <h2 className="font-display text-lg font-bold text-on-surface">
        {t('settings.telegram.title')}
      </h2>
      <p className="mt-2 text-sm leading-relaxed text-on-surface-variant">
        {t('settings.telegram.subtitle')}
      </p>

      <ol className="mt-4 list-decimal space-y-1 pl-5 text-xs leading-relaxed text-on-surface-variant">
        <li>{t('settings.telegram.steps.botfather')}</li>
        <li>{t('settings.telegram.steps.token')}</li>
        <li>{t('settings.telegram.steps.chatId')}</li>
      </ol>

      {workspaceId === null && (
        <p role="status" className="mt-4 text-xs text-on-surface-variant">
          {t('settings.telegram.noWorkspace')}
        </p>
      )}

      <form onSubmit={handleSubmit} className="mt-2">
        <SecretField
          id="telegram-bot-token"
          name="botToken"
          label={t('settings.telegram.tokenLabel')}
          hint={t('settings.telegram.tokenHint')}
          value={token}
          onValueChange={setToken}
          visible={showToken}
          onVisibleChange={setShowToken}
          revealable
          revealLabel={t('settings.integrations.secret.show')}
          concealLabel={t('settings.integrations.secret.hide')}
          disabled={workspaceId === null || connectMutation.isPending}
          className="h-10 w-full rounded-lg border border-outline-variant bg-surface px-3 font-mono text-xs text-on-surface outline-none transition focus:border-primary focus:ring-4 focus:ring-primary/15"
        />
        <div className="mt-4">
          <label
            htmlFor="telegram-chat-ids"
            className="block text-sm font-medium text-on-surface"
          >
            {t('settings.telegram.chatIdsLabel')}
          </label>
          <textarea
            id="telegram-chat-ids"
            value={allowedChatIds}
            onChange={(event) => setAllowedChatIds(event.target.value)}
            rows={2}
            placeholder={t('settings.telegram.chatIdsPlaceholder')}
            disabled={workspaceId === null || connectMutation.isPending}
            className="mt-2 w-full rounded-lg border border-outline-variant bg-surface px-3 py-2 font-mono text-xs text-on-surface outline-none transition placeholder:text-on-surface-variant/60 focus:border-primary focus:ring-4 focus:ring-primary/15"
          />
          <p className="mt-1 text-xs text-on-surface-variant">
            {t('settings.telegram.chatIdsHint')}
          </p>
        </div>
        <button
          type="submit"
          disabled={workspaceId === null || connectMutation.isPending}
          className={`mt-4 ${BUTTON_CLASSES}`}
        >
          {t('settings.telegram.connect')}
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

      <div className="mt-6">
        <h3 className="text-sm font-semibold text-on-surface">
          {t('settings.telegram.connectedTitle')}
        </h3>
        {channelsQuery.isLoading ? (
          <p role="status" className="mt-2 text-xs text-on-surface-variant">
            {t('settings.telegram.loading')}
          </p>
        ) : channels.length === 0 ? (
          <p className="mt-2 rounded-xl border border-dashed border-outline px-4 py-6 text-center text-xs text-on-surface-variant">
            {t('settings.telegram.empty')}
          </p>
        ) : (
          <ul className="mt-3 space-y-3">
            {channels.map((channel) => (
              <ChannelCard
                key={channel.id}
                channel={channel}
                onDelete={(item) => deleteMutation.mutate(item.id)}
                onCopied={() => setNotice(t('settings.telegram.copied'))}
              />
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}

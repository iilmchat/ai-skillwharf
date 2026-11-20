import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { Brand } from '../components/Brand';
import { usePendingApprovals } from '../hooks/usePendingApprovals';
import {
  fetchTelegramChannels,
  telegramChannelsQueryKey,
} from '../lib/telegram-channels';
import { pendingApprovalsQueryKey } from '../lib/pending-approvals';
import { getSharedSocket } from '../lib/socket';
import {
  fetchWorkspaces,
  resolveActiveWorkspace,
  workspaceQueryKeys,
} from '../lib/workspaces';
import { useAuthStore } from '../store/auth.store';
import { useOfficeStore } from '../store/office.store';
import { useWorkspaceStore } from '../store/workspace.store';

/** Минимальный тип встроенного WebApp — без внешней SDK-зависимости. */
interface TelegramWebApp {
  ready: () => void;
  expand?: () => void;
}

function getTelegramWebApp(): TelegramWebApp | null {
  const telegram = (
    window as Window & {
      Telegram?: { WebApp?: TelegramWebApp };
    }
  ).Telegram;

  return telegram?.WebApp ?? null;
}

const CARD_CLASSES =
  'rounded-2xl border border-outline-variant bg-surface-container p-4 shadow-sm';

const ACTION_CLASSES =
  'inline-flex min-h-12 flex-1 items-center justify-center rounded-xl px-4 text-sm font-semibold transition focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary disabled:cursor-not-allowed disabled:opacity-40';

function StatusDot({ status }: { status: string }) {
  const color =
    status === 'waiting_approval'
      ? 'bg-amber-500'
      : status === 'working'
        ? 'bg-emerald-500'
        : 'bg-outline';

  return <span aria-hidden="true" className={`size-2 rounded-full ${color}`} />;
}

/**
 * Компактный Telegram Mini App (OMNI-39.4): статус офиса, HITL-ожидания и
 * быстрые действия. Открывается внутри Telegram WebView без десктопного
 * сайдбара; для одобрений используется тот же socket-протокол, что и чат.
 */
export function TelegramMiniAppPage() {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const accessToken = useAuthStore((state) => state.accessToken);
  const activeWorkspaceId = useWorkspaceStore(
    (state) => state.activeWorkspaceId,
  );
  const lastEvent = useOfficeStore((state) => state.lastEvent);
  const handoffs = useOfficeStore((state) => state.handoffs);
  const [actionError, setActionError] = useState<string | null>(null);
  const pendingQuery = usePendingApprovals();

  useEffect(() => {
    const webApp = getTelegramWebApp();

    webApp?.ready();
    webApp?.expand?.();
  }, []);

  const workspacesQuery = useQuery({
    queryKey: workspaceQueryKeys.workspaces,
    queryFn: fetchWorkspaces,
    enabled: accessToken !== null,
    staleTime: 30_000,
  });
  const workspaceId =
    resolveActiveWorkspace(workspacesQuery.data ?? [], activeWorkspaceId)?.id ??
    null;
  const workspaceName =
    resolveActiveWorkspace(workspacesQuery.data ?? [], activeWorkspaceId)?.name ??
    null;

  const channelsQuery = useQuery({
    queryKey: telegramChannelsQueryKey(workspaceId ?? ''),
    queryFn: () => fetchTelegramChannels(workspaceId ?? ''),
    enabled: workspaceId !== null,
    retry: false,
  });

  const botUsername = channelsQuery.data?.find((item) => item.isActive)
    ?.botUsername;

  const approveMutation = useMutation({
    mutationFn: async ({
      conversationId,
      approved,
    }: {
      conversationId: string;
      approved: boolean;
    }): Promise<void> => {
      if (accessToken === null) {
        throw new Error('unauthorized');
      }

      const socket = getSharedSocket(accessToken);

      if (!socket.connected) {
        await new Promise<void>((resolve, reject) => {
          const timer = window.setTimeout(() => {
            socket.off('connect', handleConnect);
            reject(new Error('timeout'));
          }, 10_000);

          function handleConnect(): void {
            window.clearTimeout(timer);
            resolve();
          }

          socket.once('connect', handleConnect);
          socket.connect();
        });
      }

      await new Promise<void>((resolve, reject) => {
        const timer = window.setTimeout(() => reject(new Error('timeout')), 15_000);

        socket.emit(
          'approve_action',
          { conversationId, approved },
          () => {
            window.clearTimeout(timer);
            resolve();
          },
        );
      });
    },
    onSuccess: () => {
      setActionError(null);
      void queryClient.invalidateQueries({ queryKey: pendingApprovalsQueryKey });
    },
    onError: () => setActionError(t('tgApp.errors.actionFailed')),
  });

  const pending = pendingQuery.data?.items ?? [];

  return (
    <div className="min-h-svh bg-surface text-on-surface">
      <header className="flex items-center justify-between gap-3 border-b border-outline-variant px-4 py-3">
        <Brand compact />
        <div className="text-right">
          <p className="text-xs font-semibold">{t('tgApp.title')}</p>
          <p className="text-[11px] text-on-surface-variant">
            {workspaceName ?? t('tgApp.defaultWorkspace')}
          </p>
        </div>
      </header>

      <main className="mx-auto w-full max-w-md space-y-4 px-4 py-5">
        <section aria-label={t('tgApp.status.title')} className={CARD_CLASSES}>
          <h2 className="text-sm font-semibold">{t('tgApp.status.title')}</h2>
          <div className="mt-3 flex items-center gap-2">
            <StatusDot status={lastEvent?.status ?? 'idle'} />
            <p className="text-sm text-on-surface">
              {lastEvent === null
                ? t('tgApp.status.idle')
                : t(`tgApp.status.${lastEvent.status}`)}
            </p>
          </div>
          {lastEvent !== null && (
            <p className="mt-1 truncate text-xs text-on-surface-variant">
              {lastEvent.task}
            </p>
          )}
          <div className="mt-4 grid grid-cols-2 gap-2 text-center">
            <div className="rounded-xl bg-surface-container-high p-2">
              <p className="text-lg font-bold tabular-nums">{pending.length}</p>
              <p className="text-[10px] text-on-surface-variant">
                {t('tgApp.metrics.pending')}
              </p>
            </div>
            <div className="rounded-xl bg-surface-container-high p-2">
              <p className="text-lg font-bold tabular-nums">{handoffs.length}</p>
              <p className="text-[10px] text-on-surface-variant">
                {t('tgApp.metrics.handoffs')}
              </p>
            </div>
          </div>
        </section>

        <section aria-label={t('tgApp.hitl.title')} className={CARD_CLASSES}>
          <h2 className="text-sm font-semibold">{t('tgApp.hitl.title')}</h2>
          {accessToken === null ? (
            <p className="mt-3 text-xs text-on-surface-variant">
              {t('tgApp.loginRequired')}
            </p>
          ) : pendingQuery.isError ? (
            <p role="alert" className="mt-3 text-xs text-error">
              {t('tgApp.errors.listFailed')}
            </p>
          ) : pending.length === 0 ? (
            <p className="mt-3 text-xs text-on-surface-variant">
              {t('tgApp.hitl.empty')}
            </p>
          ) : (
            <ul className="mt-3 space-y-3">
              {pending.map((item) => (
                <li key={item.conversationId} className="rounded-xl bg-surface p-3">
                  <p className="text-sm font-medium">
                    {t('tgApp.hitl.reason', {
                      reason: t(`chat.approval.${item.reason === 'payment' ? 'paymentTitle' : 'title'}`),
                    })}
                  </p>
                  <p className="mt-1 truncate text-[11px] text-on-surface-variant">
                    {item.tools.join(', ') || '—'}
                  </p>
                  <div className="mt-3 flex gap-2">
                    <button
                      type="button"
                      disabled={approveMutation.isPending}
                      onClick={() =>
                        approveMutation.mutate({
                          conversationId: item.conversationId,
                          approved: true,
                        })
                      }
                      className={`${ACTION_CLASSES} bg-primary text-on-primary`}
                    >
                      {t('tgApp.hitl.approve')}
                    </button>
                    <button
                      type="button"
                      disabled={approveMutation.isPending}
                      onClick={() =>
                        approveMutation.mutate({
                          conversationId: item.conversationId,
                          approved: false,
                        })
                      }
                      className={`${ACTION_CLASSES} border border-error/40 bg-error-container text-on-error-container`}
                    >
                      {t('tgApp.hitl.reject')}
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          )}
          {actionError !== null && (
            <p role="alert" className="mt-3 text-xs text-error">
              {actionError}
            </p>
          )}
        </section>

        <section className="space-y-2">
          {botUsername !== undefined && botUsername !== null && (
            <a
              href={`https://t.me/${botUsername.replace(/^@/, '')}`}
              target="_blank"
              rel="noopener noreferrer"
              className={`${ACTION_CLASSES} w-full bg-primary text-on-primary`}
            >
              {t('tgApp.openBot')}
            </a>
          )}
          <Link
            to="/app/chat"
            className={`${ACTION_CLASSES} w-full border border-outline bg-surface-container text-on-surface-variant`}
          >
            {t('tgApp.openWeb')}
          </Link>
        </section>
      </main>
    </div>
  );
}

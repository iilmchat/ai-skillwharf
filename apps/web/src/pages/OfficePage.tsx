import {
  AnimatePresence,
  motion,
  MotionConfig,
  useReducedMotion,
  type Variants,
} from 'framer-motion';
import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useSearchParams } from 'react-router-dom';
import type { Socket } from 'socket.io-client';
import { Brand } from '../components/Brand';
import { IntegrationIcon } from '../components/IntegrationIcon';
import { LanguageSwitcher } from '../components/LanguageSwitcher';
import { PendingTtl } from '../components/PendingTtl';
import { ThemeToggle } from '../components/ThemeToggle';
import { useIntegrations } from '../hooks/useIntegrations';
import { usePendingApprovals } from '../hooks/usePendingApprovals';
import {
  DEFAULT_OFFICE_AGENT_ID,
  parseOfficeEvent,
  readConversationId,
  type OfficeAgentStatus,
  type OfficeApprovalReason,
} from '../lib/office-events';
import {
  getActiveIntegrationChannels,
  type IntegrationProvider,
} from '../lib/integrations';
import { pendingApprovalsQueryKey } from '../lib/pending-approvals';
import { getSharedSocket } from '../lib/socket';
import { useAuthStore } from '../store/auth.store';
import { useOfficeStore } from '../store/office.store';

interface OfficeAgent {
  id: string;
  name: string;
  roleKey: string;
  taskKey: string;
  /** Задача, пришедшая с бэкенда; важнее локализованного mock-текста. */
  task?: string;
  status: OfficeAgentStatus;
  /** Причина waiting_approval: оплата или обычное одобрение. */
  reason?: OfficeApprovalReason;
  /** TTL ожидания из `GET /api/v1/chat/pending`; нет у старого API. */
  expiresAt?: string;
  desk: string;
  live?: boolean;
}

interface StatusMeta {
  icon: string;
  labelKey: string;
  card: string;
  badge: string;
  dot: string;
  iconTile: string;
}

const INITIAL_AGENTS: readonly OfficeAgent[] = [
  {
    id: DEFAULT_OFFICE_AGENT_ID,
    name: 'Nova',
    roleKey: 'office.agents.nova.role',
    taskKey: 'office.agents.nova.task',
    status: 'idle',
    desk: '01',
  },
  {
    id: 'miles',
    name: 'Miles',
    roleKey: 'office.agents.miles.role',
    taskKey: 'office.agents.miles.task',
    status: 'working',
    desk: '02',
  },
  {
    id: 'iris',
    name: 'Iris',
    roleKey: 'office.agents.iris.role',
    taskKey: 'office.agents.iris.task',
    status: 'idle',
    desk: '03',
  },
  {
    id: 'leo',
    name: 'Leo',
    roleKey: 'office.agents.leo.role',
    taskKey: 'office.agents.leo.task',
    status: 'waiting_approval',
    reason: 'approval',
    desk: '04',
  },
  {
    id: 'ava',
    name: 'Ava',
    roleKey: 'office.agents.ava.role',
    taskKey: 'office.agents.ava.task',
    status: 'idle',
    desk: '05',
  },
  {
    id: 'kai',
    name: 'Kai',
    roleKey: 'office.agents.kai.role',
    taskKey: 'office.agents.kai.task',
    status: 'waiting_approval',
    reason: 'payment',
    desk: '06',
  },
];

const STATUS_ORDER: readonly OfficeAgentStatus[] = [
  'idle',
  'working',
  'waiting_approval',
];

const STATUS_META: Record<OfficeAgentStatus, StatusMeta> = {
  idle: {
    icon: '☕',
    labelKey: 'office.status.idle',
    card: 'border-outline-variant bg-surface-container hover:border-primary/25',
    badge: 'bg-surface-container-high text-on-surface-variant',
    dot: 'bg-on-surface-variant/50',
    iconTile: 'bg-surface-container-high text-on-surface-variant',
  },
  working: {
    icon: '💻',
    labelKey: 'office.status.working',
    card: 'border-primary/30 bg-surface-container hover:border-primary/50',
    badge: 'bg-primary-container text-on-primary-container',
    dot: 'bg-primary',
    iconTile: 'bg-primary-container text-on-primary-container',
  },
  waiting_approval: {
    icon: '✋',
    labelKey: 'office.status.waiting_approval',
    card: 'border-warning/50 bg-warning-container/40 hover:border-warning/70',
    badge: 'bg-warning-container text-on-warning-container',
    dot: 'bg-warning',
    iconTile: 'bg-warning-container text-on-warning-container',
  },
};

/**
 * Накладывает событие бэкенда на карточки. Неизвестный agentId (пока MVP
 * присылает `default`) обновляет первого агента, а не создаёт фантома.
 */
interface LiveAgentUpdate {
  agentId: string;
  status: OfficeAgentStatus;
  task: string;
  reason?: OfficeApprovalReason;
}

function applyLiveEvent(
  agents: OfficeAgent[],
  event: LiveAgentUpdate,
): OfficeAgent[] {
  const targetId = agents.some((agent) => agent.id === event.agentId)
    ? event.agentId
    : DEFAULT_OFFICE_AGENT_ID;

  return agents.map((agent) =>
    agent.id === targetId
      ? {
          ...agent,
          status: event.status,
          task: event.task,
          reason:
            event.status === 'waiting_approval' ? event.reason : undefined,
          live: true,
        }
      : agent,
  );
}

const introVariants: Variants = {
  hidden: {},
  show: {
    transition: { staggerChildren: 0.07, delayChildren: 0.04 },
  },
};

const fadeUpVariants: Variants = {
  hidden: { opacity: 0, y: 18 },
  show: {
    opacity: 1,
    y: 0,
    transition: { duration: 0.45, ease: 'easeOut' },
  },
};

const gridVariants: Variants = {
  hidden: {},
  show: {
    transition: { staggerChildren: 0.06, delayChildren: 0.1 },
  },
};

const deskVariants: Variants = {
  hidden: { opacity: 0, y: 18 },
  show: {
    opacity: 1,
    y: 0,
    transition: { duration: 0.4, ease: 'easeOut' },
  },
};

/** Активные каналы интеграций: Telegram/Google видны во всех карточках. */
function OfficeChannelIcons({
  channels,
}: {
  channels: readonly IntegrationProvider[];
}) {
  const { t } = useTranslation();

  if (channels.length === 0) {
    return null;
  }

  return (
    <span
      role="group"
      aria-label={t('office.channels.label')}
      className="inline-flex items-center gap-1"
    >
      {channels.map((channel) => (
        <span
          key={channel}
          role="img"
          aria-label={t(`office.channels.${channel}`)}
          title={t(`office.channels.${channel}`)}
          className="grid size-7 place-items-center rounded-full border border-outline-variant bg-surface text-on-surface-variant"
        >
          <IntegrationIcon provider={channel} className="size-3.5" />
        </span>
      ))}
    </span>
  );
}

function AgentDesk({
  agent,
  isSelected,
  channels,
  onSelect,
}: {
  agent: OfficeAgent;
  isSelected: boolean;
  channels: readonly IntegrationProvider[];
  onSelect: (agentId: string) => void;
}) {
  const { t } = useTranslation();
  const shouldReduceMotion = useReducedMotion();
  const meta = STATUS_META[agent.status];
  const isWorking = agent.status === 'working';
  const isWaiting = agent.status === 'waiting_approval';
  const isPayment = isWaiting && agent.reason === 'payment';

  return (
    <motion.li variants={deskVariants} className="h-full">
      <motion.article
        layout
        whileHover={shouldReduceMotion === true ? undefined : { y: -4 }}
        className={`group relative flex h-full flex-col rounded-2xl border p-5 shadow-sm transition-colors ${meta.card} ${
          isWaiting ? 'office-await' : ''
        } ${isSelected ? 'ring-2 ring-primary/60 ring-offset-2 ring-offset-surface' : ''}`}
      >
        <button
          type="button"
          id={`office-agent-${agent.id}`}
          onClick={() => onSelect(agent.id)}
          aria-haspopup="dialog"
          aria-label={t('office.openAgent', { name: agent.name })}
          className="absolute inset-0 z-10 rounded-2xl focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
        />

        <div className="pointer-events-none relative flex h-full flex-col">
          <div className="flex items-start justify-between gap-3">
            <span
              className={`relative grid size-12 shrink-0 place-items-center rounded-2xl text-2xl ${meta.iconTile}`}
            >
              <span aria-hidden="true">{meta.icon}</span>
              {isWorking && (
                <motion.span
                  aria-hidden="true"
                  className="pointer-events-none absolute inset-0 rounded-2xl border-2 border-primary/40"
                  animate={
                    shouldReduceMotion === true
                      ? undefined
                      : { scale: [1, 1.18, 1], opacity: [0.7, 0, 0.7] }
                  }
                  transition={{
                    duration: 2.4,
                    repeat: Infinity,
                    ease: 'easeInOut',
                  }}
                />
              )}
              {isPayment && (
                <span
                  aria-hidden="true"
                  className="absolute -bottom-1 -right-1 grid size-5 place-items-center rounded-full bg-warning-container text-[11px] shadow ring-2 ring-surface"
                >
                  💳
                </span>
              )}
            </span>

            <span
              className={`inline-flex shrink-0 items-center gap-1.5 rounded-full px-2.5 py-1 text-[11px] font-semibold ${meta.badge}`}
            >
              <span
                aria-hidden="true"
                className={`size-1.5 rounded-full ${meta.dot} ${
                  isWorking ? 'animate-pulse' : ''
                }`}
              />
              {isPayment
                ? t('office.status.waiting_payment')
                : t(meta.labelKey)}
            </span>
          </div>

          <div className="mt-4 flex flex-wrap items-center gap-2">
            <h3 className="font-display text-lg font-bold text-on-surface">
              {agent.name}
            </h3>
            {agent.live && (
              <span className="inline-flex items-center gap-1 rounded-full border border-success/30 bg-success/10 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-success">
                <span
                  aria-hidden="true"
                  className="size-1 rounded-full bg-success"
                />
                {t('office.live')}
              </span>
            )}
            <OfficeChannelIcons channels={channels} />
          </div>
          <p className="mt-0.5 text-sm text-on-surface-variant">
            {t(agent.roleKey)}
          </p>

          <div className="mt-4 rounded-xl border border-outline-variant/70 bg-surface/60 p-3">
            <p className="text-[11px] font-medium uppercase tracking-wider text-on-surface-variant">
              {t('office.currentTask')}
            </p>
            <p className="mt-1 line-clamp-2 text-sm leading-snug text-on-surface">
              {agent.task ?? t(agent.taskKey)}
              {isWorking && (
                <span
                  aria-hidden="true"
                  className="office-cursor ml-0.5 inline-block h-3.5 w-0.5 translate-y-0.5 bg-primary"
                />
              )}
            </p>
            {isWaiting && agent.expiresAt !== undefined && (
              <PendingTtl expiresAt={agent.expiresAt} className="mt-2" />
            )}
          </div>

          <div className="mt-auto flex items-center justify-between gap-2 pt-4 text-xs text-on-surface-variant">
            <span>{t('office.desk', { number: agent.desk })}</span>
            <span className="inline-flex items-center gap-1 font-medium text-primary opacity-0 transition group-hover:opacity-100 group-focus-within:opacity-100">
              {t('office.open')}
              <svg
                aria-hidden="true"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.8"
                strokeLinecap="round"
                strokeLinejoin="round"
                className="size-3.5"
              >
                <path d="M5 12h14M13 6l6 6-6 6" />
              </svg>
            </span>
          </div>
        </div>
      </motion.article>
    </motion.li>
  );
}

function AgentSidebar({
  agent,
  channels,
  isApproved,
  conversationId,
  onApprove,
  onClose,
}: {
  agent: OfficeAgent;
  channels: readonly IntegrationProvider[];
  isApproved: boolean;
  conversationId: string | null;
  onApprove: (agentId: string) => void;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const meta = STATUS_META[agent.status];
  const isPayment =
    agent.status === 'waiting_approval' && agent.reason === 'payment';
  const statusLabel = isPayment
    ? t('office.status.waiting_payment')
    : t(meta.labelKey);

  useEffect(() => {
    closeButtonRef.current?.focus();
  }, [agent.id]);

  return (
    <motion.aside
      role="dialog"
      aria-modal="true"
      aria-labelledby="office-agent-title"
      className="fixed inset-y-0 right-0 z-50 flex w-full max-w-md flex-col border-l border-outline-variant bg-surface shadow-2xl"
      initial={{ x: '100%' }}
      animate={{ x: 0 }}
      exit={{ x: '100%' }}
      transition={{ type: 'spring', stiffness: 320, damping: 34 }}
    >
      <div className="flex items-start justify-between gap-4 border-b border-outline-variant p-5">
        <div className="min-w-0">
          <p className="text-xs font-semibold uppercase tracking-[0.16em] text-on-surface-variant">
            {t('office.sidebar.eyebrow')}
          </p>
          <h2
            id="office-agent-title"
            className="mt-1 truncate font-display text-2xl font-bold tracking-tight text-on-surface"
          >
            {agent.name}
          </h2>
          <p className="mt-1 text-sm text-on-surface-variant">
            {t(agent.roleKey)}
          </p>
        </div>

        <button
          ref={closeButtonRef}
          type="button"
          onClick={onClose}
          aria-label={t('office.sidebar.close')}
          title={t('office.sidebar.close')}
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
        <div className="flex items-center gap-4">
          <span
            className={`grid size-16 shrink-0 place-items-center rounded-2xl text-3xl ${meta.iconTile}`}
          >
            <span aria-hidden="true">{meta.icon}</span>
          </span>
          <div>
            <span
              className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-semibold ${meta.badge}`}
            >
              <span
                aria-hidden="true"
                className={`size-1.5 rounded-full ${meta.dot}`}
              />
              {statusLabel}
            </span>
            <p className="mt-2 text-xs text-on-surface-variant">
              {t('office.desk', { number: agent.desk })}
            </p>
          </div>
        </div>

        <dl className="mt-6 grid gap-4">
          <div>
            <dt className="text-xs font-medium uppercase tracking-wider text-on-surface-variant">
              {t('office.sidebar.role')}
            </dt>
            <dd className="mt-1 text-sm font-medium text-on-surface">
              {t(agent.roleKey)}
            </dd>
          </div>
          <div>
            <dt className="text-xs font-medium uppercase tracking-wider text-on-surface-variant">
              {t('office.sidebar.status')}
            </dt>
            <dd className="mt-1 text-sm font-medium text-on-surface">
              {statusLabel}
            </dd>
          </div>
          {channels.length > 0 && (
            <div>
              <dt className="text-xs font-medium uppercase tracking-wider text-on-surface-variant">
                {t('office.sidebar.channels')}
              </dt>
              <dd className="mt-1 flex flex-wrap items-center gap-2">
                {channels.map((channel) => (
                  <span
                    key={channel}
                    className="inline-flex items-center gap-1.5 rounded-full border border-outline-variant bg-surface-container px-2.5 py-1 text-xs font-medium text-on-surface"
                  >
                    <IntegrationIcon provider={channel} className="size-3.5" />
                    {t(`office.channels.${channel}`)}
                  </span>
                ))}
              </dd>
            </div>
          )}
          <div>
            <dt className="text-xs font-medium uppercase tracking-wider text-on-surface-variant">
              {t('office.sidebar.task')}
            </dt>
            <dd className="mt-1 rounded-xl border border-outline-variant bg-surface-container p-3 text-sm leading-relaxed text-on-surface">
              {agent.task ?? t(agent.taskKey)}
            </dd>
          </div>
          {conversationId !== null && (
            <div>
              <dt className="text-xs font-medium uppercase tracking-wider text-on-surface-variant">
                {t('office.sidebar.conversation')}
              </dt>
              <dd className="mt-1 break-all font-mono text-xs leading-relaxed text-on-surface-variant">
                {conversationId}
              </dd>
            </div>
          )}
        </dl>

        {agent.status === 'waiting_approval' && (
          <div className="mt-4 flex items-start gap-2 rounded-xl border border-warning/30 bg-warning-container/40 p-3">
            <span aria-hidden="true" className="text-lg leading-none">
              {isPayment ? '💳' : '✋'}
            </span>
            <div>
              <p className="text-sm font-semibold text-on-warning-container">
                {isPayment
                  ? t('office.payment.title')
                  : t('office.approval.title')}
              </p>
              <p className="mt-0.5 text-xs leading-relaxed text-on-warning-container">
                {isPayment
                  ? t('office.payment.body')
                  : t('office.approval.body')}
              </p>
              {agent.expiresAt !== undefined && (
                <PendingTtl expiresAt={agent.expiresAt} className="mt-2" />
              )}
            </div>
          </div>
        )}

        {isApproved && (
          <div
            role="status"
            className="mt-4 flex items-start gap-2 rounded-xl border border-success/30 bg-success/10 px-3 py-2.5 text-sm leading-relaxed text-success"
          >
            <svg
              aria-hidden="true"
              viewBox="0 0 20 20"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.7"
              strokeLinecap="round"
              strokeLinejoin="round"
              className="mt-0.5 size-4 shrink-0"
            >
              <path d="m4 10.5 3.5 3.5L16 5.5" />
            </svg>
            {t('office.sidebar.approved')}
          </div>
        )}

        <p className="mt-6 text-xs leading-relaxed text-on-surface-variant">
          {conversationId === null
            ? t('office.sidebar.mockHint')
            : t('office.sidebar.liveHint')}
        </p>
      </div>

      {agent.status === 'waiting_approval' && (
        <div className="border-t border-outline-variant p-5">
          <button
            type="button"
            onClick={() => onApprove(agent.id)}
            className="inline-flex w-full items-center justify-center gap-2 rounded-xl bg-primary px-4 py-3 text-sm font-semibold text-on-primary shadow-lg shadow-primary/25 transition hover:brightness-95 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary active:brightness-95"
          >
            <span aria-hidden="true">✋</span>
            {t('office.sidebar.approve')}
          </button>
        </div>
      )}
    </motion.aside>
  );
}

export function OfficePage() {
  const { t } = useTranslation();
  const accessToken = useAuthStore((state) => state.accessToken);
  const isAuthenticated = accessToken !== null;
  const [searchParams] = useSearchParams();
  const queryConversationId = searchParams.get('conversationId');
  const [agents, setAgents] = useState<OfficeAgent[]>(() => {
    const initial = INITIAL_AGENTS.map((agent) => ({ ...agent }));
    const lastEvent = useOfficeStore.getState().lastEvent;
    const activeConversationId = useOfficeStore.getState().conversationId;

    if (lastEvent === null) {
      return initial;
    }

    const expectedConversation =
      queryConversationId ?? activeConversationId ?? null;

    if (
      lastEvent.conversationId !== null &&
      expectedConversation !== null &&
      lastEvent.conversationId !== expectedConversation
    ) {
      return initial;
    }

    return applyLiveEvent(initial, lastEvent);
  });
  const [selectedAgentId, setSelectedAgentId] = useState<string | null>(null);
  const [approvedAgentId, setApprovedAgentId] = useState<string | null>(null);
  const [socket, setSocket] = useState<Socket | null>(null);
  const [isLive, setIsLive] = useState(false);

  const conversationId = useOfficeStore((state) => state.conversationId);
  const queryClient = useQueryClient();
  const pendingQuery = usePendingApprovals();
  const integrationsQuery = useIntegrations();
  const channels = isAuthenticated
    ? getActiveIntegrationChannels(integrationsQuery.data)
    : [];
  const pendingApprovals = useMemo(
    () => pendingQuery.data?.items ?? [],
    [pendingQuery.data],
  );

  // Для текущего диалога TTL берём из REST: событие `office_event` его не
  // содержит, а старый API может не присылать `expiresAt` вовсе.
  const displayAgents = useMemo(() => {
    const activePending = pendingApprovals.find(
      (item) => item.conversationId === conversationId,
    );
    const expiresAt = activePending?.expiresAt;

    if (expiresAt === undefined) {
      return agents;
    }

    return agents.map((agent) =>
      agent.id === DEFAULT_OFFICE_AGENT_ID &&
      agent.status === 'waiting_approval'
        ? { ...agent, expiresAt }
        : agent,
    );
  }, [agents, conversationId, pendingApprovals]);

  const selectedAgent =
    displayAgents.find((agent) => agent.id === selectedAgentId) ?? null;

  useEffect(() => {
    // Сокет — внешняя система: синхронизируем ссылку на неё с auth-состоянием.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setSocket(accessToken === null ? null : getSharedSocket(accessToken));
  }, [accessToken]);

  // Ссылка из чата передаёт диалог, чтобы офис показывал именно его события.
  useEffect(() => {
    if (queryConversationId !== null && queryConversationId !== '') {
      useOfficeStore.getState().setConversationId(queryConversationId);
    }
  }, [queryConversationId]);

  useEffect(() => {
    if (socket === null) {
      return;
    }

    const updateLive = () => setIsLive(socket.connected);

    updateLive();

    if (!socket.connected) {
      socket.connect();
    }

    const handleOfficeEvent = (payload: unknown) => {
      const event = parseOfficeEvent(payload);

      if (event === null) {
        return;
      }

      const activeConversationId = useOfficeStore.getState().conversationId;

      if (
        event.conversationId !== undefined &&
        activeConversationId !== null &&
        event.conversationId !== activeConversationId
      ) {
        return;
      }

      setAgents((current) => applyLiveEvent(current, event));

      // Агент больше не ждёт решения — список ожиданий устарел.
      if (event.status !== 'waiting_approval') {
        void queryClient.invalidateQueries({
          queryKey: pendingApprovalsQueryKey,
        });
      }
    };

    // Завершение ответа — единственный сигнал, что агент освободился.
    const handleStreamEnd = (payload: unknown) => {
      const activeConversationId = useOfficeStore.getState().conversationId;
      const eventConversationId = readConversationId(payload);

      if (
        eventConversationId !== null &&
        activeConversationId !== null &&
        eventConversationId !== activeConversationId
      ) {
        return;
      }

      const finishedEvent = {
        agentId: DEFAULT_OFFICE_AGENT_ID,
        status: 'idle' as const,
        task: t('office.tasks.finished'),
      };

      setAgents((current) => applyLiveEvent(current, finishedEvent));
    };

    socket.on('connect', updateLive);
    socket.on('disconnect', updateLive);
    socket.on('office_event', handleOfficeEvent);
    socket.on('stream_end', handleStreamEnd);

    return () => {
      socket.off('connect', updateLive);
      socket.off('disconnect', updateLive);
      socket.off('office_event', handleOfficeEvent);
      socket.off('stream_end', handleStreamEnd);
    };
  }, [socket, t, queryClient]);

  useEffect(() => {
    if (selectedAgentId === null) {
      return;
    }

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setSelectedAgentId(null);
        setApprovedAgentId(null);
      }
    };

    document.addEventListener('keydown', handleKeyDown);

    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [selectedAgentId]);

  useEffect(() => {
    if (selectedAgentId === null) {
      return;
    }

    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';

    return () => {
      document.body.style.overflow = previousOverflow;
      document
        .getElementById(`office-agent-${selectedAgentId}`)
        ?.focus();
    };
  }, [selectedAgentId]);

  function handleSelect(agentId: string) {
    setSelectedAgentId(agentId);
    setApprovedAgentId(null);
  }

  function handleApprove(agentId: string) {
    if (socket !== null && socket.connected && conversationId !== null) {
      socket.emit('approve_action', {
        agentId,
        conversationId,
        approved: true,
      });
    }

    // Оптимистичный отклик: бэкенд подтвердит его событием resuming.
    setAgents((current) =>
      current.map((agent) =>
        agent.id === agentId
          ? {
              ...agent,
              status: 'working',
              task: t('office.tasks.approved'),
              live: true,
            }
          : agent,
      ),
    );
    setApprovedAgentId(agentId);
    // Ожидание закрыто оптимистично; список ожиданий обновим с сервера.
    void queryClient.invalidateQueries({
      queryKey: pendingApprovalsQueryKey,
    });
  }

  function closeSidebar() {
    setSelectedAgentId(null);
    setApprovedAgentId(null);
  }

  return (
    <MotionConfig reducedMotion="user">
      <div className="min-h-svh bg-surface text-on-surface">
        <header className="sticky top-0 z-30 border-b border-outline-variant/70 bg-surface/85 backdrop-blur-xl">
          <div className="mx-auto flex h-16 max-w-7xl items-center justify-between gap-3 px-4 sm:px-6">
            <div className="flex min-w-0 items-center gap-3">
              <Link
                to="/"
                aria-label="SkillWharf"
                className="rounded-lg focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
              >
                <span className="sm:hidden">
                  <Brand compact />
                </span>
                <span className="hidden sm:block">
                  <Brand />
                </span>
              </Link>
              <span
                className={`hidden items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] font-semibold sm:inline-flex ${
                  isLive
                    ? 'border-success/30 bg-success/10 text-success'
                    : 'border-primary/30 bg-primary-container text-on-primary-container'
                }`}
              >
                <span
                  aria-hidden="true"
                  className={`size-1.5 rounded-full ${
                    isLive ? 'animate-pulse bg-success' : 'bg-primary'
                  }`}
                />
                {isLive ? t('office.liveBadge') : t('office.mockBadge')}
              </span>
            </div>

            <div className="flex shrink-0 items-center gap-2">
              <Link
                to="/"
                className="hidden rounded-lg px-2 py-1 text-sm font-medium text-on-surface-variant transition hover:text-on-surface focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary md:inline-flex"
              >
                {t('office.backHome')}
              </Link>
              <LanguageSwitcher />
              <ThemeToggle />
              <Link
                to={isAuthenticated ? '/app/chat' : '/login'}
                className="inline-flex items-center justify-center rounded-xl bg-primary px-3.5 py-2 text-sm font-semibold text-on-primary shadow-lg shadow-primary/20 transition hover:brightness-95 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
              >
                {isAuthenticated ? t('office.backToChat') : t('office.login')}
              </Link>
            </div>
          </div>
        </header>

        <main className="relative overflow-hidden">
          <div
            aria-hidden="true"
            className="brand-grid pointer-events-none absolute inset-x-0 top-0 h-[32rem]"
          />
          <div
            aria-hidden="true"
            className="pointer-events-none absolute -top-24 left-1/2 h-80 w-[42rem] -translate-x-1/2 rounded-full bg-primary/10 blur-3xl"
          />

          <div className="relative mx-auto w-full max-w-7xl px-4 py-10 sm:px-6 lg:py-14">
            <motion.div
              initial="hidden"
              animate="show"
              variants={introVariants}
              className="max-w-3xl"
            >
              <motion.p
                variants={fadeUpVariants}
                className="inline-flex items-center gap-2 rounded-full border border-tertiary/30 bg-tertiary-container px-3 py-1 text-xs font-medium text-on-tertiary-container"
              >
                <span
                  aria-hidden="true"
                  className="size-1.5 animate-pulse rounded-full bg-tertiary"
                />
                {t('office.eyebrow')}
              </motion.p>

              <motion.h1
                variants={fadeUpVariants}
                className="mt-4 font-display text-4xl font-bold tracking-tight text-on-surface sm:text-5xl"
              >
                {t('office.title')}
              </motion.h1>

              <motion.p
                variants={fadeUpVariants}
                className="mt-3 max-w-2xl text-base leading-relaxed text-on-surface-variant"
              >
                {t('office.subtitle')}
              </motion.p>

              <motion.ul
                variants={fadeUpVariants}
                aria-label={t('office.legendLabel')}
                className="mt-6 flex flex-wrap gap-2"
              >
                {STATUS_ORDER.map((status) => {
                  const meta = STATUS_META[status];

                  return (
                    <li
                      key={status}
                      className={`inline-flex items-center gap-1.5 rounded-full px-3 py-1.5 text-xs font-medium ${meta.badge}`}
                    >
                      <span aria-hidden="true">{meta.icon}</span>
                      {t(meta.labelKey)}
                    </li>
                  );
                })}
              </motion.ul>
            </motion.div>

            {isAuthenticated && pendingApprovals.length > 0 && (
              <section
                aria-labelledby="office-pending-title"
                className="mt-8 rounded-2xl border border-warning/40 bg-warning-container/30 p-5"
              >
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0 max-w-xl">
                    <h2
                      id="office-pending-title"
                      className="font-display text-lg font-bold text-on-surface"
                    >
                      {t('office.pending.title')}
                    </h2>
                    <p className="mt-1 text-sm leading-relaxed text-on-surface-variant">
                      {t('office.pending.description')}
                    </p>
                  </div>
                  <span className="inline-flex items-center rounded-full border border-warning/40 bg-surface px-3 py-1 text-sm font-semibold text-on-warning-container">
                    {pendingApprovals.length}
                    <span className="sr-only">
                      {t('office.pending.countLabel')}
                    </span>
                  </span>
                </div>

                <ul className="mt-4 space-y-2">
                  {pendingApprovals.map((item) => (
                    <li
                      key={item.conversationId}
                      className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-warning/25 bg-surface/70 px-4 py-3"
                    >
                      <div className="min-w-0">
                        <p className="text-sm font-semibold text-on-surface">
                          {item.reason === 'payment'
                            ? t('office.pending.payment')
                            : t('office.pending.approval')}
                        </p>
                        {item.tools.length > 0 && (
                          <p className="mt-0.5 break-words text-xs text-on-surface-variant">
                            {t('office.pending.tools', {
                              tools: item.tools.join(', '),
                            })}
                          </p>
                        )}
                      </div>
                      <PendingTtl expiresAt={item.expiresAt} />
                    </li>
                  ))}
                </ul>
              </section>
            )}

            <motion.ul
              initial="hidden"
              animate="show"
              variants={gridVariants}
              className="mt-8 grid gap-4 sm:grid-cols-2 xl:grid-cols-3"
            >
              {displayAgents.map((agent) => (
                <AgentDesk
                  key={agent.id}
                  agent={agent}
                  channels={channels}
                  isSelected={agent.id === selectedAgentId}
                  onSelect={handleSelect}
                />
              ))}
            </motion.ul>

            <p className="mt-6 flex items-start gap-2 text-xs leading-relaxed text-on-surface-variant">
              <span
                aria-hidden="true"
                className={`mt-1 size-1.5 shrink-0 rounded-full ${
                  isLive ? 'bg-success' : 'bg-tertiary'
                }`}
              />
              {isAuthenticated
                ? t('office.liveNote')
                : t('office.mockNote')}
            </p>
          </div>
        </main>

        <AnimatePresence>
          {selectedAgent !== null && (
            <>
              <motion.div
                key="office-backdrop"
                aria-hidden="true"
                className="fixed inset-0 z-40 bg-slate-950/50 backdrop-blur-sm"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                onClick={closeSidebar}
              />
              <AgentSidebar
                key={selectedAgent.id}
                agent={selectedAgent}
                channels={channels}
                isApproved={approvedAgentId === selectedAgent.id}
                conversationId={conversationId}
                onApprove={handleApprove}
                onClose={closeSidebar}
              />
            </>
          )}
        </AnimatePresence>
      </div>
    </MotionConfig>
  );
}

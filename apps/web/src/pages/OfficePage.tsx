import {
  AnimatePresence,
  motion,
  MotionConfig,
  useReducedMotion,
  type Variants,
} from 'framer-motion';
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { Brand } from '../components/Brand';
import { LanguageSwitcher } from '../components/LanguageSwitcher';
import { ThemeToggle } from '../components/ThemeToggle';
import { useAuthStore } from '../store/auth.store';

type AgentStatus = 'idle' | 'working' | 'waiting_approval';

interface OfficeAgent {
  id: string;
  name: string;
  roleKey: string;
  taskKey: string;
  status: AgentStatus;
  desk: string;
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
    id: 'nova',
    name: 'Nova',
    roleKey: 'office.agents.nova.role',
    taskKey: 'office.agents.nova.task',
    status: 'working',
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
    desk: '06',
  },
];

const STATUS_ORDER: readonly AgentStatus[] = [
  'idle',
  'working',
  'waiting_approval',
];

const STATUS_META: Record<AgentStatus, StatusMeta> = {
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

function AgentDesk({
  agent,
  isSelected,
  onSelect,
}: {
  agent: OfficeAgent;
  isSelected: boolean;
  onSelect: (agentId: string) => void;
}) {
  const { t } = useTranslation();
  const shouldReduceMotion = useReducedMotion();
  const meta = STATUS_META[agent.status];
  const isWorking = agent.status === 'working';
  const isWaiting = agent.status === 'waiting_approval';

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
              {t(meta.labelKey)}
            </span>
          </div>

          <h3 className="mt-4 font-display text-lg font-bold text-on-surface">
            {agent.name}
          </h3>
          <p className="mt-0.5 text-sm text-on-surface-variant">
            {t(agent.roleKey)}
          </p>

          <div className="mt-4 rounded-xl border border-outline-variant/70 bg-surface/60 p-3">
            <p className="text-[11px] font-medium uppercase tracking-wider text-on-surface-variant">
              {t('office.currentTask')}
            </p>
            <p className="mt-1 line-clamp-2 text-sm leading-snug text-on-surface">
              {t(agent.taskKey)}
              {isWorking && (
                <span
                  aria-hidden="true"
                  className="office-cursor ml-0.5 inline-block h-3.5 w-0.5 translate-y-0.5 bg-primary"
                />
              )}
            </p>
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
  isApproved,
  onApprove,
  onClose,
}: {
  agent: OfficeAgent;
  isApproved: boolean;
  onApprove: (agentId: string) => void;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const meta = STATUS_META[agent.status];

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
              {t(meta.labelKey)}
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
              {t(meta.labelKey)}
            </dd>
          </div>
          <div>
            <dt className="text-xs font-medium uppercase tracking-wider text-on-surface-variant">
              {t('office.sidebar.task')}
            </dt>
            <dd className="mt-1 rounded-xl border border-outline-variant bg-surface-container p-3 text-sm leading-relaxed text-on-surface">
              {t(agent.taskKey)}
            </dd>
          </div>
        </dl>

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
          {t('office.sidebar.mockHint')}
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
  const [agents, setAgents] = useState<OfficeAgent[]>(() =>
    INITIAL_AGENTS.map((agent) => ({ ...agent })),
  );
  const [selectedAgentId, setSelectedAgentId] = useState<string | null>(null);
  const [approvedAgentId, setApprovedAgentId] = useState<string | null>(null);

  const selectedAgent =
    agents.find((agent) => agent.id === selectedAgentId) ?? null;

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
    setAgents((current) =>
      current.map((agent) =>
        agent.id === agentId ? { ...agent, status: 'working' } : agent,
      ),
    );
    setApprovedAgentId(agentId);
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
              <span className="hidden items-center gap-1.5 rounded-full border border-primary/30 bg-primary-container px-2.5 py-1 text-[11px] font-semibold text-on-primary-container sm:inline-flex">
                <span
                  aria-hidden="true"
                  className="size-1.5 animate-pulse rounded-full bg-primary"
                />
                {t('office.mockBadge')}
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
                to={isAuthenticated ? '/chat' : '/login'}
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

            <motion.ul
              initial="hidden"
              animate="show"
              variants={gridVariants}
              className="mt-8 grid gap-4 sm:grid-cols-2 xl:grid-cols-3"
            >
              {agents.map((agent) => (
                <AgentDesk
                  key={agent.id}
                  agent={agent}
                  isSelected={agent.id === selectedAgentId}
                  onSelect={handleSelect}
                />
              ))}
            </motion.ul>

            <p className="mt-6 flex items-start gap-2 text-xs leading-relaxed text-on-surface-variant">
              <span
                aria-hidden="true"
                className="mt-1 size-1.5 shrink-0 rounded-full bg-tertiary"
              />
              {t('office.mockNote')}
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
                isApproved={approvedAgentId === selectedAgent.id}
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

import { useQueryClient } from '@tanstack/react-query';
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type FormEvent,
} from 'react';
import { useTranslation } from 'react-i18next';
import { Link, NavLink, useNavigate } from 'react-router-dom';
import { BalanceWidget } from '../components/BalanceWidget';
import { Brand } from '../components/Brand';
import { ErrorToast } from '../components/ErrorToast';
import { LanguageSwitcher } from '../components/LanguageSwitcher';
import { LedgerHistoryModal } from '../components/LedgerHistoryModal';
import { ThemeToggle } from '../components/ThemeToggle';
import { TopUpModal } from '../components/TopUpModal';
import {
  useChatSession,
  type ChatMessage,
  type ConnectionState,
} from '../hooks/useChatSession';
import { useBalance } from '../hooks/useBalance';
import { useAuthStore } from '../store/auth.store';

const LOGOUT_BUTTON_CLASSES =
  'rounded-lg border border-outline px-3 py-2 text-sm font-medium text-on-surface-variant transition hover:border-error/40 hover:bg-error-container hover:text-on-error-container focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary';

function navItemClasses({ isActive }: { isActive: boolean }): string {
  return `flex items-center gap-2 rounded-lg px-3 py-2 text-sm font-medium transition focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary ${
    isActive
      ? 'bg-primary-container text-on-primary-container'
      : 'text-on-surface-variant hover:bg-surface-container-high hover:text-on-surface'
  }`;
}

const CONNECTION_LABEL_KEY: Record<ConnectionState, string> = {
  connecting: 'chat.status.connecting',
  online: 'chat.status.online',
  offline: 'chat.status.offline',
};

const CONNECTION_DOT: Record<ConnectionState, string> = {
  connecting: 'bg-amber-500',
  online: 'bg-emerald-500',
  offline: 'bg-error',
};

function getInitial(email: string): string {
  return email.trim().charAt(0).toUpperCase();
}

function MessageBubble({
  message,
  isStreaming,
}: {
  message: ChatMessage;
  isStreaming: boolean;
}) {
  const { t } = useTranslation();
  const isUser = message.role === 'user';

  return (
    <li className={`flex ${isUser ? 'justify-end' : 'justify-start'}`}>
      <div
        className={`max-w-[85%] rounded-2xl px-4 py-3 text-sm leading-relaxed shadow-sm ${
          isUser
            ? 'rounded-br-md bg-primary text-on-primary'
            : 'rounded-bl-md border border-outline-variant bg-surface-container-high text-on-surface'
        }`}
      >
        <span className="sr-only">
          {isUser ? t('chat.you') : t('chat.assistant')}
        </span>
        <p className="whitespace-pre-wrap break-words">
          {message.content}
          {isStreaming && (
            <span
              aria-hidden="true"
              className="ml-0.5 inline-block h-4 w-1 translate-y-0.5 animate-pulse rounded-sm bg-current align-baseline"
            />
          )}
        </p>
      </div>
    </li>
  );
}

function TypingIndicator() {
  const { t } = useTranslation();

  return (
    <div className="mt-4 flex justify-start" role="status">
      <div className="rounded-2xl rounded-bl-md border border-outline-variant bg-surface-container-high px-4 py-3">
        <span className="sr-only">{t('chat.typing')}</span>
        <span aria-hidden="true" className="flex items-center gap-1">
          {[0, 150, 300].map((delay) => (
            <span
              key={delay}
              className="size-1.5 animate-bounce rounded-full bg-on-surface-variant"
              style={{ animationDelay: `${delay}ms` }}
            />
          ))}
        </span>
      </div>
    </div>
  );
}

function SetupError({
  message,
  onRetry,
}: {
  message: string;
  onRetry: () => void;
}) {
  const { t } = useTranslation();

  return (
    <div
      role="alert"
      className="w-full max-w-md rounded-2xl border border-error/30 bg-error-container p-6 text-left text-on-error-container"
    >
      <h2 className="font-display text-lg font-bold">
        {t('chat.setupErrorTitle')}
      </h2>
      <p className="mt-2 text-sm leading-relaxed">{message}</p>
      <button
        type="button"
        onClick={onRetry}
        className="mt-4 inline-flex items-center justify-center rounded-lg bg-primary px-4 py-2 text-sm font-semibold text-on-primary transition hover:brightness-95 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
      >
        {t('chat.retry')}
      </button>
    </div>
  );
}

export function ChatPage() {
  const { t } = useTranslation();
  const user = useAuthStore((state) => state.user);
  const logout = useAuthStore((state) => state.logout);
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const {
    messages,
    conversationId,
    isReady,
    isSending,
    isStreaming,
    setupError,
    notice,
    noticeTopUp,
    sendMessage,
    clearNotice,
    retry,
  } = useChatSession();

  const balanceQuery = useBalance();
  const [draft, setDraft] = useState('');
  const [isTopUpOpen, setIsTopUpOpen] = useState(false);
  const [isHistoryOpen, setIsHistoryOpen] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);

  const openTopUp = useCallback(() => setIsTopUpOpen(true), []);
  const closeTopUp = useCallback(() => setIsTopUpOpen(false), []);
  const openHistory = useCallback(() => setIsHistoryOpen(true), []);
  const closeHistory = useCallback(() => setIsHistoryOpen(false), []);

  // Каждая дельта стрима обновляет messages, поэтому скролл идёт за текстом.
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ block: 'end' });
  }, [messages, isSending, isStreaming]);

  const status: ConnectionState = isReady
    ? 'online'
    : setupError !== null
      ? 'offline'
      : 'connecting';

  const officeHref =
    conversationId === null
      ? '/app/office'
      : `/app/office?conversationId=${encodeURIComponent(conversationId)}`;

  function handleLogout() {
    queryClient.clear();
    logout();
    navigate('/login', { replace: true });
  }

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    if (!isReady || isSending || draft.trim() === '') {
      return;
    }

    sendMessage(draft);
    setDraft('');
  }

  return (
    <>
      <div className="flex h-svh overflow-hidden bg-surface text-on-surface">
        <aside
          aria-label={t('chat.sidebarLabel')}
          className="hidden w-72 shrink-0 flex-col border-r border-outline-variant bg-surface-container md:flex"
        >
          <div className="flex h-16 items-center border-b border-outline-variant px-5">
            <Brand />
          </div>

          <nav
            aria-label={t('nav.primary')}
            className="space-y-1 border-b border-outline-variant p-3"
          >
            <NavLink to="/app/chat" className={navItemClasses}>
              <svg
                aria-hidden="true"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.7"
                strokeLinecap="round"
                strokeLinejoin="round"
                className="size-4"
              >
                <path d="M21 12a8 8 0 0 1-8 8H7l-4 3v-7a8 8 0 0 1 8-8h2a8 8 0 0 1 8 4Z" />
              </svg>
              {t('nav.chat')}
            </NavLink>

            <NavLink to="/app/skills" className={navItemClasses}>
              <svg
                aria-hidden="true"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.7"
                strokeLinecap="round"
                strokeLinejoin="round"
                className="size-4"
              >
                <rect x="4" y="4" width="6" height="6" rx="1" />
                <rect x="14" y="4" width="6" height="6" rx="1" />
                <rect x="4" y="14" width="6" height="6" rx="1" />
                <rect x="14" y="14" width="6" height="6" rx="1" />
              </svg>
              {t('nav.skills')}
            </NavLink>

            <NavLink to="/app/store" className={navItemClasses}>
              <svg
                aria-hidden="true"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.7"
                strokeLinecap="round"
                strokeLinejoin="round"
                className="size-4"
              >
                <path d="M6 7h12l1 13H5L6 7Z" />
                <path d="M9 7a3 3 0 0 1 6 0" />
              </svg>
              {t('nav.store')}
            </NavLink>

            <NavLink to={officeHref} className={navItemClasses}>
              <svg
                aria-hidden="true"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.7"
                strokeLinecap="round"
                strokeLinejoin="round"
                className="size-4"
              >
                <path d="M3 21h18M5 21V7l7-4 7 4v14" />
                <path d="M9 21v-6h6v6" />
              </svg>
              {t('nav.office')}
            </NavLink>
          </nav>

          <div className="flex-1 overflow-y-auto p-4">
            <h2 className="px-2 text-xs font-semibold uppercase tracking-widest text-on-surface-variant">
              {t('chat.chatsTitle')}
            </h2>

            {conversationId !== null ? (
              <div
                aria-current="true"
                className="mt-4 flex items-center gap-2 rounded-xl bg-primary-container px-3 py-2.5 text-sm font-medium text-on-primary-container"
              >
                <span
                  aria-hidden="true"
                  className="size-1.5 shrink-0 rounded-full bg-primary"
                />
                {t('chat.newConversation')}
              </div>
            ) : (
              <p className="mt-4 rounded-xl border border-dashed border-outline px-4 py-8 text-center text-sm text-on-surface-variant">
                {t('chat.noChats')}
              </p>
            )}
          </div>

          <div className="border-t border-outline-variant p-4">
            <BalanceWidget
              balance={balanceQuery.data}
              isFetching={balanceQuery.isFetching}
              isError={balanceQuery.isError}
              onRetry={() => {
                void balanceQuery.refetch();
              }}
              onTopUp={openTopUp}
              onHistory={openHistory}
            />

            <div className="mt-4 flex items-center justify-between gap-3">
              <span className="text-xs font-medium text-on-surface-variant">
                {t('language.title')}
              </span>
              <LanguageSwitcher />
            </div>

            <div className="mt-4 flex items-center gap-3">
              <span
                aria-hidden="true"
                className="grid size-9 shrink-0 place-items-center rounded-full bg-primary-container text-sm font-semibold text-on-primary-container"
              >
                {user === null ? '?' : getInitial(user.email)}
              </span>
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium text-on-surface">
                  {user?.email ?? t('chat.guest')}
                </p>
                <p className="text-xs text-on-surface-variant">
                  {user?.role ?? '—'}
                </p>
              </div>
            </div>
            <button
              type="button"
              onClick={handleLogout}
              className={`mt-4 w-full ${LOGOUT_BUTTON_CLASSES}`}
            >
              {t('chat.logout')}
            </button>
          </div>
        </aside>

        <main className="flex min-w-0 flex-1 flex-col">
          <header className="flex h-16 shrink-0 items-center justify-between gap-4 border-b border-outline-variant bg-surface/90 px-4 backdrop-blur sm:px-6">
            <div className="flex min-w-0 items-center gap-3">
              <div className="md:hidden">
                <Brand compact />
              </div>
              <div className="hidden min-w-0 md:block">
                <h1 className="truncate text-sm font-semibold text-on-surface">
                  {t('chat.newConversation')}
                </h1>
                <p className="mt-0.5 flex items-center gap-1.5 text-xs text-on-surface-variant">
                  <span
                    aria-hidden="true"
                    className={`size-1.5 rounded-full ${CONNECTION_DOT[status]}`}
                  />
                  {t(CONNECTION_LABEL_KEY[status])}
                </p>
              </div>
            </div>

            <div className="flex items-center gap-2">
              <div className="md:hidden">
                <LanguageSwitcher />
              </div>
              <Link
                to="/app/skills"
                aria-label={t('nav.skills')}
                title={t('nav.skills')}
                className="inline-flex size-10 items-center justify-center rounded-full border border-outline bg-surface-container text-on-surface-variant transition hover:bg-surface-container-high hover:text-on-surface focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary md:hidden"
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
                  <rect x="4" y="4" width="6" height="6" rx="1" />
                  <rect x="14" y="4" width="6" height="6" rx="1" />
                  <rect x="4" y="14" width="6" height="6" rx="1" />
                  <rect x="14" y="14" width="6" height="6" rx="1" />
                </svg>
              </Link>
              <Link
                to="/app/store"
                aria-label={t('nav.store')}
                title={t('nav.store')}
                className="inline-flex size-10 items-center justify-center rounded-full border border-outline bg-surface-container text-on-surface-variant transition hover:bg-surface-container-high hover:text-on-surface focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary md:hidden"
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
                  <path d="M6 7h12l1 13H5L6 7Z" />
                  <path d="M9 7a3 3 0 0 1 6 0" />
                </svg>
              </Link>
              <Link
                to={officeHref}
                aria-label={t('nav.office')}
                title={t('nav.office')}
                className="inline-flex size-10 items-center justify-center rounded-full border border-outline bg-surface-container text-on-surface-variant transition hover:bg-surface-container-high hover:text-on-surface focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary md:hidden"
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
                  <path d="M3 21h18M5 21V7l7-4 7 4v14" />
                  <path d="M9 21v-6h6v6" />
                </svg>
              </Link>
              <ThemeToggle />
              <button
                type="button"
                onClick={handleLogout}
                aria-label={t('chat.logout')}
                title={t('chat.logout')}
                className="inline-flex size-10 items-center justify-center rounded-full border border-outline text-on-surface-variant transition hover:border-error/40 hover:bg-error-container hover:text-on-error-container focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary md:hidden"
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
                  <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
                  <path d="m16 17 5-5-5-5M21 12H9" />
                </svg>
              </button>
            </div>
          </header>

          <div className="border-b border-outline-variant bg-surface-container/50 px-4 py-2 md:hidden">
            <BalanceWidget
              variant="inline"
              balance={balanceQuery.data}
              isFetching={balanceQuery.isFetching}
              isError={balanceQuery.isError}
              onRetry={() => {
                void balanceQuery.refetch();
              }}
              onTopUp={openTopUp}
              onHistory={openHistory}
            />
          </div>

          <div className="flex-1 overflow-y-auto">
            <div className="mx-auto flex min-h-full w-full max-w-3xl flex-col px-4 py-6 sm:px-6">
              {messages.length === 0 ? (
                <div className="flex flex-1 flex-col items-center justify-center gap-5 py-10 text-center">
                  {setupError !== null ? (
                    <SetupError message={setupError} onRetry={retry} />
                  ) : (
                    <>
                      <div
                        aria-hidden="true"
                        className="grid size-14 place-items-center rounded-2xl border border-primary/20 bg-primary-container text-on-primary-container"
                      >
                        <svg
                          viewBox="0 0 24 24"
                          fill="none"
                          stroke="currentColor"
                          strokeWidth="1.6"
                          strokeLinecap="round"
                          strokeLinejoin="round"
                          className="size-7"
                        >
                          <path d="M21 12a8 8 0 0 1-8 8H7l-4 3v-7a8 8 0 0 1 8-8h2a8 8 0 0 1 8 4Z" />
                          <path d="M8 11h8M8 15h5" />
                        </svg>
                      </div>
                      <h2
                        id="chat-welcome-title"
                        className="font-display text-2xl font-bold tracking-tight text-on-surface sm:text-3xl"
                      >
                        {t('chat.welcomeTitle')}
                      </h2>
                      <p className="max-w-md text-sm leading-relaxed text-on-surface-variant">
                        {t('chat.welcomeSubtitle')}
                      </p>
                      {!isReady && (
                        <p className="flex items-center gap-2 text-xs text-on-surface-variant">
                          <svg
                            aria-hidden="true"
                            viewBox="0 0 24 24"
                            fill="none"
                            className="size-3.5 animate-spin"
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
                          {t('chat.connecting')}
                        </p>
                      )}
                    </>
                  )}
                </div>
              ) : (
                <ol
                  aria-label={t('chat.messagesLabel')}
                  aria-live="polite"
                  aria-relevant="additions"
                  className="flex flex-col gap-4"
                >
                  {messages.map((message, index) => (
                    <MessageBubble
                      key={message.id}
                      message={message}
                      isStreaming={
                        isStreaming && index === messages.length - 1
                      }
                    />
                  ))}
                </ol>
              )}

              {isSending && !isStreaming && <TypingIndicator />}
              <div ref={messagesEndRef} />
            </div>
          </div>

          <form
            onSubmit={handleSubmit}
            className="shrink-0 border-t border-outline-variant bg-surface px-4 py-4 sm:px-6"
          >
            <div className="mx-auto flex max-w-3xl items-center gap-2">
              <label htmlFor="chat-message" className="sr-only">
                {t('chat.messageLabel')}
              </label>
              <input
                id="chat-message"
                name="message"
                type="text"
                autoComplete="off"
                placeholder={
                  isReady ? t('chat.inputPlaceholder') : t('chat.inputWaiting')
                }
                value={draft}
                onChange={(event) => setDraft(event.target.value)}
                disabled={!isReady || isSending}
                className="h-12 w-full rounded-xl border border-outline bg-surface-container px-4 text-sm text-on-surface outline-none transition placeholder:text-on-surface-variant/60 hover:border-primary/40 focus:border-primary focus:ring-4 focus:ring-primary/15 disabled:cursor-not-allowed disabled:opacity-60"
              />
              <button
                type="submit"
                disabled={!isReady || isSending || draft.trim() === ''}
                aria-label={isSending ? t('chat.sending') : t('chat.send')}
                aria-busy={isSending}
                className="grid size-12 shrink-0 place-items-center rounded-xl bg-primary text-on-primary shadow-lg shadow-primary/25 transition hover:brightness-95 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary active:brightness-95 disabled:cursor-not-allowed disabled:opacity-40 disabled:shadow-none"
              >
                {isSending ? (
                  <svg
                    aria-hidden="true"
                    viewBox="0 0 24 24"
                    fill="none"
                    className="size-5 animate-spin"
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
                ) : (
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
                    <path d="m4 4 17 8-17 8 3.5-8L4 4Z" />
                    <path d="M7.5 12H21" />
                  </svg>
                )}
              </button>
            </div>
            <p className="mx-auto mt-2 max-w-3xl text-xs text-on-surface-variant">
              {t('chat.inputHint')}
            </p>
          </form>
        </main>
      </div>

      <TopUpModal
        open={isTopUpOpen}
        onClose={closeTopUp}
        userId={user?.id ?? ''}
        balance={balanceQuery.data}
      />

      <LedgerHistoryModal open={isHistoryOpen} onClose={closeHistory} />

      {notice !== null && (
        <ErrorToast
          message={notice}
          onClose={clearNotice}
          action={
            noticeTopUp
              ? {
                  label: t('billing.topUp'),
                  onClick: () => {
                    clearNotice();
                    openTopUp();
                  },
                }
              : undefined
          }
        />
      )}
    </>
  );
}

import { useEffect, useRef, useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import { Brand } from '../components/Brand';
import { ErrorToast } from '../components/ErrorToast';
import { LanguageSwitcher } from '../components/LanguageSwitcher';
import { ThemeToggle } from '../components/ThemeToggle';
import {
  useChatSession,
  type ChatMessage,
  type ConnectionState,
} from '../hooks/useChatSession';
import { useAuthStore } from '../store/auth.store';

const LOGOUT_BUTTON_CLASSES =
  'rounded-lg border border-outline px-3 py-2 text-sm font-medium text-on-surface-variant transition hover:border-error/40 hover:bg-error-container hover:text-on-error-container focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary';

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

function MessageBubble({ message }: { message: ChatMessage }) {
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
        <p className="whitespace-pre-wrap break-words">{message.content}</p>
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

  const {
    messages,
    conversationId,
    isReady,
    isSending,
    setupError,
    notice,
    sendMessage,
    clearNotice,
    retry,
  } = useChatSession();

  const [draft, setDraft] = useState('');
  const messagesEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ block: 'end' });
  }, [messages, isSending]);

  const status: ConnectionState = isReady
    ? 'online'
    : setupError !== null
      ? 'offline'
      : 'connecting';

  function handleLogout() {
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
            <div className="flex items-center justify-between gap-3">
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
              <ThemeToggle />
              <button
                type="button"
                onClick={handleLogout}
                className={`md:hidden ${LOGOUT_BUTTON_CLASSES}`}
              >
                {t('chat.logout')}
              </button>
            </div>
          </header>

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
                  {messages.map((message) => (
                    <MessageBubble key={message.id} message={message} />
                  ))}
                </ol>
              )}

              {isSending && <TypingIndicator />}
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

      {notice !== null && <ErrorToast message={notice} onClose={clearNotice} />}
    </>
  );
}

import { useCallback, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, NavLink } from 'react-router-dom';
import { Brand } from '../components/Brand';
import { ErrorToast } from '../components/ErrorToast';
import { IntegrationsSection } from '../components/IntegrationsSection';
import { LanguageSwitcher } from '../components/LanguageSwitcher';
import { RagMemoryPanel } from '../components/RagMemoryPanel';
import { StatusToast } from '../components/StatusToast';
import { ThemeToggle } from '../components/ThemeToggle';
import { RAG_MEMORY_PANEL_ENABLED } from '../lib/feature-flags';
import { clearMemory, getMemoryErrorMessage } from '../lib/memory';
import { isAdminRole } from '../lib/roles';
import { useAuthStore } from '../store/auth.store';

interface Notice {
  tone: 'success' | 'error';
  message: string;
}

/** Единый контейнер секций страницы настроек. */
const SECTION_CLASSES =
  'rounded-2xl border border-outline-variant bg-surface-container p-5 shadow-sm sm:p-6';

function navLinkClasses({ isActive }: { isActive: boolean }): string {
  return `rounded-lg px-3 py-2 text-sm font-medium transition focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary ${
    isActive
      ? 'bg-primary-container text-on-primary-container'
      : 'text-on-surface-variant hover:bg-surface-container-high hover:text-on-surface'
  }`;
}

export function SettingsPage() {
  const { t } = useTranslation();
  const role = useAuthStore((state) => state.user?.role);
  const isAdmin = isAdminRole(role);
  const [isClearing, setIsClearing] = useState(false);
  const [notice, setNotice] = useState<Notice | null>(null);

  const clearNotice = useCallback(() => setNotice(null), []);

  async function handleClearMemory() {
    if (isClearing) {
      return;
    }

    setIsClearing(true);
    setNotice(null);

    try {
      await clearMemory();
      setNotice({ tone: 'success', message: t('settings.memory.cleared') });
    } catch (error) {
      setNotice({ tone: 'error', message: getMemoryErrorMessage(error) });
    } finally {
      setIsClearing(false);
    }
  }

  return (
    <div className="min-h-svh bg-surface text-on-surface">
      <header className="sticky top-0 z-20 border-b border-outline-variant bg-surface/90 backdrop-blur">
        <div className="mx-auto flex h-16 max-w-6xl items-center justify-between gap-3 px-4 sm:px-6">
          <div className="flex min-w-0 items-center gap-2 sm:gap-4">
            <span className="sm:hidden">
              <Brand compact />
            </span>
            <span className="hidden sm:block">
              <Brand />
            </span>

            <Link
              to="/app/chat"
              aria-label={t('settings.backToChat')}
              title={t('settings.backToChat')}
              className="inline-flex size-10 items-center justify-center rounded-full border border-outline text-on-surface-variant transition hover:bg-surface-container-high hover:text-on-surface focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary sm:hidden"
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
                <path d="M19 12H5M11 18l-6-6 6-6" />
              </svg>
            </Link>

            <nav
              aria-label={t('nav.primary')}
              className="hidden items-center gap-1 sm:flex"
            >
              <NavLink to="/app/chat" className={navLinkClasses}>
                {t('nav.chat')}
              </NavLink>
              <NavLink to="/app/skills" className={navLinkClasses}>
                {t('nav.skills')}
              </NavLink>
              <NavLink to="/app/store" className={navLinkClasses}>
                {t('nav.store')}
              </NavLink>
              <NavLink to="/app/office" className={navLinkClasses}>
                {t('nav.office')}
              </NavLink>
              <NavLink to="/app/settings" className={navLinkClasses}>
                {t('nav.settings')}
              </NavLink>
              {isAdmin && (
                <NavLink to="/admin" className={navLinkClasses}>
                  {t('nav.admin')}
                </NavLink>
              )}
            </nav>
          </div>

          <div className="flex items-center gap-2">
            <LanguageSwitcher />
            <ThemeToggle />
          </div>
        </div>
      </header>

      <main className="mx-auto w-full max-w-3xl px-4 py-8 sm:px-6 lg:py-10">
        <h1 className="font-display text-3xl font-bold tracking-tight text-on-surface">
          {t('settings.title')}
        </h1>
        <p className="mt-2 max-w-2xl text-sm leading-relaxed text-on-surface-variant">
          {t('settings.subtitle')}
        </p>

        <div className="mt-8 space-y-6">
          <IntegrationsSection />

          <section
            aria-labelledby="memory-title"
            aria-describedby="memory-description"
            className={SECTION_CLASSES}
          >
            <div className="flex flex-wrap items-start justify-between gap-4">
              <div className="min-w-0 max-w-xl">
                <h2
                  id="memory-title"
                  className="font-display text-lg font-bold text-on-surface"
                >
                  {t('settings.memory.title')}
                </h2>
                <p
                  id="memory-description"
                  className="mt-2 text-sm leading-relaxed text-on-surface-variant"
                >
                  {t('settings.memory.description')}
                </p>
              </div>

              <button
                type="button"
                onClick={() => {
                  void handleClearMemory();
                }}
                disabled={isClearing}
                aria-busy={isClearing}
                className="inline-flex shrink-0 items-center justify-center rounded-lg bg-error px-4 py-2 text-sm font-semibold text-on-error shadow-sm shadow-error/20 transition hover:brightness-95 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-error active:brightness-95 disabled:cursor-not-allowed disabled:opacity-60 disabled:shadow-none"
              >
                {isClearing
                  ? t('settings.memory.clearing')
                  : t('settings.memory.clear')}
              </button>
            </div>
          </section>

          {RAG_MEMORY_PANEL_ENABLED && <RagMemoryPanel />}
        </div>
      </main>

      {notice?.tone === 'success' && (
        <StatusToast
          tone="success"
          message={notice.message}
          onClose={clearNotice}
        />
      )}

      {notice?.tone === 'error' && (
        <ErrorToast message={notice.message} onClose={clearNotice} />
      )}
    </div>
  );
}

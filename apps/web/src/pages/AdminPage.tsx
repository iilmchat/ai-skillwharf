import { useQueryClient } from '@tanstack/react-query';
import type { KeyboardEvent } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Link,
  NavLink,
  useNavigate,
  useSearchParams,
} from 'react-router-dom';
import { AuditTab } from '../components/admin/AuditTab';
import { LlmRouterTab } from '../components/admin/LlmRouterTab';
import { PromptsTab } from '../components/admin/PromptsTab';
import { Brand } from '../components/Brand';
import { LanguageSwitcher } from '../components/LanguageSwitcher';
import { ThemeToggle } from '../components/ThemeToggle';
import { useAuthStore } from '../store/auth.store';

const TAB_IDS = ['prompts', 'router', 'audit'] as const;
type AdminTab = (typeof TAB_IDS)[number];

function parseTab(value: string | null): AdminTab {
  return value === 'router' || value === 'audit' ? value : 'prompts';
}

function navLinkClasses({ isActive }: { isActive: boolean }): string {
  return `rounded-lg px-3 py-2 text-sm font-medium transition focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary ${
    isActive
      ? 'bg-primary-container text-on-primary-container'
      : 'text-on-surface-variant hover:bg-surface-container-high hover:text-on-surface'
  }`;
}

export function AdminPage() {
  const { t } = useTranslation();
  const user = useAuthStore((state) => state.user);
  const logout = useAuthStore((state) => state.logout);
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [searchParams, setSearchParams] = useSearchParams();
  const activeTab = parseTab(searchParams.get('tab'));

  function selectTab(tab: AdminTab) {
    const next = new URLSearchParams(searchParams);
    next.set('tab', tab);
    setSearchParams(next, { replace: true });
  }

  function handleTabKeyDown(event: KeyboardEvent<HTMLButtonElement>) {
    const currentIndex = TAB_IDS.indexOf(activeTab);
    let nextIndex = currentIndex;

    if (event.key === 'ArrowRight') {
      nextIndex = (currentIndex + 1) % TAB_IDS.length;
    } else if (event.key === 'ArrowLeft') {
      nextIndex = (currentIndex - 1 + TAB_IDS.length) % TAB_IDS.length;
    } else if (event.key === 'Home') {
      nextIndex = 0;
    } else if (event.key === 'End') {
      nextIndex = TAB_IDS.length - 1;
    } else {
      return;
    }

    event.preventDefault();
    const nextTab = TAB_IDS[nextIndex];
    selectTab(nextTab);
    document.getElementById(`admin-tab-${nextTab}`)?.focus();
  }

  function handleLogout() {
    queryClient.clear();
    logout();
    navigate('/login', { replace: true });
  }

  return (
    <div className="min-h-svh bg-surface text-on-surface">
      <header className="sticky top-0 z-30 border-b border-outline-variant/70 bg-surface/85 backdrop-blur-xl">
        <div className="mx-auto flex h-16 max-w-7xl items-center justify-between gap-3 px-4 sm:px-6">
          <div className="flex min-w-0 items-center gap-2 sm:gap-4">
            <span className="sm:hidden">
              <Brand compact />
            </span>
            <span className="hidden sm:block">
              <Brand />
            </span>

            <Link
              to="/app/chat"
              aria-label={t('admin.backToChat')}
              title={t('admin.backToChat')}
              className="inline-flex size-10 items-center justify-center rounded-full border border-outline text-on-surface-variant transition hover:bg-surface-container-high hover:text-on-surface focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary lg:hidden"
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
              className="hidden items-center gap-1 lg:flex"
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
              <NavLink to="/admin" className={navLinkClasses}>
                {t('nav.admin')}
              </NavLink>
            </nav>
          </div>

          <div className="flex shrink-0 items-center gap-2">
            <span className="hidden max-w-48 truncate rounded-full border border-outline-variant bg-surface-container px-3 py-1 text-xs font-medium text-on-surface-variant xl:inline-flex">
              {user?.email ?? t('admin.guest')}
            </span>
            <LanguageSwitcher />
            <ThemeToggle />
            <button
              type="button"
              onClick={handleLogout}
              aria-label={t('chat.logout')}
              title={t('chat.logout')}
              className="inline-flex size-10 items-center justify-center rounded-full border border-outline text-on-surface-variant transition hover:border-error/40 hover:bg-error-container hover:text-on-error-container focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
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
        </div>
      </header>

      <main className="relative overflow-hidden">
        <div
          aria-hidden="true"
          className="brand-grid pointer-events-none absolute inset-x-0 top-0 h-80"
        />
        <div
          aria-hidden="true"
          className="pointer-events-none absolute -top-24 left-1/2 h-72 w-[42rem] -translate-x-1/2 rounded-full bg-primary/10 blur-3xl"
        />

        <div className="relative mx-auto w-full max-w-7xl px-4 py-10 sm:px-6 lg:py-14">
          <div className="flex flex-wrap items-end justify-between gap-4">
            <div>
              <p className="inline-flex items-center gap-2 rounded-full border border-tertiary/30 bg-tertiary-container px-3 py-1 text-xs font-medium text-on-tertiary-container">
                <span
                  aria-hidden="true"
                  className="size-1.5 rounded-full bg-tertiary"
                />
                {t('admin.eyebrow')}
              </p>
              <h1 className="mt-4 font-display text-4xl font-bold tracking-tight text-on-surface sm:text-5xl">
                {t('admin.title')}
              </h1>
              <p className="mt-3 max-w-2xl text-base leading-relaxed text-on-surface-variant">
                {t('admin.subtitle')}
              </p>
            </div>

            <span className="rounded-full border border-outline-variant bg-surface-container px-3 py-1.5 text-xs font-medium text-on-surface-variant">
              {t('admin.roleBadge', { role: user?.role ?? '—' })}
            </span>
          </div>

          <div
            role="tablist"
            aria-label={t('admin.tabs.label')}
            className="mt-8 flex flex-wrap gap-1 rounded-2xl border border-outline-variant bg-surface-container p-1"
          >
            {TAB_IDS.map((tab) => {
              const isActive = tab === activeTab;

              return (
                <button
                  key={tab}
                  id={`admin-tab-${tab}`}
                  type="button"
                  role="tab"
                  aria-selected={isActive}
                  aria-controls={`admin-panel-${tab}`}
                  tabIndex={isActive ? 0 : -1}
                  onClick={() => selectTab(tab)}
                  onKeyDown={handleTabKeyDown}
                  className={`rounded-xl px-4 py-2.5 text-sm font-semibold transition focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary ${
                    isActive
                      ? 'bg-primary text-on-primary shadow-lg shadow-primary/20'
                      : 'text-on-surface-variant hover:bg-surface-container-high hover:text-on-surface'
                  }`}
                >
                  {t(`admin.tabs.${tab}`)}
                </button>
              );
            })}
          </div>

          <section
            id={`admin-panel-${activeTab}`}
            role="tabpanel"
            aria-labelledby={`admin-tab-${activeTab}`}
            className="mt-6 rounded-3xl border border-outline-variant bg-surface/80 p-5 shadow-sm backdrop-blur sm:p-7"
          >
            {activeTab === 'prompts' && <PromptsTab />}
            {activeTab === 'router' && <LlmRouterTab />}
            {activeTab === 'audit' && <AuditTab />}
          </section>
        </div>
      </main>
    </div>
  );
}

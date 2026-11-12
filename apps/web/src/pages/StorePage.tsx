import { useMutation, useQueryClient } from '@tanstack/react-query';
import {
  useCallback,
  useMemo,
  useState,
  type KeyboardEvent,
} from 'react';
import { useTranslation } from 'react-i18next';
import { Link, NavLink } from 'react-router-dom';
import { Brand } from '../components/Brand';
import { ErrorToast } from '../components/ErrorToast';
import { LanguageSwitcher } from '../components/LanguageSwitcher';
import { SkillPricingBadge } from '../components/SkillPricingBadge';
import { ThemeToggle } from '../components/ThemeToggle';
import { VetterWarningModal } from '../components/VetterWarningModal';
import {
  registrySkillsQueryKey,
  useRegistrySkills,
} from '../hooks/useRegistrySkills';
import { skillsQueryKey, useSkills } from '../hooks/useSkills';
import { isAdminRole } from '../lib/roles';
import {
  getRegistryPricing,
  getRegistryVetterReport,
  getSkillCategory,
  getStoreErrorMessage,
  getVetterReportFromError,
  installRegistrySkill,
  type InstallRegistrySkillResult,
  type RegistrySkill,
  type StoreCategory,
  type VetterReport,
} from '../lib/registry';
import { useAuthStore } from '../store/auth.store';

const STORE_CATEGORIES: readonly StoreCategory[] = [
  'all',
  'search',
  'dev',
  'communication',
  'productivity',
];

interface InstallVariables {
  skill: RegistrySkill;
  ignoreWarnings: boolean;
}

function navLinkClasses({ isActive }: { isActive: boolean }): string {
  return `rounded-lg px-3 py-2 text-sm font-medium transition focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary ${
    isActive
      ? 'bg-primary-container text-on-primary-container'
      : 'text-on-surface-variant hover:bg-surface-container-high hover:text-on-surface'
  }`;
}

function StoreSkillCard({
  skill,
  isInstalled,
  isInstalling,
  isDisabled,
  onInstall,
}: {
  skill: RegistrySkill;
  isInstalled: boolean;
  isInstalling: boolean;
  isDisabled: boolean;
  onInstall: (skill: RegistrySkill) => void;
}) {
  const { t } = useTranslation();
  const description = skill.description ?? skill.manifest?.description;
  const pricing = getRegistryPricing(skill) ?? skill.manifest?.pricing;

  return (
    <li className="h-full">
      <article className="flex h-full flex-col rounded-2xl border border-outline-variant bg-surface-container p-5 shadow-sm transition hover:border-primary/30 hover:shadow-md">
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0">
            <h2
              className="truncate font-display text-lg font-bold text-on-surface"
              title={skill.name}
            >
              {skill.name}
            </h2>
            <p className="mt-1 text-xs text-on-surface-variant">
              {t('store.author', { author: skill.author ?? '—' })}
            </p>
          </div>

          {skill.version !== undefined && (
            <span className="shrink-0 rounded-full border border-outline-variant bg-surface-container-high px-2.5 py-1 text-xs font-medium text-on-surface-variant">
              v{skill.version}
            </span>
          )}
        </div>

        {description !== undefined && (
          <p className="mt-3 line-clamp-3 text-sm leading-relaxed text-on-surface-variant">
            {description}
          </p>
        )}

        <div className="mt-auto flex flex-wrap items-center justify-between gap-3 pt-5">
          <SkillPricingBadge pricing={pricing} />

          <button
            type="button"
            onClick={() => onInstall(skill)}
            disabled={isInstalled || isDisabled}
            aria-busy={isInstalling}
            className={`inline-flex items-center justify-center gap-2 rounded-xl px-4 py-2 text-sm font-semibold transition focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary ${
              isInstalled
                ? 'border border-outline-variant bg-surface-container-high text-on-surface-variant'
                : 'bg-primary text-on-primary shadow-lg shadow-primary/25 hover:brightness-95 active:brightness-95'
            } disabled:cursor-not-allowed disabled:opacity-60 disabled:shadow-none`}
          >
            {isInstalling && (
              <svg
                aria-hidden="true"
                viewBox="0 0 24 24"
                fill="none"
                className="size-4 animate-spin"
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
            )}
            {isInstalled
              ? t('store.installed')
              : isInstalling
                ? t('store.installing')
                : t('store.install')}
          </button>
        </div>
      </article>
    </li>
  );
}

function StoreSkeleton() {
  return (
    <ul
      aria-hidden="true"
      className="mt-8 grid gap-4 sm:grid-cols-2 xl:grid-cols-3"
    >
      {[0, 1, 2, 3, 4, 5].map((index) => (
        <li
          key={index}
          className="h-52 animate-pulse rounded-2xl border border-outline-variant bg-surface-container"
        />
      ))}
    </ul>
  );
}

export function StorePage() {
  const { t } = useTranslation();
  const role = useAuthStore((state) => state.user?.role);
  const isAdmin = isAdminRole(role);
  const queryClient = useQueryClient();
  const registryQuery = useRegistrySkills();
  const skillsQuery = useSkills();

  const [notice, setNotice] = useState<string | null>(null);
  const [successName, setSuccessName] = useState<string | null>(null);
  const [pendingSkill, setPendingSkill] = useState<RegistrySkill | null>(null);
  const [vetterReport, setVetterReport] = useState<VetterReport | null>(null);
  const [category, setCategory] = useState<StoreCategory>('all');

  const clearNotice = useCallback(() => setNotice(null), []);
  const closeVetter = useCallback(() => {
    setPendingSkill(null);
    setVetterReport(null);
  }, []);

  const installMutation = useMutation<
    InstallRegistrySkillResult,
    unknown,
    InstallVariables
  >({
    mutationFn: ({ skill, ignoreWarnings }) =>
      installRegistrySkill({ skill, ignoreWarnings }),
    onSuccess: (result, { skill, ignoreWarnings }) => {
      // Первый ответ содержит замечания Vetter — просим подтверждение.
      // Навык мог уже установиться, поэтому каталог инвалидируем сразу.
      if (result.vetter !== null && !ignoreWarnings) {
        setPendingSkill(skill);
        setVetterReport(result.vetter);
        void queryClient.invalidateQueries({ queryKey: skillsQueryKey });
        return;
      }

      closeVetter();
      setNotice(null);
      setSuccessName(skill.name);
      void queryClient.invalidateQueries({ queryKey: skillsQueryKey });
      void queryClient.invalidateQueries({ queryKey: registrySkillsQueryKey });
    },
    onError: (error, { skill, ignoreWarnings }) => {
      const report = getVetterReportFromError(error);

      if (report !== null && !ignoreWarnings) {
        setPendingSkill(skill);
        setVetterReport(report);
        return;
      }

      closeVetter();
      setSuccessName(null);
      setNotice(
        report !== null
          ? t('store.errors.vetter')
          : getStoreErrorMessage(error, 'store.errors.install'),
      );
    },
  });

  function handleInstall(skill: RegistrySkill) {
    setSuccessName(null);
    setNotice(null);

    // Реестр отдаёт разрешения — предупреждаем до установки.
    const localReport = getRegistryVetterReport(skill);

    if (localReport !== null) {
      setPendingSkill(skill);
      setVetterReport(localReport);
      return;
    }

    installMutation.mutate({ skill, ignoreWarnings: false });
  }

  function handleConfirmInstall() {
    if (pendingSkill === null) {
      return;
    }

    installMutation.mutate({ skill: pendingSkill, ignoreWarnings: true });
  }

  function handleCategoryKeyDown(event: KeyboardEvent<HTMLButtonElement>) {
    const currentIndex = STORE_CATEGORIES.indexOf(category);
    let nextIndex = currentIndex;

    if (event.key === 'ArrowRight') {
      nextIndex = (currentIndex + 1) % STORE_CATEGORIES.length;
    } else if (event.key === 'ArrowLeft') {
      nextIndex =
        (currentIndex - 1 + STORE_CATEGORIES.length) %
        STORE_CATEGORIES.length;
    } else if (event.key === 'Home') {
      nextIndex = 0;
    } else if (event.key === 'End') {
      nextIndex = STORE_CATEGORIES.length - 1;
    } else {
      return;
    }

    event.preventDefault();
    const nextCategory = STORE_CATEGORIES[nextIndex];
    setCategory(nextCategory);
    document.getElementById(`store-category-${nextCategory}`)?.focus();
  }

  const installedSkills = useMemo<RegistrySkill[]>(
    () =>
      (skillsQuery.data ?? []).map((skill) => ({
        name: skill.name,
        author: skill.author,
        version: skill.version,
        description: skill.manifest.description,
        pricing: skill.manifest.pricing,
      })),
    [skillsQuery.data],
  );

  // Реестр — основной источник; установленные mock-навыки (Ozon, WB,
  // Telegram, Google, Midjourney) добираем, пока их нет в реестре.
  const allSkills = useMemo<RegistrySkill[]>(() => {
    const byName = new Map<string, RegistrySkill>();

    for (const skill of registryQuery.data ?? []) {
      byName.set(skill.name, skill);
    }

    for (const skill of installedSkills) {
      if (!byName.has(skill.name)) {
        byName.set(skill.name, skill);
      }
    }

    return [...byName.values()];
  }, [registryQuery.data, installedSkills]);

  const categoryCounts = useMemo<Record<StoreCategory, number>>(() => {
    const counts: Record<StoreCategory, number> = {
      all: allSkills.length,
      search: 0,
      dev: 0,
      communication: 0,
      productivity: 0,
    };

    for (const skill of allSkills) {
      const skillCategory = getSkillCategory(skill.name);

      if (skillCategory !== 'all') {
        counts[skillCategory] += 1;
      }
    }

    return counts;
  }, [allSkills]);

  const visibleSkills = useMemo(
    () =>
      category === 'all'
        ? allSkills
        : allSkills.filter(
            (skill) => getSkillCategory(skill.name) === category,
          ),
    [allSkills, category],
  );

  const installedNames = useMemo(
    () => new Set(installedSkills.map((skill) => skill.name)),
    [installedSkills],
  );

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
              aria-label={t('skills.backToChat')}
              title={t('skills.backToChat')}
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

      <main className="mx-auto w-full max-w-6xl px-4 py-8 sm:px-6 lg:py-10">
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div>
            <h1 className="font-display text-3xl font-bold tracking-tight text-on-surface">
              {t('store.title')}
            </h1>
            <p className="mt-2 max-w-2xl text-sm leading-relaxed text-on-surface-variant">
              {t('store.subtitle')}
            </p>
          </div>

          {(registryQuery.data !== undefined ||
            skillsQuery.data !== undefined) && (
            <span className="rounded-full border border-outline-variant bg-surface-container px-3 py-1 text-xs font-medium text-on-surface-variant">
              {t('store.count', { count: allSkills.length })}
            </span>
          )}
        </div>

        {!registryQuery.isPending &&
          !registryQuery.isError &&
          allSkills.length > 0 && (
            <div
              role="tablist"
              aria-label={t('store.categories.label')}
              className="mt-6 flex flex-wrap gap-1 rounded-2xl border border-outline-variant bg-surface-container p-1"
            >
              {STORE_CATEGORIES.map((storeCategory) => {
                const isActive = category === storeCategory;

                return (
                  <button
                    key={storeCategory}
                    id={`store-category-${storeCategory}`}
                    type="button"
                    role="tab"
                    aria-selected={isActive}
                    aria-controls="store-grid"
                    tabIndex={isActive ? 0 : -1}
                    onClick={() => setCategory(storeCategory)}
                    onKeyDown={handleCategoryKeyDown}
                    className={`inline-flex items-center gap-1.5 rounded-xl px-3 py-2 text-sm font-semibold transition focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary ${
                      isActive
                        ? 'bg-primary text-on-primary shadow-lg shadow-primary/20'
                        : 'text-on-surface-variant hover:bg-surface-container-high hover:text-on-surface'
                    }`}
                  >
                    {t(`store.categories.${storeCategory}`)}
                    <span
                      className={`rounded-full px-1.5 py-0.5 text-[10px] font-semibold ${
                        isActive
                          ? 'bg-on-primary/20 text-on-primary'
                          : 'bg-surface-container-high text-on-surface-variant'
                      }`}
                    >
                      {categoryCounts[storeCategory]}
                    </span>
                  </button>
                );
              })}
            </div>
          )}

        {successName !== null && (
          <div
            role="status"
            className="mt-6 flex items-start justify-between gap-3 rounded-xl border border-primary/30 bg-primary-container px-4 py-3 text-sm text-on-primary-container"
          >
            <p className="leading-relaxed">
              {t('store.installSuccess', { name: successName })}
            </p>
            <button
              type="button"
              onClick={() => setSuccessName(null)}
              aria-label={t('store.dismiss')}
              title={t('store.dismiss')}
              className="rounded-md p-0.5 transition hover:bg-on-primary-container/10 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
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
        )}

        {registryQuery.isPending ? (
          <>
            <span className="sr-only">{t('store.loading')}</span>
            <StoreSkeleton />
          </>
        ) : registryQuery.isError ? (
          <div
            role="alert"
            className="mt-8 rounded-2xl border border-error/30 bg-error-container p-6 text-on-error-container"
          >
            <h2 className="font-display text-lg font-bold">
              {t('store.errorTitle')}
            </h2>
            <p className="mt-2 text-sm leading-relaxed">
              {getStoreErrorMessage(registryQuery.error, 'store.errors.load')}
            </p>
            <button
              type="button"
              onClick={() => {
                void registryQuery.refetch();
              }}
              className="mt-4 rounded-lg bg-primary px-4 py-2 text-sm font-semibold text-on-primary transition hover:brightness-95 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
            >
              {t('store.retry')}
            </button>
          </div>
        ) : allSkills.length === 0 ? (
          <div className="mt-8 rounded-2xl border border-dashed border-outline px-6 py-16 text-center">
            <div
              aria-hidden="true"
              className="mx-auto grid size-14 place-items-center rounded-2xl border border-primary/20 bg-primary-container text-on-primary-container"
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
                <path d="M6 7h12l1 13H5L6 7Z" />
                <path d="M9 7a3 3 0 0 1 6 0" />
              </svg>
            </div>
            <h2 className="mt-4 font-display text-xl font-bold text-on-surface">
              {t('store.emptyTitle')}
            </h2>
            <p className="mx-auto mt-2 max-w-md text-sm text-on-surface-variant">
              {t('store.emptyBody')}
            </p>
          </div>
        ) : (
          <div
            id="store-grid"
            role="tabpanel"
            aria-labelledby={`store-category-${category}`}
          >
            {visibleSkills.length === 0 ? (
              <div className="mt-8 rounded-2xl border border-dashed border-outline px-6 py-14 text-center">
                <h2 className="font-display text-xl font-bold text-on-surface">
                  {t('store.categories.emptyTitle')}
                </h2>
                <p className="mx-auto mt-2 max-w-md text-sm text-on-surface-variant">
                  {t('store.categories.emptyBody')}
                </p>
                <button
                  type="button"
                  onClick={() => setCategory('all')}
                  className="mt-4 rounded-xl bg-primary px-4 py-2.5 text-sm font-semibold text-on-primary transition hover:brightness-95 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
                >
                  {t('store.categories.reset')}
                </button>
              </div>
            ) : (
              <ul className="mt-8 grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
                {visibleSkills.map((skill) => (
                  <StoreSkillCard
                    key={skill.name}
                    skill={skill}
                    isInstalled={installedNames.has(skill.name)}
                    isInstalling={
                      installMutation.isPending &&
                      installMutation.variables?.skill.name === skill.name
                    }
                    isDisabled={installMutation.isPending}
                    onInstall={handleInstall}
                  />
                ))}
              </ul>
            )}
          </div>
        )}
      </main>

      {pendingSkill !== null && vetterReport !== null && (
        <VetterWarningModal
          open
          skillName={pendingSkill.name}
          report={vetterReport}
          isInstalling={installMutation.isPending}
          onCancel={closeVetter}
          onConfirm={handleConfirmInstall}
        />
      )}

      {notice !== null && <ErrorToast message={notice} onClose={clearNotice} />}
    </div>
  );
}

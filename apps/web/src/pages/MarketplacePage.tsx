import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, NavLink } from 'react-router-dom';
import { Brand } from '../components/Brand';
import { ErrorToast } from '../components/ErrorToast';
import { LanguageSwitcher } from '../components/LanguageSwitcher';
import {
  MarketplacePrice,
  MarketplaceSkillModal,
} from '../components/MarketplaceSkillModal';
import { StatusToast } from '../components/StatusToast';
import { ThemeToggle } from '../components/ThemeToggle';
import {
  fetchMarketplaceSkills,
  installMarketplaceSkill,
  MarketplaceError,
  MARKETPLACE_PRICING_MODELS,
  MARKETPLACE_TRACK_IDS,
  type MarketplaceFilters,
  type MarketplaceInstallResult,
  type MarketplaceListResponse,
  type MarketplacePricingModel,
  type MarketplaceSkill,
  type MarketplaceTrackId,
} from '../lib/marketplace';
import { isAdminRole } from '../lib/roles';
import { useAuthStore } from '../store/auth.store';

const SEARCH_DEBOUNCE_MS = 300;
const marketplaceRootKey = ['marketplace', 'skills'] as const;

interface Notice {
  tone: 'success' | 'error';
  message: string;
}

function navLinkClasses({ isActive }: { isActive: boolean }): string {
  return `rounded-lg px-3 py-2 text-sm font-medium transition focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary ${
    isActive
      ? 'bg-primary-container text-on-primary-container'
      : 'text-on-surface-variant hover:bg-surface-container-high hover:text-on-surface'
  }`;
}

function errorKey(error: unknown): string {
  const code = error instanceof MarketplaceError ? error.code : 'unknown';

  return `marketplace.errors.${code}`;
}

function ShieldIcon({ checked }: { checked: boolean }) {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="size-3.5 shrink-0"
    >
      <path d="M12 3 4.5 6v5.5c0 4.8 3.1 8.2 7.5 9.5 4.4-1.3 7.5-4.7 7.5-9.5V6L12 3Z" />
      {checked ? <path d="m9 12 2 2 4-4" /> : null}
    </svg>
  );
}

function SkillCard({
  skill,
  isInstalling,
  onInstall,
  onOpen,
}: {
  skill: MarketplaceSkill;
  isInstalling: boolean;
  onInstall: (skill: MarketplaceSkill) => void;
  onOpen: (skill: MarketplaceSkill) => void;
}) {
  const { t } = useTranslation();

  return (
    <li className="h-full">
      <article
        onClick={() => onOpen(skill)}
        className="flex h-full cursor-pointer flex-col rounded-2xl border border-outline-variant bg-surface-container p-5 shadow-sm transition hover:border-primary/30 hover:shadow-md focus-within:border-primary/40"
      >
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <h2
              className="truncate font-display text-lg font-bold text-on-surface"
              title={skill.name}
            >
              {skill.name}
            </h2>
            <p className="mt-1 text-xs text-on-surface-variant">
              {t('skills.versionAuthor', {
                version: skill.version,
                author: skill.authorName,
              })}
            </p>
          </div>
          <span
            className={`inline-flex shrink-0 items-center gap-1 rounded-full px-2.5 py-1 text-[11px] font-medium ${
              skill.verified
                ? 'bg-primary-container text-on-primary-container'
                : 'border border-outline-variant text-on-surface-variant'
            }`}
          >
            <ShieldIcon checked={skill.verified} />
            {skill.verified
              ? t('marketplace.verifiedBadge')
              : t('marketplace.unverifiedBadge')}
          </span>
        </div>

        <p className="mt-3 line-clamp-3 text-sm leading-relaxed text-on-surface-variant">
          {skill.description}
        </p>

        <ul className="mt-4 flex flex-wrap gap-1.5">
          {skill.trackIds.map((track) => (
            <li
              key={track}
              className="rounded-lg bg-surface-container-high px-2 py-1 text-[11px] font-medium text-on-surface-variant"
            >
              {track} · {t(`marketplace.tracks.${track}`)}
            </li>
          ))}
        </ul>

        <div className="mt-auto flex flex-wrap items-end justify-between gap-3 pt-5">
          <div>
            <p className="font-display text-base font-bold text-on-surface">
              <MarketplacePrice skill={skill} />
            </p>
            <p className="mt-0.5 text-xs text-on-surface-variant">
              {t('marketplace.downloads', { count: skill.downloadsCount })}
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={(event) => {
                event.stopPropagation();
                onOpen(skill);
              }}
              className="rounded-lg px-2 py-2 text-sm font-medium text-on-surface-variant transition hover:text-on-surface focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
            >
              {t('marketplace.details.action')}
            </button>
            <button
              type="button"
              disabled={skill.installed === true || isInstalling}
              onClick={(event) => {
                event.stopPropagation();
                onInstall(skill);
              }}
              className="rounded-lg bg-primary px-3.5 py-2 text-sm font-semibold text-on-primary transition hover:brightness-95 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary disabled:cursor-default disabled:bg-surface-container-high disabled:text-on-surface-variant"
            >
              {skill.installed === true
                ? t('marketplace.install.installed')
                : isInstalling
                  ? t('marketplace.install.installing')
                  : t('marketplace.install.action')}
            </button>
          </div>
        </div>
      </article>
    </li>
  );
}

function MarketplaceSkeleton() {
  return (
    <ul
      aria-hidden="true"
      className="mt-8 grid gap-4 sm:grid-cols-2 xl:grid-cols-3"
    >
      {[0, 1, 2, 3, 4, 5].map((index) => (
        <li
          key={index}
          className="h-56 animate-pulse rounded-2xl border border-outline-variant bg-surface-container"
        />
      ))}
    </ul>
  );
}

export function MarketplacePage() {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const accessToken = useAuthStore((state) => state.accessToken);
  const isAdmin = isAdminRole(useAuthStore((state) => state.user?.role));
  const [searchInput, setSearchInput] = useState('');
  const [search, setSearch] = useState('');
  const [track, setTrack] = useState<MarketplaceTrackId | null>(null);
  const [pricingModel, setPricingModel] =
    useState<MarketplacePricingModel | null>(null);
  const [verifiedOnly, setVerifiedOnly] = useState(false);
  const [selectedSkill, setSelectedSkill] = useState<MarketplaceSkill | null>(
    null,
  );
  const [notice, setNotice] = useState<Notice | null>(null);

  useEffect(() => {
    const timeoutId = window.setTimeout(() => {
      setSearch(searchInput);
    }, SEARCH_DEBOUNCE_MS);

    return () => window.clearTimeout(timeoutId);
  }, [searchInput]);

  const filters: MarketplaceFilters = {
    ...(search !== '' ? { search } : {}),
    ...(track !== null ? { track } : {}),
    ...(pricingModel !== null ? { pricingModel } : {}),
    ...(verifiedOnly ? { verified: true } : {}),
  };
  const queryKey = [...marketplaceRootKey, filters] as const;

  const skillsQuery = useQuery<MarketplaceListResponse, unknown>({
    queryKey,
    queryFn: () => fetchMarketplaceSkills(filters),
    enabled: accessToken !== null,
    staleTime: 30_000,
  });

  const installMutation = useMutation<
    MarketplaceInstallResult,
    unknown,
    MarketplaceSkill
  >({
    mutationFn: (skill) => installMarketplaceSkill(skill.slug),
    onSuccess: (result, skill) => {
      // Бэкенд пока не возвращает `installed` в списке — сохраняем флаг в кэше.
      queryClient.setQueryData<MarketplaceListResponse>(queryKey, (current) =>
        current === undefined
          ? current
          : {
              ...current,
              items: current.items.map((item) =>
                item.slug === skill.slug
                  ? {
                      ...item,
                      installed: true,
                      downloadsCount:
                        result.downloadsCount ?? item.downloadsCount + 1,
                    }
                  : item,
              ),
            },
      );
      setSelectedSkill((current) =>
        current?.slug === skill.slug
          ? { ...current, installed: true }
          : current,
      );
      setNotice({
        tone: 'success',
        message: t('marketplace.install.success', { name: skill.name }),
      });
    },
    onError: (error) => {
      setNotice({ tone: 'error', message: t(errorKey(error)) });
    },
  });

  const skills = skillsQuery.data?.items ?? [];

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
              <NavLink to="/app/team" className={navLinkClasses}>
                {t('nav.team')}
              </NavLink>
              <NavLink to="/app/marketplace" className={navLinkClasses}>
                {t('nav.marketplace')}
              </NavLink>
              <NavLink to="/app/store" className={navLinkClasses}>
                {t('nav.store')}
              </NavLink>
              <NavLink to="/app/office" className={navLinkClasses}>
                {t('nav.office')}
              </NavLink>
              <NavLink to="/app/builder" className={navLinkClasses}>
                {t('nav.builder')}
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
              {t('marketplace.title')}
            </h1>
            <p className="mt-2 max-w-2xl text-sm leading-relaxed text-on-surface-variant">
              {t('marketplace.subtitle')}
            </p>
          </div>
          {skillsQuery.data !== undefined && (
            <span className="rounded-full border border-outline-variant bg-surface-container px-3 py-1 text-xs font-medium text-on-surface-variant">
              {t('marketplace.count', { count: skillsQuery.data.total })}
            </span>
          )}
        </div>

        <div className="mt-8 space-y-5 rounded-2xl border border-outline-variant bg-surface-container p-4 sm:p-5">
          <div>
            <label
              htmlFor="marketplace-search"
              className="mb-1.5 block text-xs font-semibold uppercase tracking-wide text-on-surface-variant"
            >
              {t('marketplace.searchLabel')}
            </label>
            <input
              id="marketplace-search"
              type="search"
              value={searchInput}
              onChange={(event) => setSearchInput(event.target.value)}
              placeholder={t('marketplace.searchPlaceholder')}
              className="w-full rounded-xl border border-outline-variant bg-surface px-3 py-2.5 text-sm text-on-surface placeholder:text-outline focus:border-primary focus:outline-2 focus:outline-offset-1 focus:outline-primary"
            />
          </div>

          <div>
            <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-on-surface-variant">
              {t('marketplace.tracksLabel')}
            </p>
            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                aria-pressed={track === null}
                onClick={() => setTrack(null)}
                className={`rounded-full border px-3 py-1.5 text-xs font-medium transition focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary ${
                  track === null
                    ? 'border-primary bg-primary-container text-on-primary-container'
                    : 'border-outline-variant text-on-surface-variant hover:border-primary/40 hover:text-on-surface'
                }`}
              >
                {t('marketplace.tracks.all')}
              </button>
              {MARKETPLACE_TRACK_IDS.map((id) => (
                <button
                  key={id}
                  type="button"
                  aria-pressed={track === id}
                  onClick={() => setTrack(id)}
                  className={`rounded-full border px-3 py-1.5 text-xs font-medium transition focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary ${
                    track === id
                      ? 'border-primary bg-primary-container text-on-primary-container'
                      : 'border-outline-variant text-on-surface-variant hover:border-primary/40 hover:text-on-surface'
                  }`}
                >
                  {id} · {t(`marketplace.tracks.${id}`)}
                </button>
              ))}
            </div>
          </div>

          <div className="flex flex-wrap items-end gap-4">
            <div>
              <label
                htmlFor="marketplace-pricing"
                className="mb-1.5 block text-xs font-semibold uppercase tracking-wide text-on-surface-variant"
              >
                {t('marketplace.pricingLabel')}
              </label>
              <select
                id="marketplace-pricing"
                value={pricingModel ?? ''}
                onChange={(event) =>
                  setPricingModel(
                    event.target.value === ''
                      ? null
                      : (event.target.value as MarketplacePricingModel),
                  )
                }
                className="rounded-xl border border-outline-variant bg-surface px-3 py-2.5 text-sm text-on-surface focus:border-primary focus:outline-2 focus:outline-offset-1 focus:outline-primary"
              >
                <option value="">{t('marketplace.pricingModels.all')}</option>
                {MARKETPLACE_PRICING_MODELS.map((model) => (
                  <option key={model} value={model}>
                    {t(`marketplace.pricingModels.${model}`)}
                  </option>
                ))}
              </select>
            </div>

            <label className="inline-flex cursor-pointer items-center gap-2 pb-2.5 text-sm text-on-surface-variant">
              <input
                type="checkbox"
                checked={verifiedOnly}
                onChange={(event) => setVerifiedOnly(event.target.checked)}
                className="size-4 accent-primary"
              />
              {t('marketplace.verifiedOnly')}
            </label>
          </div>
        </div>

        {skillsQuery.isPending ? (
          <>
            <span className="sr-only">{t('marketplace.loading')}</span>
            <MarketplaceSkeleton />
          </>
        ) : skillsQuery.isError ? (
          <div
            role="alert"
            className="mt-8 rounded-2xl border border-error/30 bg-error-container p-6 text-on-error-container"
          >
            <h2 className="font-display text-lg font-bold">
              {t('marketplace.errorTitle')}
            </h2>
            <p className="mt-2 text-sm leading-relaxed">
              {t(errorKey(skillsQuery.error))}
            </p>
            <button
              type="button"
              onClick={() => {
                void skillsQuery.refetch();
              }}
              className="mt-4 rounded-lg bg-primary px-4 py-2 text-sm font-semibold text-on-primary transition hover:brightness-95 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
            >
              {t('marketplace.retry')}
            </button>
          </div>
        ) : skills.length === 0 ? (
          <div className="mt-8 rounded-2xl border border-dashed border-outline px-6 py-16 text-center">
            <h2 className="font-display text-xl font-bold text-on-surface">
              {t('marketplace.emptyTitle')}
            </h2>
            <p className="mx-auto mt-2 max-w-md text-sm text-on-surface-variant">
              {t('marketplace.emptyBody')}
            </p>
          </div>
        ) : (
          <ul className="mt-8 grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
            {skills.map((skill) => (
              <SkillCard
                key={skill.id}
                skill={skill}
                isInstalling={
                  installMutation.isPending &&
                  installMutation.variables?.slug === skill.slug
                }
                onInstall={(item) => installMutation.mutate(item)}
                onOpen={setSelectedSkill}
              />
            ))}
          </ul>
        )}
      </main>

      <MarketplaceSkillModal
        skill={selectedSkill}
        onClose={() => setSelectedSkill(null)}
      />

      {notice !== null && (
        <>
          {notice.tone === 'success' ? (
            <StatusToast
              message={notice.message}
              tone="success"
              onClose={() => setNotice(null)}
            />
          ) : (
            <ErrorToast message={notice.message} onClose={() => setNotice(null)} />
          )}
        </>
      )}
    </div>
  );
}

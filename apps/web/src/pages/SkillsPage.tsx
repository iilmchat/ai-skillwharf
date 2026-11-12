import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useCallback, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, NavLink } from 'react-router-dom';
import { Brand } from '../components/Brand';
import { ErrorToast } from '../components/ErrorToast';
import { LanguageSwitcher } from '../components/LanguageSwitcher';
import { ThemeToggle } from '../components/ThemeToggle';
import { skillsQueryKey, useSkills } from '../hooks/useSkills';
import {
  getSkillsErrorMessage,
  toggleSkill,
  type InstalledSkill,
  type SkillPricing,
} from '../lib/skills';
import { formatMoney, getCurrencySymbol } from '../lib/money';

interface ToggleContext {
  previous: InstalledSkill[] | undefined;
}

function navLinkClasses({ isActive }: { isActive: boolean }): string {
  return `rounded-lg px-3 py-2 text-sm font-medium transition focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary ${
    isActive
      ? 'bg-primary-container text-on-primary-container'
      : 'text-on-surface-variant hover:bg-surface-container-high hover:text-on-surface'
  }`;
}

function SkillSwitch({
  checked,
  disabled,
  label,
  onChange,
}: {
  checked: boolean;
  disabled: boolean;
  label: string;
  onChange: (checked: boolean) => void;
}) {
  return (
    <label
      className={`relative inline-flex shrink-0 items-center ${
        disabled ? 'cursor-not-allowed' : 'cursor-pointer'
      }`}
    >
      <input
        type="checkbox"
        role="switch"
        className="peer sr-only"
        checked={checked}
        disabled={disabled}
        aria-label={label}
        onChange={(event) => onChange(event.target.checked)}
      />
      <span
        aria-hidden="true"
        className="relative block h-6 w-11 rounded-full bg-on-surface-variant transition-colors peer-checked:bg-primary peer-focus-visible:outline-2 peer-focus-visible:outline-offset-2 peer-focus-visible:outline-primary peer-disabled:opacity-50 after:absolute after:left-0.5 after:top-0.5 after:size-5 after:rounded-full after:bg-surface after:shadow-sm after:transition-transform after:content-[''] peer-checked:after:translate-x-5"
      />
    </label>
  );
}

function StatusBadge({ enabled }: { enabled: boolean }) {
  const { t } = useTranslation();

  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium ${
        enabled
          ? 'bg-primary-container text-on-primary-container'
          : 'border border-outline-variant bg-surface-container-high text-on-surface-variant'
      }`}
    >
      <span
        aria-hidden="true"
        className={`size-1.5 rounded-full ${
          enabled ? 'bg-primary' : 'bg-outline'
        }`}
      />
      {enabled ? t('skills.enabled') : t('skills.disabled')}
    </span>
  );
}

function PricingBadge({ pricing }: { pricing: SkillPricing | undefined }) {
  const { t, i18n } = useTranslation();
  const isPayPerCall =
    pricing?.model === 'Pay-per-Call' && typeof pricing.price === 'number';
  let label: string = t('skills.pricing.free');

  if (isPayPerCall) {
    label = t('skills.pricing.payPerCall', {
      price: formatMoney(String(pricing.price), i18n.language),
      currency: getCurrencySymbol(pricing.currency),
    });
  } else if (pricing?.model === 'Subscription') {
    label = t('skills.pricing.subscription');
  } else if (pricing?.model === 'Freemium') {
    label = t('skills.pricing.freemium');
  }

  return (
    <span
      className={`inline-flex items-center rounded-full px-2.5 py-1 text-xs font-medium ${
        isPayPerCall
          ? 'bg-tertiary-container text-on-tertiary-container'
          : 'bg-surface-container-high text-on-surface-variant'
      }`}
    >
      {label}
    </span>
  );
}

function SkillCard({
  skill,
  isToggling,
  onToggle,
}: {
  skill: InstalledSkill;
  isToggling: boolean;
  onToggle: (id: string, isEnabled: boolean) => void;
}) {
  const { t } = useTranslation();
  const description = skill.manifest.description;

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
              {t('skills.versionAuthor', {
                version: skill.version,
                author: skill.author,
              })}
            </p>
          </div>

          <SkillSwitch
            checked={skill.isEnabled}
            disabled={isToggling}
            label={t('skills.toggleLabel', { name: skill.name })}
            onChange={(isEnabled) => onToggle(skill.id, isEnabled)}
          />
        </div>

        {description !== undefined && (
          <p className="mt-3 line-clamp-3 text-sm leading-relaxed text-on-surface-variant">
            {description}
          </p>
        )}

        <div className="mt-auto flex flex-wrap items-center gap-2 pt-5">
          <StatusBadge enabled={skill.isEnabled} />
          <PricingBadge pricing={skill.manifest.pricing} />
        </div>
      </article>
    </li>
  );
}

function SkillsSkeleton() {
  return (
    <ul
      aria-hidden="true"
      className="mt-8 grid gap-4 sm:grid-cols-2 xl:grid-cols-3"
    >
      {[0, 1, 2, 3, 4, 5].map((index) => (
        <li
          key={index}
          className="h-48 animate-pulse rounded-2xl border border-outline-variant bg-surface-container"
        />
      ))}
    </ul>
  );
}

export function SkillsPage() {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const skillsQuery = useSkills();
  const [notice, setNotice] = useState<string | null>(null);

  const clearNotice = useCallback(() => setNotice(null), []);

  const toggleMutation = useMutation<
    InstalledSkill,
    unknown,
    { id: string; isEnabled: boolean },
    ToggleContext
  >({
    mutationFn: ({ id, isEnabled }) => toggleSkill({ id, isEnabled }),
    onMutate: async ({ id, isEnabled }) => {
      await queryClient.cancelQueries({ queryKey: skillsQueryKey });

      const previous =
        queryClient.getQueryData<InstalledSkill[]>(skillsQueryKey);

      queryClient.setQueryData<InstalledSkill[]>(skillsQueryKey, (current) =>
        current?.map((skill) =>
          skill.id === id ? { ...skill, isEnabled } : skill,
        ),
      );

      return { previous };
    },
    onSuccess: (updated) => {
      queryClient.setQueryData<InstalledSkill[]>(skillsQueryKey, (current) =>
        current?.map((skill) => (skill.id === updated.id ? updated : skill)),
      );
    },
    onError: (error, _variables, context) => {
      if (context?.previous !== undefined) {
        queryClient.setQueryData(skillsQueryKey, context.previous);
      }

      setNotice(getSkillsErrorMessage(error, 'skills.errors.toggle'));
    },
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: skillsQueryKey });
    },
  });

  const skills = skillsQuery.data ?? [];

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
              to="/chat"
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
              <NavLink to="/chat" className={navLinkClasses}>
                {t('nav.chat')}
              </NavLink>
              <NavLink to="/skills" className={navLinkClasses}>
                {t('nav.skills')}
              </NavLink>
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
              {t('skills.title')}
            </h1>
            <p className="mt-2 max-w-2xl text-sm leading-relaxed text-on-surface-variant">
              {t('skills.subtitle')}
            </p>
          </div>

          {skillsQuery.data !== undefined && (
            <span className="rounded-full border border-outline-variant bg-surface-container px-3 py-1 text-xs font-medium text-on-surface-variant">
              {t('skills.count', { count: skills.length })}
            </span>
          )}
        </div>

        {skillsQuery.isPending ? (
          <>
            <span className="sr-only">{t('skills.loading')}</span>
            <SkillsSkeleton />
          </>
        ) : skillsQuery.isError ? (
          <div
            role="alert"
            className="mt-8 rounded-2xl border border-error/30 bg-error-container p-6 text-on-error-container"
          >
            <h2 className="font-display text-lg font-bold">
              {t('skills.errorTitle')}
            </h2>
            <p className="mt-2 text-sm leading-relaxed">
              {getSkillsErrorMessage(skillsQuery.error, 'skills.errors.load')}
            </p>
            <button
              type="button"
              onClick={() => {
                void skillsQuery.refetch();
              }}
              className="mt-4 rounded-lg bg-primary px-4 py-2 text-sm font-semibold text-on-primary transition hover:brightness-95 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
            >
              {t('skills.retry')}
            </button>
          </div>
        ) : skills.length === 0 ? (
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
                <path d="M4 6h16M4 12h16M4 18h10" />
                <circle cx="19" cy="18" r="2" />
              </svg>
            </div>
            <h2 className="mt-4 font-display text-xl font-bold text-on-surface">
              {t('skills.emptyTitle')}
            </h2>
            <p className="mx-auto mt-2 max-w-md text-sm text-on-surface-variant">
              {t('skills.emptyBody')}
            </p>
          </div>
        ) : (
          <ul className="mt-8 grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
            {skills.map((skill) => (
              <SkillCard
                key={skill.id}
                skill={skill}
                isToggling={toggleMutation.isPending}
                onToggle={(id, isEnabled) => {
                  toggleMutation.mutate({ id, isEnabled });
                }}
              />
            ))}
          </ul>
        )}
      </main>

      {notice !== null && <ErrorToast message={notice} onClose={clearNotice} />}
    </div>
  );
}

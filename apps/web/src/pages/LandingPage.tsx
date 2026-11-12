import {
  motion,
  MotionConfig,
  useReducedMotion,
  type Variants,
} from 'framer-motion';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { Brand } from '../components/Brand';
import { LanguageSwitcher } from '../components/LanguageSwitcher';
import { ThemeToggle } from '../components/ThemeToggle';
import { useAuthStore } from '../store/auth.store';

type FeatureId = 'sandbox' | 'billing' | 'skills';
type PreviewStatus = 'idle' | 'working' | 'waiting_approval';

interface PreviewAgent {
  name: string;
  roleKey: string;
  status: PreviewStatus;
}

const FEATURE_IDS: readonly FeatureId[] = ['sandbox', 'billing', 'skills'];

const CURRENT_YEAR = new Date().getFullYear();

const PREVIEW_AGENTS: readonly PreviewAgent[] = [
  {
    name: 'Nova',
    roleKey: 'office.agents.nova.role',
    status: 'working',
  },
  {
    name: 'Leo',
    roleKey: 'office.agents.leo.role',
    status: 'waiting_approval',
  },
  {
    name: 'Iris',
    roleKey: 'office.agents.iris.role',
    status: 'idle',
  },
];

const PREVIEW_ICON: Record<PreviewStatus, string> = {
  idle: '☕',
  working: '💻',
  waiting_approval: '✋',
};

const PREVIEW_BADGE: Record<PreviewStatus, string> = {
  idle: 'bg-surface-container-high text-on-surface-variant',
  working: 'bg-primary-container text-on-primary-container',
  waiting_approval: 'bg-warning-container text-on-warning-container',
};

const staggerVariants: Variants = {
  hidden: {},
  show: {
    transition: { staggerChildren: 0.08, delayChildren: 0.04 },
  },
};

const fadeUpVariants: Variants = {
  hidden: { opacity: 0, y: 22 },
  show: {
    opacity: 1,
    y: 0,
    transition: { duration: 0.5, ease: 'easeOut' },
  },
};

function FeatureIcon({ id }: { id: FeatureId }) {
  if (id === 'sandbox') {
    return (
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
        <path d="M12 3 5 6v5c0 4 3 7.5 7 9 4-1.5 7-5 7-9V6l-7-3Z" />
        <path d="m9.5 10.5 2 2-2 2M13.5 14.5H16" />
      </svg>
    );
  }

  if (id === 'billing') {
    return (
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
        <rect x="3" y="6" width="18" height="12" rx="2" />
        <path d="M3 10h18M7 14h3" />
      </svg>
    );
  }

  return (
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
      <path d="M14 17h6M17 14v6" />
    </svg>
  );
}

export function LandingPage() {
  const { t } = useTranslation();
  const accessToken = useAuthStore((state) => state.accessToken);
  const shouldReduceMotion = useReducedMotion();
  const isAuthenticated = accessToken !== null;
  const primaryHref = isAuthenticated ? '/app/chat' : '/login';
  const primaryLabel = isAuthenticated
    ? t('landing.goToChat')
    : t('landing.primaryCta');
  const headerLabel = isAuthenticated
    ? t('landing.goToChat')
    : t('landing.login');

  return (
    <MotionConfig reducedMotion="user">
      <div className="min-h-svh bg-surface text-on-surface">
        <header className="sticky top-0 z-30 border-b border-outline-variant/70 bg-surface/80 backdrop-blur-xl">
          <div className="mx-auto flex h-16 max-w-6xl items-center justify-between gap-3 px-4 sm:px-6">
            <div className="flex min-w-0 items-center gap-6">
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

              <nav
                aria-label={t('nav.primary')}
                className="hidden items-center gap-5 text-sm font-medium text-on-surface-variant md:flex"
              >
                <a
                  href="#features"
                  className="rounded-md px-1 py-1 transition hover:text-on-surface focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
                >
                  {t('landing.nav.features')}
                </a>
                <Link
                  to="/app/office"
                  className="rounded-md px-1 py-1 transition hover:text-on-surface focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
                >
                  {t('landing.nav.office')}
                </Link>
              </nav>
            </div>

            <div className="flex shrink-0 items-center gap-2">
              <LanguageSwitcher />
              <ThemeToggle />
              <Link
                to={primaryHref}
                className="inline-flex items-center justify-center rounded-xl bg-primary px-3.5 py-2 text-sm font-semibold text-on-primary shadow-lg shadow-primary/20 transition hover:brightness-95 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
              >
                {headerLabel}
              </Link>
            </div>
          </div>
        </header>

        <main>
          <section
            aria-labelledby="landing-hero-title"
            className="relative overflow-hidden"
          >
            <div
              aria-hidden="true"
              className="brand-grid pointer-events-none absolute inset-0"
            />
            <div
              aria-hidden="true"
              className="pointer-events-none absolute -top-32 left-1/2 h-96 w-[48rem] -translate-x-1/2 rounded-full bg-primary/15 blur-3xl"
            />
            <div
              aria-hidden="true"
              className="pointer-events-none absolute right-0 top-48 size-80 translate-x-1/3 rounded-full bg-tertiary/10 blur-3xl"
            />

            <div className="relative mx-auto grid max-w-6xl gap-14 px-4 pb-20 pt-14 sm:px-6 lg:grid-cols-[1.05fr_0.95fr] lg:items-center lg:gap-10 lg:pb-28 lg:pt-24">
              <motion.div
                initial="hidden"
                animate="show"
                variants={staggerVariants}
              >
                <motion.p
                  variants={fadeUpVariants}
                  className="inline-flex items-center gap-2 rounded-full border border-tertiary/30 bg-tertiary-container px-3 py-1.5 text-xs font-medium text-on-tertiary-container"
                >
                  <span
                    aria-hidden="true"
                    className="size-1.5 rounded-full bg-tertiary"
                  />
                  {t('landing.badge')}
                </motion.p>

                <motion.h1
                  id="landing-hero-title"
                  variants={fadeUpVariants}
                  className="mt-6 max-w-2xl text-balance font-display text-4xl font-bold leading-[1.08] tracking-tight text-on-surface sm:text-5xl lg:text-6xl"
                >
                  {t('landing.titleLead')}{' '}
                  <span className="whitespace-nowrap bg-linear-to-r from-primary via-primary to-tertiary bg-clip-text text-transparent">
                    {t('landing.titleAccent')}
                  </span>{' '}
                  {t('landing.titleTail')}
                </motion.h1>

                <motion.p
                  variants={fadeUpVariants}
                  className="mt-6 max-w-xl text-base leading-relaxed text-on-surface-variant sm:text-lg"
                >
                  {t('landing.subtitle')}
                </motion.p>

                <motion.div
                  variants={fadeUpVariants}
                  className="mt-9 flex flex-col gap-3 sm:flex-row"
                >
                  <Link
                    to={primaryHref}
                    className="inline-flex items-center justify-center gap-2 rounded-xl bg-primary px-6 py-3.5 text-sm font-semibold text-on-primary shadow-xl shadow-primary/25 transition hover:brightness-95 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary active:brightness-95"
                  >
                    {primaryLabel}
                    <svg
                      aria-hidden="true"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="1.8"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      className="size-4"
                    >
                      <path d="M5 12h14M13 6l6 6-6 6" />
                    </svg>
                  </Link>
                  <Link
                    to="/app/office"
                    className="inline-flex items-center justify-center gap-2 rounded-xl border border-outline bg-surface-container px-6 py-3.5 text-sm font-semibold text-on-surface transition hover:border-primary/40 hover:bg-surface-container-high focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
                  >
                    <span
                      aria-hidden="true"
                      className="grid size-5 place-items-center rounded-full bg-primary-container text-on-primary-container"
                    >
                      <svg
                        viewBox="0 0 20 20"
                        fill="currentColor"
                        className="size-3"
                      >
                        <path d="M7 4.5v11l8-5.5-8-5.5Z" />
                      </svg>
                    </span>
                    {t('landing.secondaryCta')}
                  </Link>
                </motion.div>

                <motion.p
                  variants={fadeUpVariants}
                  className="mt-6 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs font-medium text-on-surface-variant"
                >
                  <span className="inline-flex items-center gap-1.5">
                    <span
                      aria-hidden="true"
                      className="size-1.5 rounded-full bg-primary"
                    />
                    {t('landing.meta.sandbox')}
                  </span>
                  <span aria-hidden="true">·</span>
                  <span className="inline-flex items-center gap-1.5">
                    <span
                      aria-hidden="true"
                      className="size-1.5 rounded-full bg-tertiary"
                    />
                    {t('landing.meta.billing')}
                  </span>
                  <span aria-hidden="true">·</span>
                  <span className="inline-flex items-center gap-1.5">
                    <span
                      aria-hidden="true"
                      className="size-1.5 rounded-full bg-success"
                    />
                    {t('landing.meta.skills')}
                  </span>
                </motion.p>
              </motion.div>

              <motion.div
                initial={{ opacity: 0, y: 28 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.65, delay: 0.15, ease: 'easeOut' }}
                className="relative mx-auto w-full max-w-lg lg:max-w-none"
              >
                <div
                  aria-hidden="true"
                  className="absolute -inset-6 rounded-[2.5rem] bg-linear-to-br from-primary/20 via-tertiary/10 to-transparent blur-2xl"
                />

                <motion.div
                  animate={
                    shouldReduceMotion === true
                      ? undefined
                      : { y: [0, -10, 0] }
                  }
                  transition={{
                    duration: 7,
                    repeat: Infinity,
                    ease: 'easeInOut',
                  }}
                  className="relative overflow-hidden rounded-3xl border border-outline-variant bg-surface-container/85 p-5 shadow-2xl shadow-primary/10 backdrop-blur"
                >
                  <div className="flex items-center justify-between gap-3 border-b border-outline-variant pb-4">
                    <div className="flex min-w-0 items-center gap-3">
                      <span
                        aria-hidden="true"
                        className="grid size-9 shrink-0 place-items-center rounded-xl bg-primary-container text-on-primary-container"
                      >
                        <svg
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
                      </span>
                      <div className="min-w-0">
                        <p className="truncate text-sm font-semibold text-on-surface">
                          {t('landing.preview.title')}
                        </p>
                        <p className="truncate text-xs text-on-surface-variant">
                          {t('landing.preview.subtitle')}
                        </p>
                      </div>
                    </div>

                    <span className="inline-flex shrink-0 items-center gap-1.5 rounded-full border border-success/30 bg-success/10 px-2.5 py-1 text-[11px] font-semibold text-success">
                      <span
                        aria-hidden="true"
                        className="size-1.5 animate-pulse rounded-full bg-success"
                      />
                      {t('landing.preview.live')}
                    </span>
                  </div>

                  <ul className="mt-3 space-y-2">
                    {PREVIEW_AGENTS.map((agent) => (
                      <li
                        key={agent.name}
                        className="flex items-center gap-3 rounded-xl border border-outline-variant/70 bg-surface/70 p-3"
                      >
                        <span
                          aria-hidden="true"
                          className="grid size-9 shrink-0 place-items-center rounded-lg bg-surface-container-high text-base"
                        >
                          {PREVIEW_ICON[agent.status]}
                        </span>
                        <div className="min-w-0 flex-1">
                          <p className="truncate text-sm font-semibold text-on-surface">
                            {agent.name}
                          </p>
                          <p className="truncate text-xs text-on-surface-variant">
                            {t(agent.roleKey)}
                          </p>
                        </div>
                        <span
                          className={`inline-flex shrink-0 items-center rounded-full px-2.5 py-1 text-[11px] font-semibold ${PREVIEW_BADGE[agent.status]}`}
                        >
                          {t(`office.status.${agent.status}`)}
                        </span>
                      </li>
                    ))}
                  </ul>

                  <Link
                    to="/app/office"
                    className="mt-3 flex items-center justify-between gap-3 rounded-xl bg-primary-container/60 px-3 py-2.5 text-xs font-medium text-on-primary-container transition hover:bg-primary-container focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
                  >
                    <span>
                      {t('landing.preview.waiting', { count: 1 })}
                    </span>
                    <span className="inline-flex items-center gap-1 font-semibold">
                      {t('landing.preview.openOffice')}
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
                  </Link>
                </motion.div>

                <motion.div
                  animate={
                    shouldReduceMotion === true
                      ? undefined
                      : { y: [0, 6, 0] }
                  }
                  transition={{
                    duration: 5.5,
                    repeat: Infinity,
                    ease: 'easeInOut',
                  }}
                  className="absolute -bottom-5 -left-3 hidden items-center gap-2 rounded-xl border border-warning/40 bg-warning-container px-3 py-2 text-xs font-semibold text-on-warning-container shadow-lg sm:flex"
                >
                  <span aria-hidden="true">✋</span>
                  {t('landing.preview.approval')}
                </motion.div>
              </motion.div>
            </div>
          </section>

          <section
            id="features"
            aria-labelledby="landing-features-title"
            className="relative border-y border-outline-variant/70 bg-surface-container/40"
          >
            <div className="mx-auto max-w-6xl px-4 py-20 sm:px-6 lg:py-24">
              <motion.div
                initial="hidden"
                animate="show"
                variants={staggerVariants}
                className="max-w-2xl"
              >
                <motion.p
                  variants={fadeUpVariants}
                  className="text-xs font-semibold uppercase tracking-[0.18em] text-primary"
                >
                  {t('landing.features.eyebrow')}
                </motion.p>
                <motion.h2
                  id="landing-features-title"
                  variants={fadeUpVariants}
                  className="mt-3 font-display text-3xl font-bold tracking-tight text-on-surface sm:text-4xl"
                >
                  {t('landing.features.title')}
                </motion.h2>
                <motion.p
                  variants={fadeUpVariants}
                  className="mt-3 text-base leading-relaxed text-on-surface-variant"
                >
                  {t('landing.features.subtitle')}
                </motion.p>
              </motion.div>

              <motion.ul
                initial="hidden"
                animate="show"
                variants={staggerVariants}
                className="mt-10 grid gap-4 md:grid-cols-3"
              >
                {FEATURE_IDS.map((featureId) => (
                  <motion.li
                    key={featureId}
                    variants={fadeUpVariants}
                    className="h-full"
                  >
                    <article className="group flex h-full flex-col rounded-2xl border border-outline-variant bg-surface p-6 shadow-sm transition hover:-translate-y-0.5 hover:border-primary/30 hover:shadow-xl hover:shadow-primary/5">
                      <span className="grid size-11 place-items-center rounded-xl bg-primary-container text-on-primary-container transition group-hover:bg-primary group-hover:text-on-primary">
                        <FeatureIcon id={featureId} />
                      </span>
                      <h3 className="mt-5 font-display text-lg font-bold text-on-surface">
                        {t(`landing.features.${featureId}.title`)}
                      </h3>
                      <p className="mt-2 text-sm leading-relaxed text-on-surface-variant">
                        {t(`landing.features.${featureId}.description`)}
                      </p>
                    </article>
                  </motion.li>
                ))}
              </motion.ul>
            </div>
          </section>

          <section aria-labelledby="landing-cta-title">
            <div className="mx-auto max-w-6xl px-4 py-20 sm:px-6">
              <div className="relative overflow-hidden rounded-3xl border border-primary/20 bg-linear-to-br from-primary-container via-surface-container to-tertiary-container px-6 py-12 text-center shadow-xl shadow-primary/5 sm:px-12">
                <div
                  aria-hidden="true"
                  className="pointer-events-none absolute -top-24 left-1/2 size-72 -translate-x-1/2 rounded-full bg-primary/20 blur-3xl"
                />
                <div
                  aria-hidden="true"
                  className="pointer-events-none absolute -bottom-24 right-0 size-64 rounded-full bg-tertiary/20 blur-3xl"
                />

                <div className="relative">
                  <h2
                    id="landing-cta-title"
                    className="text-balance font-display text-3xl font-bold tracking-tight text-on-surface sm:text-4xl"
                  >
                    {t('landing.cta.title')}
                  </h2>
                  <p className="mx-auto mt-3 max-w-xl text-sm leading-relaxed text-on-surface-variant sm:text-base">
                    {t('landing.cta.subtitle')}
                  </p>
                  <div className="mt-7 flex flex-col justify-center gap-3 sm:flex-row">
                    <Link
                      to={primaryHref}
                      className="inline-flex items-center justify-center gap-2 rounded-xl bg-primary px-6 py-3.5 text-sm font-semibold text-on-primary shadow-lg shadow-primary/25 transition hover:brightness-95 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
                    >
                      {primaryLabel}
                    </Link>
                    <Link
                      to="/app/office"
                      className="inline-flex items-center justify-center gap-2 rounded-xl border border-outline bg-surface/80 px-6 py-3.5 text-sm font-semibold text-on-surface transition hover:border-primary/40 hover:bg-surface focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
                    >
                      {t('landing.cta.secondary')}
                    </Link>
                  </div>
                </div>
              </div>
            </div>
          </section>
        </main>

        <footer className="border-t border-outline-variant/70">
          <div className="mx-auto flex max-w-6xl flex-col gap-5 px-4 py-8 sm:flex-row sm:items-center sm:justify-between sm:px-6">
            <div className="flex items-center gap-3">
              <Brand compact />
              <p className="text-xs text-on-surface-variant">
                {t('landing.footer.tagline')}
              </p>
            </div>
            <p className="text-xs text-on-surface-variant">
              {t('landing.footer.rights', { year: CURRENT_YEAR })}
            </p>
          </div>
        </footer>
      </div>
    </MotionConfig>
  );
}

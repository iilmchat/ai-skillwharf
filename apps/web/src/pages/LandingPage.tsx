import {
  motion,
  MotionConfig,
  useReducedMotion,
  type Variants,
} from 'framer-motion';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { Brand } from '../components/Brand';
import {
  IntegrationIcon,
  type IntegrationLogoProvider,
} from '../components/IntegrationIcon';
import { LanguageSwitcher } from '../components/LanguageSwitcher';
import { ThemeToggle } from '../components/ThemeToggle';
import { useAuthStore } from '../store/auth.store';

type PreviewStatus = 'idle' | 'working' | 'waiting_approval';
type WhyId = 'hitl' | 'outcome' | 'selfHosted';
type TrackId =
  | 'pvz'
  | 'dev'
  | 'ecommerce'
  | 'marketing'
  | 'education'
  | 'content'
  | 'hr'
  | 'documents'
  | 'ocr'
  | 'finance';
type PlatformId =
  | 'telegram'
  | 'google'
  | 'ozon'
  | 'wildberries'
  | 'midjourney'
  | 'tavily'
  | 'tesseract';

interface PreviewAgent {
  name: string;
  roleKey: string;
  status: PreviewStatus;
}

interface LandingTrack {
  id: TrackId;
  letter: string;
  icon: string;
}

interface LandingPlatform {
  id: PlatformId;
  labelKey: string;
}

/**
 * Ссылки лендинга. Документация живёт в репозитории, публичного docs-хоста у
 * проекта нет, поэтому ссылки ведут в GitHub: SPA-роут `/docs` отдал бы
 * index.html вместо документации.
 */
const GITHUB_URL = 'https://github.com/iilmchat/ai-skillwharf';
const DOCS_URL = `${GITHUB_URL}/tree/main/docs`;
const USE_CASES_GUIDE_URL = `${DOCS_URL}/ecosystem/USE-CASES-GUIDE.md`;
const PILOT_EMAIL = 'hello@skillwharf.ru';
const PILOT_MAILTO = `mailto:${PILOT_EMAIL}`;

const WHY_IDS: readonly WhyId[] = ['hitl', 'outcome', 'selfHosted'];

const WHY_ACCENT: Record<WhyId, { card: string; label: string; icon: string }> =
  {
    hitl: {
      card: 'border-warning/30 bg-warning-container/40',
      label: 'text-warning',
      icon: 'bg-warning-container text-on-warning-container',
    },
    outcome: {
      card: 'border-primary/25 bg-primary-container/35',
      label: 'text-primary',
      icon: 'bg-primary-container text-on-primary-container',
    },
    selfHosted: {
      card: 'border-tertiary/25 bg-tertiary-container/40',
      label: 'text-tertiary',
      icon: 'bg-tertiary-container text-on-tertiary-container',
    },
  };

const TRACKS: readonly LandingTrack[] = [
  { id: 'pvz', letter: 'A', icon: '📦' },
  { id: 'dev', letter: 'B', icon: '🛠️' },
  { id: 'ecommerce', letter: 'C', icon: '🛒' },
  { id: 'marketing', letter: 'D', icon: '🎨' },
  { id: 'education', letter: 'E', icon: '🎓' },
  { id: 'content', letter: 'F', icon: '📝' },
  { id: 'hr', letter: 'G', icon: '👥' },
  { id: 'documents', letter: 'H', icon: '📄' },
  { id: 'ocr', letter: 'I', icon: '🔍' },
  { id: 'finance', letter: 'J', icon: '📊' },
];

const PLATFORMS: readonly LandingPlatform[] = [
  { id: 'telegram', labelKey: 'landing.ecosystem.items.telegram' },
  { id: 'google', labelKey: 'landing.ecosystem.items.google' },
  { id: 'ozon', labelKey: 'landing.ecosystem.items.ozon' },
  { id: 'wildberries', labelKey: 'landing.ecosystem.items.wildberries' },
  { id: 'midjourney', labelKey: 'landing.ecosystem.items.midjourney' },
  { id: 'tavily', labelKey: 'landing.ecosystem.items.tavily' },
  { id: 'tesseract', labelKey: 'landing.ecosystem.items.tesseract' },
];

const KNOWN_PROVIDERS: readonly IntegrationLogoProvider[] = [
  'telegram',
  'google',
  'ozon',
  'wildberries',
  'midjourney',
];

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

function PillarIcon({ id }: { id: WhyId }) {
  if (id === 'hitl') {
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
        <path d="M8 12V5.5a1.5 1.5 0 0 1 3 0V11" />
        <path d="M11 11V4.5a1.5 1.5 0 0 1 3 0V11" />
        <path d="M14 11V6.5a1.5 1.5 0 0 1 3 0V14a6 6 0 0 1-6 6h-1a6 6 0 0 1-6-6v-2.5a1.5 1.5 0 0 1 3 0V13" />
      </svg>
    );
  }

  if (id === 'outcome') {
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
        <path d="M5 4h14v13l-3-2-2 2-2-2-2 2-2-2-3 2V4Z" />
        <path d="M9 9h6M9 13h3" />
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
      <rect x="3" y="4" width="18" height="7" rx="2" />
      <rect x="3" y="14" width="18" height="6" rx="2" />
      <path d="M7 7.5h2M7 17h2" />
      <path d="M15 7.5h2M15 17h2" />
    </svg>
  );
}

function PlatformBadge({ id, label }: { id: PlatformId; label: string }) {
  const isProvider = (KNOWN_PROVIDERS as readonly string[]).includes(id);

  return (
    <div className="flex h-full items-center gap-2.5 rounded-xl border border-outline-variant bg-surface px-3 py-2.5 shadow-sm">
      <span className="grid size-8 shrink-0 place-items-center rounded-lg border border-outline-variant bg-surface-container-high text-on-surface">
        {isProvider ? (
          <IntegrationIcon
            provider={id as IntegrationLogoProvider}
            className="size-4"
          />
        ) : (
          <span
            aria-hidden="true"
            className={`inline-grid size-4 place-items-center rounded text-[7px] font-bold leading-none text-white ${
              id === 'tavily' ? 'bg-[#0F766E]' : 'bg-[#374151]'
            }`}
          >
            {id === 'tavily' ? 'TV' : 'TC'}
          </span>
        )}
      </span>
      <span className="text-xs font-medium leading-snug text-on-surface">
        {label}
      </span>
    </div>
  );
}

export function LandingPage() {
  const { t } = useTranslation();
  const accessToken = useAuthStore((state) => state.accessToken);
  const shouldReduceMotion = useReducedMotion();
  const isAuthenticated = accessToken !== null;
  const headerHref = isAuthenticated ? '/app/chat' : '/login';
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
                  href="#why"
                  className="rounded-md px-1 py-1 transition hover:text-on-surface focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
                >
                  {t('landing.nav.why')}
                </a>
                <a
                  href="#tracks"
                  className="rounded-md px-1 py-1 transition hover:text-on-surface focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
                >
                  {t('landing.nav.tracks')}
                </a>
                <a
                  href="#ecosystem"
                  className="rounded-md px-1 py-1 transition hover:text-on-surface focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
                >
                  {t('landing.nav.ecosystem')}
                </a>
                <a
                  href="#marketplace"
                  className="rounded-md px-1 py-1 transition hover:text-on-surface focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
                >
                  {t('landing.nav.marketplace')}
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
                to={headerHref}
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
                  <a
                    href={PILOT_MAILTO}
                    className="inline-flex items-center justify-center gap-2 rounded-xl bg-primary px-6 py-3.5 text-sm font-semibold text-on-primary shadow-xl shadow-primary/25 transition hover:brightness-95 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary active:brightness-95"
                  >
                    {t('landing.primaryCta')}
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
                  </a>
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
                    {t('landing.meta.tracks')}
                  </span>
                  <span aria-hidden="true">·</span>
                  <span className="inline-flex items-center gap-1.5">
                    <span
                      aria-hidden="true"
                      className="size-1.5 rounded-full bg-tertiary"
                    />
                    {t('landing.meta.outcome')}
                  </span>
                  <span aria-hidden="true">·</span>
                  <span className="inline-flex items-center gap-1.5">
                    <span
                      aria-hidden="true"
                      className="size-1.5 rounded-full bg-success"
                    />
                    {t('landing.meta.hosted')}
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
                    shouldReduceMotion === true ? undefined : { y: [0, -10, 0] }
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
                    <span>{t('landing.preview.waiting', { count: 1 })}</span>
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
                    shouldReduceMotion === true ? undefined : { y: [0, 6, 0] }
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
            id="why"
            aria-labelledby="landing-why-title"
            className="relative"
          >
            <div className="mx-auto max-w-6xl px-4 py-20 sm:px-6 lg:py-24">
              <motion.div
                initial="hidden"
                animate="show"
                variants={staggerVariants}
                className="max-w-2xl"
              >
                <motion.h2
                  id="landing-why-title"
                  variants={fadeUpVariants}
                  className="text-balance font-display text-3xl font-bold tracking-tight text-on-surface sm:text-4xl"
                >
                  {t('landing.why.title')}
                </motion.h2>
              </motion.div>

              <motion.ul
                initial="hidden"
                animate="show"
                variants={staggerVariants}
                className="mt-10 grid gap-4 md:grid-cols-3"
              >
                {WHY_IDS.map((whyId) => {
                  const accent = WHY_ACCENT[whyId];

                  return (
                    <motion.li
                      key={whyId}
                      variants={fadeUpVariants}
                      className="h-full"
                    >
                      <article
                        className={`flex h-full flex-col rounded-2xl border p-6 ${accent.card}`}
                      >
                        <span
                          className={`inline-flex self-start rounded-xl p-2.5 ${accent.icon}`}
                        >
                          <PillarIcon id={whyId} />
                        </span>
                        <h3 className="mt-4 font-display text-xl font-bold leading-snug text-on-surface">
                          {t(`landing.why.${whyId}.title`)}
                        </h3>
                        <p className="mt-2 text-sm leading-relaxed text-on-surface-variant">
                          {t(`landing.why.${whyId}.description`)}
                        </p>
                      </article>
                    </motion.li>
                  );
                })}
              </motion.ul>
            </div>
          </section>

          <section
            id="tracks"
            aria-labelledby="landing-tracks-title"
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
                  {t('landing.tracks.eyebrow')}
                </motion.p>
                <motion.h2
                  id="landing-tracks-title"
                  variants={fadeUpVariants}
                  className="mt-3 text-balance font-display text-3xl font-bold tracking-tight text-on-surface sm:text-4xl"
                >
                  {t('landing.tracks.title')}
                </motion.h2>
              </motion.div>

              <motion.ul
                initial="hidden"
                animate="show"
                variants={staggerVariants}
                className="mt-10 grid gap-4 sm:grid-cols-2 lg:grid-cols-3"
              >
                {TRACKS.map((track) => (
                  <motion.li
                    key={track.id}
                    variants={fadeUpVariants}
                    className="h-full"
                  >
                    <article className="group flex h-full flex-col rounded-2xl border border-outline-variant bg-surface p-5 shadow-sm transition hover:-translate-y-0.5 hover:border-primary/30 hover:shadow-xl hover:shadow-primary/5">
                      <div className="flex items-start justify-between gap-3">
                        <span
                          aria-hidden="true"
                          className="grid size-10 place-items-center rounded-xl bg-primary-container text-lg text-on-primary-container transition group-hover:bg-primary group-hover:text-on-primary"
                        >
                          {track.icon}
                        </span>
                        <span
                          aria-hidden="true"
                          className="inline-grid size-6 place-items-center rounded-full border border-outline-variant bg-surface-container-high text-[11px] font-semibold text-on-surface-variant"
                        >
                          {track.letter}
                        </span>
                      </div>

                      <h3 className="mt-4 font-display text-lg font-bold text-on-surface">
                        {t(`landing.tracks.items.${track.id}.name`)}
                      </h3>
                      <p className="mt-1.5 text-sm leading-relaxed text-on-surface-variant">
                        {t(`landing.tracks.items.${track.id}.description`)}
                      </p>

                      <p className="mt-auto flex flex-wrap items-baseline gap-x-1.5 gap-y-1 pt-4 text-xs leading-relaxed text-on-surface-variant">
                        <span className="text-[11px] font-semibold uppercase tracking-[0.14em] text-primary">
                          {t('landing.tracks.featureLabel')}
                        </span>
                        {t(`landing.tracks.items.${track.id}.feature`)}
                      </p>
                    </article>
                  </motion.li>
                ))}
              </motion.ul>
            </div>
          </section>

          <section
            id="ecosystem"
            aria-labelledby="landing-ecosystem-title"
            className="relative"
          >
            <div className="mx-auto max-w-6xl px-4 py-20 sm:px-6 lg:py-24">
              <div className="grid gap-10 lg:grid-cols-[0.95fr_1.05fr] lg:items-center">
                <motion.div
                  initial="hidden"
                  animate="show"
                  variants={staggerVariants}
                  className="max-w-xl"
                >
                  <motion.p
                    variants={fadeUpVariants}
                    className="text-xs font-semibold uppercase tracking-[0.18em] text-primary"
                  >
                    {t('landing.ecosystem.eyebrow')}
                  </motion.p>
                  <motion.h2
                    id="landing-ecosystem-title"
                    variants={fadeUpVariants}
                    className="mt-3 text-balance font-display text-2xl font-bold tracking-tight text-on-surface sm:text-3xl"
                  >
                    {t('landing.ecosystem.title')}
                  </motion.h2>
                  <motion.p
                    variants={fadeUpVariants}
                    className="mt-4 flex items-start gap-2 text-sm leading-relaxed text-on-surface-variant"
                  >
                    <svg
                      aria-hidden="true"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="1.7"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      className="mt-0.5 size-4 shrink-0 text-primary"
                    >
                      <rect x="4" y="10" width="16" height="10" rx="2" />
                      <path d="M8 10V7a4 4 0 0 1 8 0v3" />
                    </svg>
                    {t('landing.ecosystem.note')}
                  </motion.p>
                </motion.div>

                <motion.ul
                  initial="hidden"
                  animate="show"
                  variants={staggerVariants}
                  className="grid grid-cols-2 gap-3 sm:grid-cols-3"
                >
                  {PLATFORMS.map((platform) => (
                    <motion.li
                      key={platform.id}
                      variants={fadeUpVariants}
                      className="h-full"
                    >
                      <PlatformBadge
                        id={platform.id}
                        label={t(platform.labelKey)}
                      />
                    </motion.li>
                  ))}
                </motion.ul>
              </div>
            </div>
          </section>

          <section
            id="marketplace"
            aria-labelledby="landing-marketplace-title"
            className="relative"
          >
            <div className="mx-auto max-w-6xl px-4 pb-20 sm:px-6 lg:pb-24">
              <div className="relative overflow-hidden rounded-3xl border border-primary/20 bg-linear-to-br from-primary-container via-surface-container to-tertiary-container px-6 py-12 shadow-xl shadow-primary/5 sm:px-12">
                <div
                  aria-hidden="true"
                  className="pointer-events-none absolute -top-24 left-1/2 size-72 -translate-x-1/2 rounded-full bg-primary/20 blur-3xl"
                />
                <div
                  aria-hidden="true"
                  className="pointer-events-none absolute -bottom-24 right-0 size-64 rounded-full bg-tertiary/20 blur-3xl"
                />

                <div className="relative max-w-2xl">
                  <span className="inline-flex items-center gap-1.5 rounded-full border border-primary/25 bg-surface/70 px-3 py-1 text-[11px] font-semibold uppercase tracking-wide text-primary">
                    <span
                      aria-hidden="true"
                      className="size-1.5 rounded-full bg-primary"
                    />
                    {t('landing.marketplace.eyebrow')}
                  </span>
                  <h2
                    id="landing-marketplace-title"
                    className="mt-4 text-balance font-display text-3xl font-bold tracking-tight text-on-surface sm:text-4xl"
                  >
                    {t('landing.marketplace.title')}
                  </h2>
                  <p className="mt-3 text-sm leading-relaxed text-on-surface-variant sm:text-base">
                    {t('landing.marketplace.description')}
                  </p>
                  <a
                    href={USE_CASES_GUIDE_URL}
                    target="_blank"
                    rel="noreferrer"
                    className="mt-7 inline-flex items-center justify-center gap-2 rounded-xl bg-primary px-6 py-3.5 text-sm font-semibold text-on-primary shadow-lg shadow-primary/25 transition hover:brightness-95 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
                  >
                    {t('landing.marketplace.cta')}
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
                      <path d="M7 17 17 7M9 7h8v8" />
                    </svg>
                  </a>
                </div>
              </div>
            </div>
          </section>
        </main>

        <footer className="border-t border-outline-variant/70">
          <div className="mx-auto flex max-w-6xl flex-col gap-6 px-4 py-8 sm:flex-row sm:items-center sm:justify-between sm:px-6">
            <div className="flex items-center gap-3">
              <Brand compact />
              <p className="text-xs leading-relaxed text-on-surface-variant">
                {t('landing.footer.rights', { year: CURRENT_YEAR })}
              </p>
            </div>
            <nav
              aria-label={t('landing.footer.linksLabel')}
              className="flex flex-wrap items-center gap-x-5 gap-y-2 text-xs font-medium text-on-surface-variant"
            >
              <a
                href={GITHUB_URL}
                target="_blank"
                rel="noreferrer"
                className="transition hover:text-on-surface focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
              >
                {t('landing.footer.github')}
              </a>
              <a
                href={DOCS_URL}
                target="_blank"
                rel="noreferrer"
                className="transition hover:text-on-surface focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
              >
                {t('landing.footer.docs')}
              </a>
              <a
                href={PILOT_MAILTO}
                className="transition hover:text-on-surface focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
              >
                {t('landing.footer.pilot', { email: PILOT_EMAIL })}
              </a>
            </nav>
          </div>
        </footer>
      </div>
    </MotionConfig>
  );
}

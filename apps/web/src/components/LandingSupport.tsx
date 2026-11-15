import { useTranslation } from 'react-i18next';

export interface LandingSupportProps {
  /** Страница CloudTips. Пустая строка — секция не показывается. */
  url: string;
  /** QR-код со ссылкой на ту же страницу (статический SVG в `public/`). */
  qrSrc?: string;
}

const POINT_IDS = ['hosting', 'gpu', 'traffic', 'experiments'] as const;

const POINT_LABEL: Record<(typeof POINT_IDS)[number], string> = {
  hosting: '01',
  gpu: '02',
  traffic: '03',
  experiments: '04',
};

/**
 * Секция «Поддержка»: добровольный разовый платёж через CloudTips.
 *
 * Платёжную форму держит внешний сервис, сайт лишь ссылается на неё — данные
 * карты сюда не попадают, поэтому лендинг остаётся статическим.
 */
export function LandingSupport({ url, qrSrc }: LandingSupportProps) {
  const { t } = useTranslation();

  if (url === '') {
    return null;
  }

  return (
    <section
      id="support"
      aria-labelledby="landing-support-title"
      className="relative scroll-mt-24"
    >
      <div className="mx-auto max-w-6xl px-4 pb-20 sm:px-6 lg:pb-24">
        <div className="grid gap-10 lg:grid-cols-[minmax(0,1fr)_minmax(0,26rem)] lg:gap-14">
          <div>
            <span className="inline-flex items-center gap-1.5 rounded-full border border-tertiary/30 bg-tertiary-container/40 px-3 py-1 text-[11px] font-semibold uppercase tracking-wide text-tertiary">
              <span
                aria-hidden="true"
                className="size-1.5 rounded-full bg-tertiary"
              />
              {t('landing.support.eyebrow')}
            </span>
            <h2
              id="landing-support-title"
              className="mt-4 text-balance font-display text-3xl font-bold tracking-tight text-on-surface sm:text-4xl"
            >
              {t('landing.support.title')}
            </h2>
            <p className="mt-4 max-w-xl text-sm leading-relaxed text-on-surface-variant sm:text-base">
              {t('landing.support.description')}
            </p>

            <ol className="mt-8 space-y-5">
              {POINT_IDS.map((id) => (
                <li
                  key={id}
                  className="flex gap-4 border-t border-outline-variant/60 pt-5 first:border-t-0 first:pt-0"
                >
                  <span className="font-display text-sm font-bold text-tertiary">
                    {POINT_LABEL[id]}
                  </span>
                  <div>
                    <p className="text-sm font-semibold text-on-surface">
                      {t(`landing.support.points.${id}.title`)}
                    </p>
                    <p className="mt-1 text-sm leading-relaxed text-on-surface-variant">
                      {t(`landing.support.points.${id}.text`)}
                    </p>
                  </div>
                </li>
              ))}
            </ol>

            <p className="mt-6 text-xs leading-relaxed text-on-surface-variant">
              {t('landing.support.footer')}
            </p>
          </div>

          <div className="rounded-3xl border border-outline-variant bg-surface-container/70 p-6 shadow-xl shadow-primary/5 sm:p-7">
            <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-on-surface-variant">
              {t('landing.support.formEyebrow')}
            </p>
            <h3 className="mt-2 font-display text-xl font-bold text-on-surface">
              {t('landing.support.formTitle')}
            </h3>
            <p className="mt-3 text-sm leading-relaxed text-on-surface-variant">
              {t('landing.support.formText')}
            </p>

            <a
              href={url}
              target="_blank"
              rel="noreferrer"
              className="mt-6 inline-flex w-full items-center justify-center gap-2 rounded-xl bg-primary px-6 py-3 text-sm font-semibold text-on-primary shadow-lg shadow-primary/25 transition hover:brightness-95 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary active:brightness-95"
            >
              {t('landing.support.cta')}
            </a>

            {qrSrc !== undefined && (
              <div className="mt-5 flex items-center gap-4 rounded-2xl border border-outline-variant bg-surface p-4">
                <img
                  src={qrSrc}
                  alt={t('landing.support.qrAlt')}
                  width={96}
                  height={96}
                  className="size-24 shrink-0"
                  loading="lazy"
                />
                <div>
                  <p className="text-sm font-semibold text-on-surface">
                    {t('landing.support.qrTitle')}
                  </p>
                  <p className="mt-1 text-xs leading-relaxed text-on-surface-variant">
                    {t('landing.support.qrText')}
                  </p>
                </div>
              </div>
            )}

            <p className="mt-4 text-[11px] leading-relaxed text-on-surface-variant">
              {t('landing.support.note')}
            </p>
          </div>
        </div>
      </div>
    </section>
  );
}

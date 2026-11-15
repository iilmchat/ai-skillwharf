import { useState } from 'react';
import { useTranslation } from 'react-i18next';

export interface LandingContactProps {
  /** Адрес, на который уходит заявка. Пустая строка — форма не показывается. */
  email: string;
  /** Ссылка на публичный репозиторий — выводится в списке контактов. */
  githubUrl: string;
  /** Сайт проекта — выводится в списке контактов. */
  siteUrl: string;
}

/**
 * Секция «Связаться с нами»: текст, контакты и форма заявки.
 *
 * Серверной формы у статического лендинга нет: кнопка собирает письмо
 * (`mailto:`) из заполненных полей и открывает почтовый клиент. Так не нужно
 * хранить персональные данные, ставить капчу и держать бэкенд ради одной формы.
 */
export function LandingContact({
  email,
  githubUrl,
  siteUrl,
}: LandingContactProps) {
  const { t } = useTranslation();
  const [name, setName] = useState('');
  const [from, setFrom] = useState('');
  const [task, setTask] = useState('');

  const subject = t('landing.contact.mailSubject', {
    name: name.trim() === '' ? t('landing.contact.mailAnonymous') : name.trim(),
  });
  const body = [
    `${t('landing.contact.nameLabel')}: ${name.trim()}`,
    `${t('landing.contact.emailLabel')}: ${from.trim()}`,
    '',
    `${t('landing.contact.taskLabel')}:`,
    task.trim(),
  ].join('\n');
  const mailto = `mailto:${email}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;

  return (
    <section
      id="contact"
      aria-labelledby="landing-contact-title"
      className="relative scroll-mt-24"
    >
      <div className="mx-auto max-w-6xl px-4 pb-20 sm:px-6 lg:pb-24">
        <div className="grid gap-10 lg:grid-cols-[minmax(0,1fr)_minmax(0,26rem)] lg:gap-14">
          <div>
            <span className="inline-flex items-center gap-1.5 rounded-full border border-tertiary/30 bg-tertiary-container/40 px-3 py-1 text-[11px] font-semibold uppercase tracking-wide text-tertiary">
              {t('landing.contact.eyebrow')}
            </span>
            <h2
              id="landing-contact-title"
              className="mt-4 text-balance font-display text-3xl font-bold tracking-tight text-on-surface sm:text-4xl"
            >
              {t('landing.contact.title')}
            </h2>
            <p className="mt-4 max-w-xl text-sm leading-relaxed text-on-surface-variant sm:text-base">
              {t('landing.contact.description')}
            </p>

            <dl className="mt-8 space-y-3 text-sm">
              <div className="flex flex-wrap gap-x-6 gap-y-1">
                <dt className="w-20 shrink-0 text-[11px] font-semibold uppercase tracking-[0.14em] text-on-surface-variant">
                  {t('landing.contact.emailRow')}
                </dt>
                <dd>
                  <a
                    href={`mailto:${email}`}
                    className="font-medium text-on-surface underline-offset-4 hover:text-primary hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
                  >
                    {email}
                  </a>
                </dd>
              </div>
              <div className="flex flex-wrap gap-x-6 gap-y-1">
                <dt className="w-20 shrink-0 text-[11px] font-semibold uppercase tracking-[0.14em] text-on-surface-variant">
                  {t('landing.contact.githubRow')}
                </dt>
                <dd>
                  <a
                    href={githubUrl}
                    target="_blank"
                    rel="noreferrer"
                    className="font-medium text-on-surface underline-offset-4 hover:text-primary hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
                  >
                    {t('landing.contact.githubValue')}
                  </a>
                </dd>
              </div>
              <div className="flex flex-wrap gap-x-6 gap-y-1">
                <dt className="w-20 shrink-0 text-[11px] font-semibold uppercase tracking-[0.14em] text-on-surface-variant">
                  {t('landing.contact.siteRow')}
                </dt>
                <dd>
                  <a
                    href={siteUrl}
                    className="font-medium text-on-surface underline-offset-4 hover:text-primary hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
                  >
                    {siteUrl.replace(/^https?:\/\//, '')}
                  </a>
                </dd>
              </div>
            </dl>
          </div>

          <form
            className="rounded-3xl border border-outline-variant bg-surface-container/70 p-6 shadow-xl shadow-primary/5 sm:p-7"
            onSubmit={(event) => {
              event.preventDefault();
              window.location.href = mailto;
            }}
          >
            <h3 className="font-display text-xl font-bold text-on-surface">
              {t('landing.contact.formTitle')}
            </h3>

            <label
              htmlFor="contact-name"
              className="mt-5 block text-xs font-semibold text-on-surface"
            >
              {t('landing.contact.nameLabel')}
            </label>
            <input
              id="contact-name"
              name="name"
              autoComplete="name"
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder={t('landing.contact.namePlaceholder')}
              className="mt-2 w-full rounded-xl border border-outline bg-surface px-3.5 py-2.5 text-sm text-on-surface placeholder:text-on-surface-variant/70 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
            />

            <label
              htmlFor="contact-email"
              className="mt-4 block text-xs font-semibold text-on-surface"
            >
              {t('landing.contact.emailFieldLabel')}
            </label>
            <input
              id="contact-email"
              name="email"
              type="email"
              autoComplete="email"
              value={from}
              onChange={(event) => setFrom(event.target.value)}
              placeholder={t('landing.contact.emailPlaceholder')}
              className="mt-2 w-full rounded-xl border border-outline bg-surface px-3.5 py-2.5 text-sm text-on-surface placeholder:text-on-surface-variant/70 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
            />

            <label
              htmlFor="contact-task"
              className="mt-4 block text-xs font-semibold text-on-surface"
            >
              {t('landing.contact.taskLabel')}
            </label>
            <textarea
              id="contact-task"
              name="task"
              rows={4}
              value={task}
              onChange={(event) => setTask(event.target.value)}
              placeholder={t('landing.contact.taskPlaceholder')}
              className="mt-2 w-full resize-y rounded-xl border border-outline bg-surface px-3.5 py-2.5 text-sm text-on-surface placeholder:text-on-surface-variant/70 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
            />

            <button
              type="submit"
              className="mt-6 inline-flex w-full items-center justify-center gap-2 rounded-xl bg-primary px-6 py-3 text-sm font-semibold text-on-primary shadow-lg shadow-primary/25 transition hover:brightness-95 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary active:brightness-95"
            >
              {t('landing.contact.submit')}
            </button>

            <p className="mt-3 text-[11px] leading-relaxed text-on-surface-variant">
              {t('landing.contact.note')}
            </p>
          </form>
        </div>
      </div>
    </section>
  );
}

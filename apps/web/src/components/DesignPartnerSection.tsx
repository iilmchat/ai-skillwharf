import { useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { z } from 'zod';
import {
  buildLeadMailto,
  buildLeadWebhookPayload,
  designPartnerSchema,
  formatLeadMessage,
  submitLeadToWebhook,
  type DesignPartnerLead,
} from '../lib/design-partner';
import {
  findLandingTrack,
  LANDING_TRACK_IDS,
  LANDING_TRACKS,
  type TrackId,
} from '../lib/landing-tracks';

type LeadField = 'name' | 'contact' | 'track' | 'comment';
type LeadStatus = 'idle' | 'submitting' | 'success' | 'error' | 'ready';
type CopyState = 'idle' | 'copied' | 'failed';

const INPUT_CLASSES =
  'mt-2 w-full rounded-xl border border-outline bg-surface px-3.5 py-2.5 text-sm text-on-surface placeholder:text-on-surface-variant/70 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary disabled:cursor-not-allowed disabled:opacity-60';

const FIELD_ERROR_KEYS: Record<LeadField, string> = {
  name: 'landing.designPartner.errors.name',
  contact: 'landing.designPartner.errors.contact',
  track: 'landing.designPartner.errors.track',
  comment: 'landing.designPartner.errors.comment',
};

function isLeadField(value: unknown): value is LeadField {
  return (
    value === 'name' ||
    value === 'contact' ||
    value === 'track' ||
    value === 'comment'
  );
}

/** Первая ошибка Zod на поле → ключ i18n. */
function collectLeadFieldErrors(
  error: z.ZodError,
): Partial<Record<LeadField, string>> {
  const errors: Partial<Record<LeadField, string>> = {};

  for (const issue of error.issues) {
    const field = issue.path[0];

    if (isLeadField(field) && errors[field] === undefined) {
      errors[field] = FIELD_ERROR_KEYS[field];
    }
  }

  return errors;
}

export interface DesignPartnerSectionProps {
  /** Почта для `mailto:` — `VITE_CONTACT_EMAIL`. */
  email: string;
  /** Вебхук заявок `VITE_LEAD_WEBHOOK_URL`; пустая строка — только mailto. */
  webhookUrl: string;
}

/**
 * Секция «Запросить инвайт на пилот» (WEB-24.6).
 *
 * Если задан `VITE_LEAD_WEBHOOK_URL`, форма делает `POST` JSON и показывает
 * ошибку при сбое. Без вебхука (и при его ошибке) заявка не теряется: форма
 * собирает `mailto:` на `VITE_CONTACT_EMAIL` и текст для копирования в
 * Telegram. Персональные данные на лендинге не сохраняются.
 */
export function DesignPartnerSection({
  email,
  webhookUrl,
}: DesignPartnerSectionProps) {
  const { t, i18n } = useTranslation();
  const [name, setName] = useState('');
  const [contact, setContact] = useState('');
  const [trackId, setTrackId] = useState<TrackId | ''>('');
  const [comment, setComment] = useState('');
  const [status, setStatus] = useState<LeadStatus>('idle');
  const [fieldErrors, setFieldErrors] = useState<
    Partial<Record<LeadField, string>>
  >({});
  const [preparedLead, setPreparedLead] = useState<DesignPartnerLead | null>(
    null,
  );
  const [copyState, setCopyState] = useState<CopyState>('idle');

  const labels = {
    title: t('landing.designPartner.messageTitle'),
    name: t('landing.designPartner.nameLabel'),
    contact: t('landing.designPartner.contactLabel'),
    track: t('landing.designPartner.trackLabel'),
    comment: t('landing.designPartner.commentLabel'),
    emptyComment: t('landing.designPartner.emptyComment'),
  };

  const preparedTrack =
    preparedLead === null ? undefined : findLandingTrack(preparedLead.track);
  const preparedMessage =
    preparedLead === null || preparedTrack === undefined
      ? ''
      : formatLeadMessage(
          preparedLead,
          `${preparedTrack.letter} — ${t(`landing.tracks.items.${preparedTrack.id}.name`)}`,
          labels,
        );
  const mailtoHref =
    preparedLead === null
      ? ''
      : buildLeadMailto(
          email,
          t('landing.designPartner.mailSubject', { name: preparedLead.name }),
          preparedMessage,
        );

  function changeTrack(value: string): void {
    setTrackId(LANDING_TRACK_IDS.find((id) => id === value) ?? '');
    setFieldErrors((current) => ({ ...current, track: undefined }));
  }

  async function handleSubmit(
    event: FormEvent<HTMLFormElement>,
  ): Promise<void> {
    event.preventDefault();
    setFieldErrors({});
    setCopyState('idle');

    const parsed = designPartnerSchema.safeParse({
      name,
      contact,
      track: trackId === '' ? undefined : trackId,
      comment,
    });

    if (!parsed.success) {
      setFieldErrors(collectLeadFieldErrors(parsed.error));

      return;
    }

    setPreparedLead(parsed.data);

    if (webhookUrl === '') {
      setStatus('ready');

      return;
    }

    setStatus('submitting');

    try {
      await submitLeadToWebhook(
        webhookUrl,
        buildLeadWebhookPayload(parsed.data, i18n.language),
      );
      setStatus('success');
    } catch {
      setStatus('error');
    }
  }

  async function copyPreparedLead(): Promise<void> {
    if (preparedMessage === '') {
      return;
    }

    try {
      await navigator.clipboard.writeText(preparedMessage);
      setCopyState('copied');
    } catch {
      setCopyState('failed');
    }
  }

  function resetForm(): void {
    setStatus('idle');
    setPreparedLead(null);
    setCopyState('idle');
    setFieldErrors({});
  }

  const isSubmitting = status === 'submitting';

  return (
    <section
      id="design-partner"
      aria-labelledby="landing-design-partner-title"
      className="relative scroll-mt-24"
    >
      <div className="mx-auto max-w-6xl px-4 pb-20 sm:px-6 lg:pb-24">
        <div className="grid gap-10 lg:grid-cols-[minmax(0,1fr)_minmax(0,26rem)] lg:gap-14">
          <div>
            <span className="inline-flex items-center gap-1.5 rounded-full border border-primary/30 bg-primary-container/40 px-3 py-1 text-[11px] font-semibold uppercase tracking-wide text-primary">
              {t('landing.designPartner.eyebrow')}
            </span>
            <h2
              id="landing-design-partner-title"
              className="mt-4 text-balance font-display text-3xl font-bold tracking-tight text-on-surface sm:text-4xl"
            >
              {t('landing.designPartner.title')}
            </h2>
            <p className="mt-4 max-w-xl text-sm leading-relaxed text-on-surface-variant sm:text-base">
              {t('landing.designPartner.description')}
            </p>
            <p className="mt-6 max-w-xl rounded-2xl border border-outline-variant bg-surface-container/70 px-4 py-3 text-xs leading-relaxed text-on-surface-variant">
              {t('landing.designPartner.note')}
            </p>
          </div>

          <div className="rounded-3xl border border-outline-variant bg-surface-container/70 p-6 shadow-xl shadow-primary/5 sm:p-7">
            {status === 'success' ? (
              <div role="status">
                <p className="text-sm font-semibold text-success">
                  {t('landing.designPartner.successTitle')}
                </p>
                <p className="mt-2 text-sm leading-relaxed text-on-surface-variant">
                  {t('landing.designPartner.successBody')}
                </p>
                <button
                  type="button"
                  onClick={resetForm}
                  className="mt-5 inline-flex items-center justify-center rounded-xl border border-outline bg-surface px-4 py-2.5 text-sm font-semibold text-on-surface transition hover:border-primary/40 hover:bg-surface-container-high focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
                >
                  {t('landing.designPartner.successReset')}
                </button>
              </div>
            ) : (
              <form onSubmit={handleSubmit}>
                <h3 className="font-display text-xl font-bold text-on-surface">
                  {t('landing.designPartner.formTitle')}
                </h3>

                {status === 'error' && (
                  <div
                    role="alert"
                    className="mt-4 rounded-xl border border-error/30 bg-error-container px-3.5 py-3 text-sm leading-relaxed text-on-error-container"
                  >
                    <p className="font-semibold">
                      {t('landing.designPartner.errorTitle')}
                    </p>
                    <p className="mt-1">
                      {t('landing.designPartner.errorBody')}
                    </p>
                  </div>
                )}

                <label
                  htmlFor="lead-name"
                  className="mt-5 block text-xs font-semibold text-on-surface"
                >
                  {t('landing.designPartner.nameLabel')}
                </label>
                <input
                  id="lead-name"
                  name="name"
                  autoComplete="organization"
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                  placeholder={t('landing.designPartner.namePlaceholder')}
                  aria-invalid={fieldErrors.name !== undefined}
                  aria-describedby={
                    fieldErrors.name === undefined
                      ? undefined
                      : 'lead-name-error'
                  }
                  disabled={isSubmitting}
                  className={INPUT_CLASSES}
                />
                {fieldErrors.name !== undefined && (
                  <p
                    id="lead-name-error"
                    role="alert"
                    className="mt-1.5 text-xs text-error"
                  >
                    {t(fieldErrors.name)}
                  </p>
                )}

                <label
                  htmlFor="lead-contact"
                  className="mt-4 block text-xs font-semibold text-on-surface"
                >
                  {t('landing.designPartner.contactLabel')}
                </label>
                <input
                  id="lead-contact"
                  name="contact"
                  autoComplete="off"
                  value={contact}
                  onChange={(event) => setContact(event.target.value)}
                  placeholder={t('landing.designPartner.contactPlaceholder')}
                  aria-invalid={fieldErrors.contact !== undefined}
                  aria-describedby="lead-contact-hint"
                  disabled={isSubmitting}
                  className={INPUT_CLASSES}
                />
                <p
                  id="lead-contact-hint"
                  className="mt-1.5 text-[11px] leading-relaxed text-on-surface-variant"
                >
                  {t('landing.designPartner.contactHint')}
                </p>
                {fieldErrors.contact !== undefined && (
                  <p role="alert" className="mt-1.5 text-xs text-error">
                    {t(fieldErrors.contact)}
                  </p>
                )}

                <label
                  htmlFor="lead-track"
                  className="mt-4 block text-xs font-semibold text-on-surface"
                >
                  {t('landing.designPartner.trackLabel')}
                </label>
                <select
                  id="lead-track"
                  name="track"
                  value={trackId}
                  onChange={(event) => changeTrack(event.target.value)}
                  aria-invalid={fieldErrors.track !== undefined}
                  disabled={isSubmitting}
                  className={INPUT_CLASSES}
                >
                  <option value="">
                    {t('landing.designPartner.trackPlaceholder')}
                  </option>
                  {LANDING_TRACKS.map((track) => (
                    <option key={track.id} value={track.id}>
                      {track.letter} —{' '}
                      {t(`landing.tracks.items.${track.id}.name`)}
                    </option>
                  ))}
                </select>
                {fieldErrors.track !== undefined && (
                  <p role="alert" className="mt-1.5 text-xs text-error">
                    {t(fieldErrors.track)}
                  </p>
                )}

                <label
                  htmlFor="lead-comment"
                  className="mt-4 block text-xs font-semibold text-on-surface"
                >
                  {t('landing.designPartner.commentLabel')}
                </label>
                <textarea
                  id="lead-comment"
                  name="comment"
                  rows={4}
                  value={comment}
                  onChange={(event) => setComment(event.target.value)}
                  placeholder={t('landing.designPartner.commentPlaceholder')}
                  aria-invalid={fieldErrors.comment !== undefined}
                  aria-describedby="lead-comment-hint"
                  disabled={isSubmitting}
                  className={`${INPUT_CLASSES} resize-y`}
                />
                <p
                  id="lead-comment-hint"
                  className="mt-1.5 text-[11px] leading-relaxed text-on-surface-variant"
                >
                  {t('landing.designPartner.commentHint')}
                </p>
                {fieldErrors.comment !== undefined && (
                  <p role="alert" className="mt-1.5 text-xs text-error">
                    {t(fieldErrors.comment)}
                  </p>
                )}

                <button
                  type="submit"
                  disabled={isSubmitting}
                  aria-busy={isSubmitting}
                  className="mt-6 inline-flex w-full items-center justify-center gap-2 rounded-xl bg-primary px-6 py-3 text-sm font-semibold text-on-primary shadow-lg shadow-primary/25 transition hover:brightness-95 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary active:brightness-95 disabled:cursor-not-allowed disabled:opacity-70"
                >
                  {isSubmitting
                    ? t('landing.designPartner.submitting')
                    : t('landing.designPartner.submit')}
                </button>

                {status === 'ready' && (
                  <div
                    role="status"
                    className="mt-4 rounded-xl border border-primary/30 bg-primary-container/30 px-3.5 py-3 text-sm leading-relaxed text-on-primary-container"
                  >
                    <p className="font-semibold">
                      {t('landing.designPartner.readyTitle')}
                    </p>
                    <p className="mt-1 text-xs">
                      {t('landing.designPartner.readyBody')}
                    </p>
                  </div>
                )}

                {preparedLead !== null &&
                  (status === 'ready' || status === 'error') && (
                    <div className="mt-4 rounded-xl border border-outline-variant bg-surface px-3.5 py-3">
                      <div className="flex flex-wrap items-center gap-3">
                        <a
                          href={mailtoHref}
                          className="inline-flex items-center justify-center gap-2 rounded-xl bg-primary px-4 py-2.5 text-sm font-semibold text-on-primary shadow-lg shadow-primary/20 transition hover:brightness-95 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
                        >
                          {t('landing.designPartner.mailto')}
                        </a>
                        <button
                          type="button"
                          onClick={() => {
                            void copyPreparedLead();
                          }}
                          className="inline-flex items-center justify-center gap-2 rounded-xl border border-outline bg-surface-container px-4 py-2.5 text-sm font-semibold text-on-surface transition hover:border-primary/40 hover:bg-surface-container-high focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
                        >
                          {t('landing.designPartner.copy')}
                        </button>
                      </div>

                      {copyState === 'copied' && (
                        <p
                          role="status"
                          className="mt-2 text-xs font-medium text-success"
                        >
                          {t('landing.designPartner.copied')}
                        </p>
                      )}
                      {copyState === 'failed' && (
                        <div className="mt-2">
                          <p role="alert" className="text-xs text-error">
                            {t('landing.designPartner.copyFailed')}
                          </p>
                          <textarea
                            readOnly
                            rows={6}
                            value={preparedMessage}
                            aria-label={t('landing.designPartner.messageTitle')}
                            className={`${INPUT_CLASSES} font-mono text-xs`}
                          />
                        </div>
                      )}
                    </div>
                  )}

                <p className="mt-3 text-[11px] leading-relaxed text-on-surface-variant">
                  {t('landing.designPartner.formNote')}
                </p>
              </form>
            )}
          </div>
        </div>
      </div>
    </section>
  );
}

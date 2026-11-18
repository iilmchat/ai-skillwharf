import { z } from 'zod';
import { LANDING_TRACK_IDS } from './landing-tracks';

/**
 * Заявка Design Partner с лендинга (WEB-24.6).
 *
 * Статический лендинг не имеет своего бэкенда: если при сборке задан
 * `VITE_LEAD_WEBHOOK_URL`, заявка уходит туда JSON-ом; иначе страница
 * формирует `mailto:` на `VITE_CONTACT_EMAIL` и текст для копирования в
 * Telegram. Схема одна для обоих путей, чтобы формы не расходились.
 */

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/i;
/** Telegram `@username`: 4–32 символа, начинается с буквы. */
const TELEGRAM_PATTERN = /^@[A-Za-z][A-Za-z0-9_]{3,31}$/;
/** Телефон в свободном формате: цифры, пробелы, скобки, дефисы, `+`. */
const PHONE_PATTERN = /^\+?[0-9][0-9\s()-]{6,19}$/;

/** Контакт принимается как Telegram, телефон или email. */
export function isSupportedContact(value: string): boolean {
  return (
    EMAIL_PATTERN.test(value) ||
    TELEGRAM_PATTERN.test(value) ||
    PHONE_PATTERN.test(value)
  );
}

export const designPartnerSchema = z.object({
  name: z.string().trim().min(2).max(120),
  contact: z.string().trim().min(3).max(160).refine(isSupportedContact, {
    message: 'ожидается Telegram @username, телефон или email',
  }),
  track: z.enum(LANDING_TRACK_IDS),
  comment: z
    .string()
    .trim()
    .max(2_000)
    .optional()
    .transform((value) => (value === '' ? undefined : value)),
});

export type DesignPartnerLead = z.infer<typeof designPartnerSchema>;

/** Тело POST на `VITE_LEAD_WEBHOOK_URL`. */
export interface LeadWebhookPayload extends DesignPartnerLead {
  source: 'landing';
  language: string;
  submittedAt: string;
}

export function buildLeadWebhookPayload(
  lead: DesignPartnerLead,
  language: string,
  submittedAt: Date = new Date(),
): LeadWebhookPayload {
  return {
    ...lead,
    source: 'landing',
    language,
    submittedAt: submittedAt.toISOString(),
  };
}

/** Подписи письма/сообщения: зависят от языка интерфейса. */
export interface LeadMessageLabels {
  title: string;
  name: string;
  contact: string;
  track: string;
  comment: string;
  emptyComment: string;
}

/**
 * Текст заявки для `mailto:` и копирования в Telegram.
 *
 * `trackLabel` передаёт вызывающий код: он собирает «K — Опт» из локали,
 * чтобы lib оставался свободным от i18n и тестировался без DOM.
 */
export function formatLeadMessage(
  lead: DesignPartnerLead,
  trackLabel: string,
  labels: LeadMessageLabels,
): string {
  const comment =
    lead.comment === undefined || lead.comment === ''
      ? labels.emptyComment
      : lead.comment;

  return [
    labels.title,
    '',
    `${labels.name}: ${lead.name}`,
    `${labels.contact}: ${lead.contact}`,
    `${labels.track}: ${trackLabel}`,
    `${labels.comment}: ${comment}`,
  ].join('\n');
}

/** Готовая ссылка письма с закодированными темой и телом. */
export function buildLeadMailto(
  email: string,
  subject: string,
  body: string,
): string {
  return `mailto:${email}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
}

/**
 * POST заявки на вебхук. Не-2xx считается ошибкой: UI покажет запасной путь
 * (`mailto:`/копирование), чтобы заявка не потерялась.
 */
export async function submitLeadToWebhook(
  url: string,
  payload: LeadWebhookPayload,
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  const response = await fetchImpl(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    throw new Error(`lead webhook responded with ${response.status}`);
  }
}

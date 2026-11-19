import { isAxiosError } from 'axios';
import { z } from 'zod';
import i18n from '../i18n';
import { api } from './api';

/**
 * Портал разработчиков навыков (Sprint 36, WEB-36.3).
 *
 * `GET /developer/skills` — дашборд автора (KPI + список навыков),
 * `POST /developer/skills` — публикация `SKILL.md` с автоматическим аудитом,
 * `PATCH /developer/skills/:slug/payout` — счёт для выплат Revenue Share 85%.
 * Все ответы валидируются Zod; при отказе аудита (400
 * `errors.skill_audit_rejected`) ошибка несёт список замечаний для UI.
 */

export const AUDIT_SEVERITIES = ['critical', 'warning', 'info'] as const;

export const auditFindingSchema = z.object({
  severity: z.enum(AUDIT_SEVERITIES),
  code: z.string().min(1),
  message: z.string().min(1),
});

export type AuditFinding = z.infer<typeof auditFindingSchema>;

export const AUDIT_STATUSES = ['passed', 'warning', 'rejected'] as const;

export const auditStatusSchema = z.enum(AUDIT_STATUSES);

export type AuditStatus = z.infer<typeof auditStatusSchema>;

const decimalAmountSchema = z.coerce.number().finite().nonnegative();

export const developerSkillItemSchema = z.object({
  id: z.string().min(1),
  slug: z.string().min(1),
  name: z.string().min(1),
  version: z.string().min(1),
  pricingModel: z.string().min(1),
  price: decimalAmountSchema,
  downloadsCount: z.number().int().nonnegative(),
  verified: z.boolean(),
  auditStatus: auditStatusSchema,
  auditFindings: z.array(auditFindingSchema).optional(),
  payoutAccountId: z.string().nullable().optional(),
  createdAt: z.string().min(1),
});

export type DeveloperSkillItem = z.infer<typeof developerSkillItemSchema>;

export const developerDashboardSchema = z.object({
  totalSkills: z.number().int().nonnegative(),
  totalDownloads: z.number().int().nonnegative(),
  totalRevenueRub: decimalAmountSchema,
  pendingPayoutRub: decimalAmountSchema,
  skills: z.array(developerSkillItemSchema),
});

export type DeveloperDashboard = z.infer<typeof developerDashboardSchema>;

/** Backend может обернуть дашборд в `{ dashboard }` / `{ data }`. */
const developerDashboardResponseSchema = z.preprocess((value) => {
  if (typeof value === 'object' && value !== null) {
    const record = value as Record<string, unknown>;

    if (typeof record.dashboard === 'object' && record.dashboard !== null) {
      return record.dashboard;
    }
  }

  return value;
}, developerDashboardSchema);

const developerSkillResponseSchema = z.preprocess((value) => {
  if (typeof value === 'object' && value !== null) {
    const record = value as Record<string, unknown>;

    if (typeof record.skill === 'object' && record.skill !== null) {
      return record.skill;
    }
  }

  return value;
}, developerSkillItemSchema);

/** Форма публикации: манифест обязателен, счёт выплат — нет. */
export const publishDeveloperSkillSchema = z
  .object({
    manifestYaml: z.string().trim().min(1).max(128_000),
    payoutAccountId: z.string().trim().min(1).max(256).optional(),
  })
  .strict();

export type PublishDeveloperSkillInput = z.infer<
  typeof publishDeveloperSkillSchema
>;

const SKILL_SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export const developerSkillSlugSchema = z
  .string()
  .trim()
  .min(1)
  .max(128)
  .regex(SKILL_SLUG_PATTERN);

export const payoutAccountSchema = z.string().trim().min(1).max(256);

export const developerPortalQueryKey = ['developer-portal'] as const;

export type DeveloperPortalErrorCode =
  | 'network'
  | 'unavailable'
  | 'sessionExpired'
  | 'forbidden'
  | 'invalidResponse'
  | 'auditRejected'
  | 'publishFailed'
  | 'payoutUpdateFailed'
  | 'unknown';

export interface DeveloperPortalErrorDetails {
  code: DeveloperPortalErrorCode;
  findings: AuditFinding[];
}

/** Ошибка портала с machine-readable кодом и замечаниями аудита. */
export class DeveloperPortalError extends Error
  implements DeveloperPortalErrorDetails
{
  readonly code: DeveloperPortalErrorCode;
  readonly findings: AuditFinding[];

  constructor(
    code: DeveloperPortalErrorCode,
    findings: AuditFinding[] = [],
    message?: string,
  ) {
    super(message ?? code);
    this.name = 'DeveloperPortalError';
    this.code = code;
    this.findings = findings;
  }
}

const auditErrorPayloadSchema = z.object({
  code: z.string().optional(),
  message: z.union([z.string(), z.array(z.string())]).optional(),
  findings: z.array(auditFindingSchema).optional(),
  details: z
    .union([
      z.array(auditFindingSchema),
      z.object({ findings: z.array(auditFindingSchema).optional() }),
    ])
    .optional(),
});

/** Достаёт замечания аудита из тела 400-ответа (findings/details/errors). */
export function parseAuditFindings(data: unknown): AuditFinding[] {
  const parsed = auditErrorPayloadSchema.safeParse(data);

  if (!parsed.success) {
    return [];
  }

  const { findings, details } = parsed.data;

  if (findings !== undefined) {
    return findings;
  }

  if (Array.isArray(details)) {
    return details;
  }

  return details?.findings ?? [];
}

export function isSkillAuditRejected(data: unknown): boolean {
  return isRecord(data) && data.code === 'errors.skill_audit_rejected';
}

function normalizeError(
  error: unknown,
  fallback: DeveloperPortalErrorCode,
): DeveloperPortalError {
  if (error instanceof DeveloperPortalError) {
    return error;
  }

  if (error instanceof z.ZodError) {
    return new DeveloperPortalError('invalidResponse');
  }

  if (!isAxiosError(error)) {
    return new DeveloperPortalError(fallback);
  }

  if (error.response === undefined) {
    return new DeveloperPortalError('network');
  }

  const { status } = error.response;

  if (status === 401) {
    return new DeveloperPortalError('sessionExpired');
  }

  if (status === 403) {
    return new DeveloperPortalError('forbidden');
  }

  if (status === 404 || status === 501 || status === 502 || status === 503) {
    return new DeveloperPortalError('unavailable');
  }

  if (status === 400 || status === 422) {
    const data: unknown = error.response.data;

    if (isSkillAuditRejected(data)) {
      return new DeveloperPortalError('auditRejected', parseAuditFindings(data));
    }
  }

  return new DeveloperPortalError(fallback);
}

export const DEVELOPER_ERROR_KEYS: Record<DeveloperPortalErrorCode, string> = {
  network: 'developerPortal.errors.network',
  unavailable: 'developerPortal.errors.unavailable',
  sessionExpired: 'errors.sessionExpired',
  forbidden: 'developerPortal.errors.forbidden',
  invalidResponse: 'developerPortal.errors.invalidResponse',
  auditRejected: 'errors.skill_audit_rejected',
  publishFailed: 'developerPortal.errors.publishFailed',
  payoutUpdateFailed: 'developerPortal.errors.payoutUpdateFailed',
  unknown: 'developerPortal.errors.unknown',
};

/** Локализованное сообщение по коду ошибки портала. */
export function getDeveloperPortalErrorMessage(error: unknown): string {
  const details =
    error instanceof DeveloperPortalError
      ? error
      : normalizeError(error, 'unknown');

  return i18n.t(DEVELOPER_ERROR_KEYS[details.code]);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/** GET /api/v1/developer/skills — KPI автора и список его навыков. */
export async function fetchDeveloperDashboard(): Promise<DeveloperDashboard> {
  const { data } = await api.get<unknown>('/developer/skills');

  return developerDashboardResponseSchema.parse(data);
}

/** POST /api/v1/developer/skills — публикация с автоматическим аудитом. */
export async function publishDeveloperSkill(
  input: PublishDeveloperSkillInput,
): Promise<DeveloperSkillItem> {
  const body = publishDeveloperSkillSchema.parse(input);

  try {
    const { data } = await api.post<unknown>('/developer/skills', body);

    return developerSkillResponseSchema.parse(data);
  } catch (error) {
    throw normalizeError(error, 'publishFailed');
  }
}

/** PATCH /api/v1/developer/skills/:slug/payout — счёт для выплат. */
export async function updateSkillPayoutAccount(
  slug: string,
  payoutAccountId: string,
): Promise<DeveloperSkillItem> {
  const safeSlug = developerSkillSlugSchema.parse(slug);
  const account = payoutAccountSchema.parse(payoutAccountId);

  try {
    const { data } = await api.patch<unknown>(
      `/developer/skills/${encodeURIComponent(safeSlug)}/payout`,
      { payoutAccountId: account },
    );

    return developerSkillResponseSchema.parse(data);
  } catch (error) {
    throw normalizeError(error, 'payoutUpdateFailed');
  }
}

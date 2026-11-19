import { isAxiosError } from 'axios';
import { z } from 'zod';
import { api } from './api';

/**
 * Контракт витрины маркетплейса (WEB-27.3).
 *
 * Все ответы API валидируются Zod: бэкенд может прислать неожиданную форму,
 * и тогда витрина показывает локализованную ошибку, а не падает на рендере.
 */

/** Бизнес-треки A–L в порядке лендинга. */
export const MARKETPLACE_TRACK_IDS = [
  'A',
  'B',
  'C',
  'D',
  'E',
  'F',
  'G',
  'H',
  'I',
  'J',
  'K',
  'L',
] as const;

export const marketplaceTrackIdSchema = z.enum(MARKETPLACE_TRACK_IDS);
export type MarketplaceTrackId = z.infer<typeof marketplaceTrackIdSchema>;

export const MARKETPLACE_PRICING_MODELS = [
  'Free',
  'Pay-per-Call',
  'Pay-per-Outcome',
  'Freemium',
  'Subscription',
] as const;

export const marketplacePricingModelSchema = z.enum(
  MARKETPLACE_PRICING_MODELS,
);
export type MarketplacePricingModel = z.infer<
  typeof marketplacePricingModelSchema
>;

/** Необязательные поля деталей: бэкенд может не отдавать их пока. */
export const marketplaceSkillSignatureSchema = z.object({
  verified: z.boolean().optional(),
  status: z.string().optional(),
  publicKeyId: z.string().optional(),
});

export const marketplaceSkillSchema = z.object({
  id: z.string(),
  slug: z.string(),
  name: z.string(),
  version: z.string(),
  description: z.string(),
  trackIds: z.array(marketplaceTrackIdSchema),
  authorName: z.string(),
  /** Подпись SKILL.md проверена Ed25519 на бэкенде. */
  verified: z.boolean(),
  pricingModel: marketplacePricingModelSchema,
  // API отдаёт Decimal строкой ("15.00"), наружу отдаём число.
  price: z.coerce.number().nonnegative(),
  downloadsCount: z.number().int().nonnegative(),
  installed: z.boolean().optional(),
  permissions: z.array(z.string()).optional(),
  signature: marketplaceSkillSignatureSchema.optional(),
});

export type MarketplaceSkill = z.infer<typeof marketplaceSkillSchema>;

export const marketplaceListResponseSchema = z.object({
  items: z.array(marketplaceSkillSchema),
  total: z.number().int().nonnegative(),
});

export type MarketplaceListResponse = z.infer<
  typeof marketplaceListResponseSchema
>;

export const marketplaceInstallResponseSchema = z.object({
  installedId: z.string(),
  name: z.string(),
  slug: z.string(),
  downloadsCount: z.number().int().nonnegative().optional(),
});

export type MarketplaceInstallResult = z.infer<
  typeof marketplaceInstallResponseSchema
>;

const marketplaceSlugSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);

export interface MarketplaceFilters {
  search?: string;
  track?: MarketplaceTrackId;
  pricingModel?: MarketplacePricingModel;
  verified?: boolean;
}

/** Категория ошибки: страница сама выбирает локализованный текст по коду. */
export type MarketplaceErrorCode =
  | 'network'
  | 'unavailable'
  | 'sessionExpired'
  | 'forbidden'
  | 'invalidResponse'
  | 'installFailed'
  | 'unknown';

export class MarketplaceError extends Error {
  readonly code: MarketplaceErrorCode;

  constructor(code: MarketplaceErrorCode, message?: string) {
    super(message ?? code);
    this.name = 'MarketplaceError';
    this.code = code;
  }
}

function normalizeError(
  error: unknown,
  fallback: MarketplaceErrorCode,
): MarketplaceError {
  if (error instanceof MarketplaceError) {
    return error;
  }

  if (isAxiosError(error)) {
    if (error.response === undefined) {
      return new MarketplaceError('network');
    }

    // 404/501 — эндпоинт ещё может быть не выкачен: это не crash витрины.
    switch (error.response.status) {
      case 401:
        return new MarketplaceError('sessionExpired');
      case 403:
        return new MarketplaceError('forbidden');
      case 404:
      case 501:
        return new MarketplaceError('unavailable');
      default:
        return new MarketplaceError(fallback);
    }
  }

  return new MarketplaceError(fallback);
}

function buildListParams(filters: MarketplaceFilters): Record<string, string> {
  const params: Record<string, string> = {};
  const search = filters.search?.trim();

  if (search !== undefined && search !== '') {
    params.search = search;
  }

  if (filters.track !== undefined) {
    params.track = filters.track;
  }

  if (filters.pricingModel !== undefined) {
    params.pricingModel = filters.pricingModel;
  }

  if (filters.verified !== undefined) {
    params.verified = String(filters.verified);
  }

  return params;
}

/** GET /api/v1/marketplace/skills с фильтрами витрины. */
export async function fetchMarketplaceSkills(
  filters: MarketplaceFilters = {},
): Promise<MarketplaceListResponse> {
  try {
    const { data } = await api.get<unknown>('/marketplace/skills', {
      params: buildListParams(filters),
    });
    const parsed = marketplaceListResponseSchema.safeParse(data);

    if (!parsed.success) {
      throw new MarketplaceError('invalidResponse');
    }

    return parsed.data;
  } catch (error) {
    throw normalizeError(error, 'invalidResponse');
  }
}

/** POST /api/v1/marketplace/skills/:slug/install — установка в 1 клик. */
export async function installMarketplaceSkill(
  slug: string,
): Promise<MarketplaceInstallResult> {
  const safeSlug = marketplaceSlugSchema.parse(slug);

  try {
    const { data } = await api.post<unknown>(
      `/marketplace/skills/${encodeURIComponent(safeSlug)}/install`,
    );
    const parsed = marketplaceInstallResponseSchema.safeParse(data);

    if (!parsed.success) {
      throw new MarketplaceError('invalidResponse');
    }

    return parsed.data;
  } catch (error) {
    throw normalizeError(error, 'installFailed');
  }
}

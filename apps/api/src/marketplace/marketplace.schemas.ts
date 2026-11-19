import { z } from 'zod';

/** Треки A..L из `docs/ecosystem/Monetization-Matrix.md`. */
export const MARKETPLACE_TRACKS = [
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

export const marketplaceTrackSchema = z.enum(MARKETPLACE_TRACKS);
export type MarketplaceTrack = z.infer<typeof marketplaceTrackSchema>;

export const MARKETPLACE_PRICING_MODELS = [
  'Free',
  'Pay-per-Call',
  'Pay-per-Outcome',
  'Subscription',
  'Freemium',
] as const;

export const marketplacePricingModelSchema = z.enum(MARKETPLACE_PRICING_MODELS);

export const marketplaceStatusSchema = z.enum([
  'published',
  'draft',
  'rejected',
]);

/** Slug в каталоге: нижний регистр, цифры и дефис. */
export const marketplaceSlugSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, 'ожидается kebab-case slug');

/** GET /marketplace/skills — фильтры и пагинация. */
export const marketplaceListQuerySchema = z.object({
  track: marketplaceTrackSchema.optional(),
  pricingModel: marketplacePricingModelSchema.optional(),
  verified: z.enum(['true', 'false']).optional(),
  search: z.string().trim().max(256).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  offset: z.coerce.number().int().min(0).default(0),
});

export type MarketplaceListQuery = z.infer<typeof marketplaceListQuerySchema>;

/**
 * Блок подписи в ответе каталога. Формат совпадает с контрактом витрины
 * (`apps/web/src/lib/marketplace.ts`): UI читает `signature.verified`,
 * `signature.status` и `signature.publicKeyId`, поэтому плоская строка
 * `ed25519:...` здесь неприменима.
 */
export const marketplaceSkillSignatureSchema = z.object({
  verified: z.boolean(),
  status: z.enum(['verified', 'invalid', 'unverified']),
  /** Опускается, если keyId неизвестен (UI ожидает string | undefined). */
  publicKeyId: z.string().optional(),
});

/** Zod-контракт элемента списка каталога (KI-086). */
export const marketplaceSkillViewSchema = z.object({
  id: z.string(),
  slug: marketplaceSlugSchema,
  name: z.string(),
  version: z.string(),
  description: z.string(),
  trackIds: z.array(marketplaceTrackSchema),
  authorName: z.string(),
  verified: z.boolean(),
  pricingModel: marketplacePricingModelSchema,
  price: z.string(),
  downloadsCount: z.number().int().nonnegative(),
  status: marketplaceStatusSchema,
  /** Запрашиваемые разрешения из SKILL.md; [] при ошибке парсинга. */
  permissions: z.array(z.string()),
  /** Детали проверки Ed25519-подписи. */
  signature: marketplaceSkillSignatureSchema,
  /** Flat keyId для обратной совместимости и аудита. */
  publicKeyId: z.string().nullable(),
  /** Установлен ли навык текущим пользователем (из InstalledSkill). */
  installed: z.boolean(),
});

export type MarketplaceSkillViewSchema = z.infer<
  typeof marketplaceSkillViewSchema
>;

/** POST /marketplace/skills — публикация навыка автором. */
export const publishMarketplaceSkillSchema = z.object({
  slug: marketplaceSlugSchema,
  name: z.string().min(1).max(128),
  version: z.string().min(1).max(64),
  description: z.string().min(1).max(512),
  trackIds: z
    .array(marketplaceTrackSchema)
    .min(1)
    .max(MARKETPLACE_TRACKS.length)
    .refine((ids) => new Set(ids).size === ids.length, 'треки не должны повторяться'),
  authorName: z.string().min(1).max(128),
  payoutAccountId: z.string().trim().min(1).max(256).optional(),
  /** Полный текст SKILL.md (YAML frontmatter + Markdown body). */
  manifestYaml: z.string().min(1).max(200_000),
  status: marketplaceStatusSchema.default('draft'),
});

export type PublishMarketplaceSkillInput = z.infer<
  typeof publishMarketplaceSkillSchema
>;

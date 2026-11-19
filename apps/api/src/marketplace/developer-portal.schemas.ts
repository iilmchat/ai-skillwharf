import { z } from 'zod';
import { marketplaceSlugSchema } from './marketplace.schemas.js';
import { auditFindingSchema, auditStatusSchema } from './skill-audit.schemas.js';

const moneySchema = z.number().nonnegative().finite().max(1_000_000_000);

/** POST /developer/skills. */
export const publishDeveloperSkillSchema = z
  .object({
    manifestYaml: z.string().trim().min(1).max(128_000),
    payoutAccountId: z.string().trim().min(1).max(256).optional(),
  })
  .strict();
export type PublishDeveloperSkillInput = z.infer<
  typeof publishDeveloperSkillSchema
>;

/** PATCH /developer/skills/:slug/payout. */
export const updatePayoutAccountSchema = z
  .object({ payoutAccountId: z.string().trim().min(1).max(256) })
  .strict();
export type UpdatePayoutAccountInput = z.infer<
  typeof updatePayoutAccountSchema
>;

/** Строка каталога в личном кабинете автора. */
export const developerSkillItemSchema = z.object({
  id: z.string(),
  slug: marketplaceSlugSchema,
  name: z.string(),
  version: z.string(),
  pricingModel: z.string(),
  price: moneySchema,
  downloadsCount: z.number().int().nonnegative(),
  verified: z.boolean(),
  auditStatus: auditStatusSchema,
  auditFindings: z.array(auditFindingSchema),
  payoutAccountId: z.string().nullable(),
  createdAt: z.string(),
});
export type DeveloperSkillItem = z.infer<typeof developerSkillItemSchema>;

/** Сводка/portfolio автора: KPI + детализация по навыкам. */
export const developerDashboardSchema = z.object({
  totalSkills: z.number().int().nonnegative(),
  totalDownloads: z.number().int().nonnegative(),
  totalRevenueRub: moneySchema,
  pendingPayoutRub: moneySchema,
  skills: z.array(developerSkillItemSchema),
});
export type DeveloperDashboard = z.infer<typeof developerDashboardSchema>;

export const developerPayoutUpdateSchema = z.object({
  skill: developerSkillItemSchema,
});

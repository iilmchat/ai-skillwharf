import { z } from 'zod';
import { customAgentRoleKeySchema } from '../agent/contracts.js';
import { moneySchema } from './workspace.schemas.js';

/** Регламент HITL кастомной роли (BUILDER-35.3). */
export const hitlPolicySchema = z.enum(['never', 'high_risk', 'always']);
export type HitlPolicy = z.infer<typeof hitlPolicySchema>;

/** slug навыка: marketplaceSlug либо имя установленного навыка. */
const skillSlugSchema = z
  .string()
  .trim()
  .min(1)
  .max(128)
  .regex(/^[a-z0-9][a-z0-9._-]*$/, 'ожидается slug навыка');

/** POST /workspaces/:workspaceId/agents. */
export const createCustomAgentRoleSchema = z
  .object({
    name: z.string().trim().min(2).max(80),
    roleKey: customAgentRoleKeySchema,
    description: z.string().trim().max(500).nullish(),
    systemPrompt: z.string().trim().min(10).max(8000),
    skillSlugs: z.array(skillSlugSchema).max(50).default([]),
    hitlPolicy: hitlPolicySchema.default('high_risk'),
    dailyBudgetRub: moneySchema.nullish(),
    isActive: z.boolean().default(true),
  })
  .strict();
export type CreateCustomAgentRoleInput = z.infer<
  typeof createCustomAgentRoleSchema
>;

/** PATCH /workspaces/:workspaceId/agents/:agentId (без default-полей). */
export const updateCustomAgentRoleSchema = z
  .object({
    name: z.string().trim().min(2).max(80).optional(),
    roleKey: customAgentRoleKeySchema.optional(),
    description: z.string().trim().max(500).nullish(),
    systemPrompt: z.string().trim().min(10).max(8000).optional(),
    skillSlugs: z.array(skillSlugSchema).max(50).optional(),
    hitlPolicy: hitlPolicySchema.optional(),
    dailyBudgetRub: moneySchema.nullish(),
    isActive: z.boolean().optional(),
  })
  .strict()
  .refine(
    (value) => Object.keys(value).length > 0,
    { message: 'укажите хотя бы одно поле для изменения' },
  );
export type UpdateCustomAgentRoleInput = z.infer<
  typeof updateCustomAgentRoleSchema
>;

/** Ответ API: Decimal сериализуется строкой, как и в остальных схемах. */
export const customAgentRoleViewSchema = z.object({
  id: z.string(),
  workspaceId: z.string(),
  name: z.string(),
  roleKey: customAgentRoleKeySchema,
  description: z.string().nullable(),
  systemPrompt: z.string(),
  skillSlugs: z.array(z.string()),
  hitlPolicy: hitlPolicySchema,
  dailyBudgetRub: z.string().nullable(),
  isActive: z.boolean(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type CustomAgentRoleView = z.infer<typeof customAgentRoleViewSchema>;

/** Снимок активной роли для обогащения контекста ChatService. */
export const customAgentRoleContextSchema = z.object({
  roleKey: customAgentRoleKeySchema,
  name: z.string().min(1),
  systemPrompt: z.string().min(1),
  skillSlugs: z.array(z.string()),
  hitlPolicy: hitlPolicySchema,
  dailyBudgetRub: z.number().nonnegative().nullable(),
});
export type CustomAgentRoleContext = z.infer<
  typeof customAgentRoleContextSchema
>;

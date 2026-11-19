import { z } from 'zod';
import i18n from '../i18n';
import { api } from './api';
import { workspaceErrorKey } from './workspaces';

/**
 * Контракт Visual No-Code Agent Builder (Sprint 35, BUILDER-35.1/35.3).
 *
 * Кастомные роли («столы») создаются в активном воркспейсе через
 * `/api/v1/workspaces/:workspaceId/agents`. Ответы валидируются Zod: UI не
 * подставляет вымышленные `roleKey`, лимиты и политики HITL. Если эндпоинт
 * ещё не выкачен (404), страница показывает локализованное сообщение.
 */

export const HITL_POLICIES = ['never', 'high_risk', 'always'] as const;

export const hitlPolicySchema = z.enum(HITL_POLICIES);

export type HitlPolicy = z.infer<typeof hitlPolicySchema>;

/** Совпадает с backend `customAgentRoleKeySchema` (kebab-case, 2..40). */
export const ROLE_KEY_PATTERN = /^[a-z0-9-]{2,40}$/;

/** Транслитерация кириллицы: roleKey always stays URL-safe Latin. */
const TRANSLIT: Readonly<Record<string, string>> = {
  а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', е: 'e', ё: 'e', ж: 'zh', з: 'z',
  и: 'i', й: 'y', к: 'k', л: 'l', м: 'm', н: 'n', о: 'o', п: 'p', р: 'r',
  с: 's', т: 't', у: 'u', ф: 'f', х: 'h', ц: 'ts', ч: 'ch', ш: 'sh',
  щ: 'sch', ъ: '', ы: 'y', ь: '', э: 'e', ю: 'yu', я: 'ya',
};

/**
 * Автогенерация `roleKey` из названия: кириллица транслитерируется, всё
 * лишнее заменяется дефисом, результат — kebab-case. Возвращает '' только
 * для строки без букв/цифр (тогда форма покажет ошибку).
 */
export function generateRoleKey(name: string): string {
  const transliterated = [...name.trim().toLowerCase()]
    .map((char) => TRANSLIT[char] ?? char)
    .join('');

  return transliterated
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/g, '');
}

/** Decimal-строка API, число, null или пустое поле → число либо null. */
export function parseBudget(value: unknown): number | null {
  if (typeof value === 'number') {
    return Number.isFinite(value) && value >= 0 ? value : null;
  }

  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value.trim());

    return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
  }

  return null;
}

const nullableBudgetSchema = z
  .union([z.number().nonnegative(), z.string(), z.null()])
  .optional()
  .transform((value) => parseBudget(value));

export const customAgentRoleSchema = z.object({
  id: z.string().min(1),
  workspaceId: z.string().min(1),
  name: z.string().trim().min(1),
  roleKey: z.string().min(1),
  description: z.string().nullable().optional(),
  systemPrompt: z.string(),
  skillSlugs: z.array(z.string().min(1)),
  hitlPolicy: hitlPolicySchema,
  dailyBudgetRub: nullableBudgetSchema,
  isActive: z.boolean(),
  createdAt: z.string().min(1),
});

export type CustomAgentRole = z.infer<typeof customAgentRoleSchema>;

const customAgentRoleListSchema = z.preprocess(
  (value) =>
    typeof value === 'object' && value !== null
      ? ((value as Record<string, unknown>).items ??
        (value as Record<string, unknown>).agents ??
        (value as Record<string, unknown>).data ??
        value)
      : value,
  z.array(customAgentRoleSchema),
);

/** Поля формы; `roleKey` необязателен — тогда он выводится из `name`. */
const skillSlugSchema = z
  .string()
  .trim()
  .min(1)
  .max(128)
  .regex(/^[a-z0-9][a-z0-9._-]*$/, 'ожидается slug навыка');

const createCustomAgentFields = {
  name: z.string().trim().min(2).max(80),
  roleKey: z.string().trim().max(40).optional(),
  description: z.string().trim().max(500).nullable().optional(),
  systemPrompt: z.string().trim().min(10).max(8000),
  skillSlugs: z.array(skillSlugSchema).max(50),
  hitlPolicy: hitlPolicySchema,
  dailyBudgetRub: nullableBudgetSchema,
  isActive: z.boolean().default(true),
};

export const createCustomAgentBaseSchema = z
  .object(createCustomAgentFields)
  .strict();

export const createCustomAgentSchema = createCustomAgentBaseSchema
  .transform((value) => {
    const manualKey = value.roleKey?.trim() ?? '';

    return {
      ...value,
      roleKey: manualKey === '' ? generateRoleKey(value.name) : manualKey,
    };
  })
  .refine((value) => ROLE_KEY_PATTERN.test(value.roleKey), {
    message: 'roleKey: только латинские буквы, цифры и дефисы',
    path: ['roleKey'],
  });

export type CreateCustomAgentInput = z.infer<typeof createCustomAgentSchema>;

/** Что приходит из формы до автогенерации `roleKey` и нормализации бюджета. */
export type CreateCustomAgentRawInput = z.input<typeof createCustomAgentSchema>;

/** PATCH: для переключателя активности достаточно части полей (без default-ов). */
export const updateCustomAgentSchema = z
  .object({
    name: z.string().trim().min(2).max(80).optional(),
    roleKey: z.string().trim().max(40).optional(),
    description: z.string().trim().max(500).nullable().optional(),
    systemPrompt: z.string().trim().min(10).max(8000).optional(),
    skillSlugs: z.array(skillSlugSchema).max(50).optional(),
    hitlPolicy: hitlPolicySchema.optional(),
    dailyBudgetRub: nullableBudgetSchema.optional(),
    isActive: z.boolean().optional(),
  })
  .strict();

export type UpdateCustomAgentInput = z.infer<typeof updateCustomAgentSchema>;

const customAgentResponseSchema = z.preprocess((value) => {
  if (typeof value === 'object' && value !== null) {
    const record = value as Record<string, unknown>;

    if (typeof record.agent === 'object' && record.agent !== null) {
      return record.agent;
    }
  }

  return value;
}, customAgentRoleSchema);

export const workspaceAgentsQueryKey = (workspaceId: string): readonly unknown[] =>
  ['workspace-agents', workspaceId] as const;

export async function fetchWorkspaceAgents(
  workspaceId: string,
): Promise<CustomAgentRole[]> {
  const { data } = await api.get<unknown>(
    `/workspaces/${encodeURIComponent(workspaceId)}/agents`,
  );

  return customAgentRoleListSchema.parse(data);
}

export async function createWorkspaceAgent(
  workspaceId: string,
  payload: CreateCustomAgentRawInput,
): Promise<CustomAgentRole> {
  const body = createCustomAgentSchema.parse(payload);
  const { data } = await api.post<unknown>(
    `/workspaces/${encodeURIComponent(workspaceId)}/agents`,
    body,
  );

  return customAgentResponseSchema.parse(data);
}

export async function updateWorkspaceAgent(
  workspaceId: string,
  agentId: string,
  payload: UpdateCustomAgentInput,
): Promise<CustomAgentRole> {
  const body = updateCustomAgentSchema.parse(payload);
  const { data } = await api.patch<unknown>(
    `/workspaces/${encodeURIComponent(workspaceId)}/agents/${encodeURIComponent(agentId)}`,
    body,
  );

  return customAgentResponseSchema.parse(data);
}

export async function deleteWorkspaceAgent(
  workspaceId: string,
  agentId: string,
): Promise<void> {
  await api.delete(
    `/workspaces/${encodeURIComponent(workspaceId)}/agents/${encodeURIComponent(agentId)}`,
  );
}

/** Локализованное сообщение об ошибке конструктора. */
export function getAgentBuilderErrorMessage(
  error: unknown,
  fallbackKey: string,
): string {
  return i18n.t(workspaceErrorKey(error, fallbackKey));
}

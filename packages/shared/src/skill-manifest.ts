import { z } from "zod";

/**
 * Zod-схема манифеста Skill (frontmatter файла `SKILL.md`).
 *
 * Источник истины — JSON Schema из `docs/ecosystem/Manifest-Specification.md`.
 * Схема повторяет её один в один:
 * - `additionalProperties` в JSON Schema не задан, поэтому лишние ключи не
 *   запрещены (Zod по умолчанию отбрасывает неописанные поля, а не отклоняет их);
 * - обязательные поля: `name`, `version`, `description`, `author`, `permissions`;
 * - `author.email` / `author.url` проверяются по форматам `email` / `uri`;
 * - `price` и `freeCallsLimit` неотрицательные, `freeCallsLimit` — целое.
 */

/** Уникальный идентификатор навыка в kebab-case. */
export const skillNameSchema = z.string().regex(/^[a-z0-9-]+$/);

/** Семантическая версия (SemVer 2.0.0). */
export const skillVersionSchema = z
  .string()
  .regex(
    /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?(?:\+([0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*))?$/,
  );

/** Автор навыка. */
export const skillAuthorSchema = z.object({
  name: z.string(),
  email: z.email().optional(),
  url: z.url().optional(),
});

/** Зависимости навыка от инструментов и других навыков. */
export const skillDependenciesSchema = z.object({
  tools: z.array(z.string()).optional(),
  skills: z.array(z.string()).optional(),
});

/** Разрешение, которое может запросить навык. */
export const skillPermissionSchema = z.enum([
  "network",
  "filesystem",
  "shell",
  "secrets",
  "hardware",
]);

/** Модель монетизации навыка. */
export const skillPricingSchema = z.object({
  model: z.enum([
    "Free",
    "Pay-per-Call",
    "Pay-per-Outcome",
    "Subscription",
    "Freemium",
  ]),
  price: z.number().min(0).optional(),
  currency: z.enum(["RUB", "USD"]).optional(),
  freeCallsLimit: z.number().int().min(0).optional(),
});

/** Хеш Markdown Body (sha256) для защиты от подмены. */
export const skillChecksumSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/);

/** Манифест Skill из YAML Frontmatter. */
export const skillManifestSchema = z.object({
  name: skillNameSchema,
  version: skillVersionSchema,
  description: z.string().max(256),
  author: skillAuthorSchema,
  dependencies: skillDependenciesSchema.optional(),
  permissions: z.array(skillPermissionSchema),
  pricing: skillPricingSchema.optional(),
  /**
   * Требует ли навык подтверждения пользователя перед вызовом своих
   * инструментов. Используется Human-in-the-Loop в Gateway.
   */
  requiresApproval: z.boolean().optional(),
  checksum: skillChecksumSchema.optional(),
});

/** Алиас в PascalCase для использования в коде Gateway/API. */
export const SkillManifestSchema = skillManifestSchema;

export type SkillName = z.infer<typeof skillNameSchema>;export type SkillVersion = z.infer<typeof skillVersionSchema>;
export type SkillAuthor = z.infer<typeof skillAuthorSchema>;
export type SkillDependencies = z.infer<typeof skillDependenciesSchema>;
export type SkillPermission = z.infer<typeof skillPermissionSchema>;
export type SkillPricing = z.infer<typeof skillPricingSchema>;
export type SkillChecksum = z.infer<typeof skillChecksumSchema>;

/** Типизированный манифест, выведенный из Zod-схемы. */
export type SkillManifest = z.infer<typeof skillManifestSchema>;
export type SkillManifestInput = z.input<typeof skillManifestSchema>;
export type SkillManifestOutput = z.output<typeof skillManifestSchema>;

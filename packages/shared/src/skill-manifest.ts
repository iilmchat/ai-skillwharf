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

/**
 * FQDN без схемы, порта, пути и wildcard.
 *
 * Пример: `api.tavily.com`. Wildcard-домены запрещены: egress-политика
 * разрешает только точные домены из манифеста (deny by default).
 */
export const fqdnSchema = z
  .string()
  .max(253)
  .regex(
    /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/,
    'ожидается FQDN в нижнем регистре без схемы, порта и wildcard',
  );

/** FQDN-allowlist egress: только точные домены, без wildcard. */
export const egressAllowlistSchema = z
  .array(fqdnSchema)
  .max(50)
  .refine(
    (domains) => new Set(domains).size === domains.length,
    'домены не должны повторяться',
  );

/** URL MCP-сервера, с которым работает навык-коннектор. */
export const mcpEndpointSchema = z
  .url()
  .max(2048)
  .refine(
    (endpoint) =>
      endpoint.startsWith('http://') || endpoint.startsWith('https://'),
    'mcp_endpoint должен использовать http или https',
  );

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
  /**
   * URL MCP-сервера навыка-коннектора (`mcp_endpoint` в SKILL.md).
   * Источник истины для подключения: Gateway не хардкодит адреса серверов.
   */
  mcp_endpoint: mcpEndpointSchema.optional(),
  /**
   * FQDN-домены, к которым навыку разрешён egress (`egress_allowlist`).
   * Пустой/отсутствующий список означает полный запрет сети, даже если
   * глобальный флаг `SANDBOX_ALLOW_NETWORK` включён.
   */
  egress_allowlist: egressAllowlistSchema.optional(),
});

/** Алиас в PascalCase для использования в коде Gateway/API. */
export const SkillManifestSchema = skillManifestSchema;

export type SkillName = z.infer<typeof skillNameSchema>;export type SkillVersion = z.infer<typeof skillVersionSchema>;
export type SkillAuthor = z.infer<typeof skillAuthorSchema>;
export type SkillDependencies = z.infer<typeof skillDependenciesSchema>;
export type SkillPermission = z.infer<typeof skillPermissionSchema>;
export type SkillPricing = z.infer<typeof skillPricingSchema>;
export type SkillChecksum = z.infer<typeof skillChecksumSchema>;
export type EgressAllowlist = z.infer<typeof egressAllowlistSchema>;
export type McpEndpoint = z.infer<typeof mcpEndpointSchema>;

/** Типизированный манифест, выведенный из Zod-схемы. */
export type SkillManifest = z.infer<typeof skillManifestSchema>;
export type SkillManifestInput = z.input<typeof skillManifestSchema>;
export type SkillManifestOutput = z.output<typeof skillManifestSchema>;

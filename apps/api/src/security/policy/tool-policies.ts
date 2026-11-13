import type { SkillPermission } from '@skillwharf/shared';
import { z } from 'zod';
import type { UserRole } from './policy.types.js';

/**
 * Декларативный реестр политик инструментов Agent Gateway.
 *
 * Для каждого инструмента из `llm/llm.service.ts` описаны:
 * - строгая Zod-схема аргументов (лишние ключи и слишком длинные строки
 *   отклоняются до выполнения);
 * - требуемое разрешение навыка и допустимые роли;
 * - категория egress и режим обработки tainted-секретов;
 * - вид shell-кода, который проверяется структурным анализатором.
 *
 * Неизвестный инструмент политикой не покрыт и блокируется вызывающим кодом.
 */

/** Категория сетевого доступа инструмента. */
export type EgressCategory = 'sandbox-network' | 'gateway-network' | 'none';

/** Режим обработки значений из `taintedSecrets`. */
export type TaintMode = 'block' | 'mask' | 'none';

/** Вид shell-кода для структурного анализа. */
export type ShellKind = 'exec' | 'sandbox';

/** Политика одного инструмента. */
export interface ToolPolicy {
  readonly name: string;
  /** Строгая схема аргументов: лишние ключи запрещены. */
  readonly schema: z.ZodType;
  /** Разрешение навыка, необходимое для вызова (null — не требуется). */
  readonly requiredPermission: SkillPermission | null;
  /** Где именно выполняется сетевой доступ. */
  readonly egress: EgressCategory;
  /** Инструмент по своей природе всегда ходит в сеть. */
  readonly egressRequested: boolean;
  /** Что делать, если аргументы содержат tainted-секрет. */
  readonly taint: TaintMode;
  /** Роли, которым разрешён вызов. */
  readonly allowedRoles: readonly UserRole[];
  /** Какой аргумент анализировать как shell-код. */
  readonly shell?: ShellKind;
}

const ALL_ROLES = [
  'guest',
  'user',
  'admin',
  'owner',
] as const satisfies readonly UserRole[];

/** shell-инструменты недоступны гостям: они меняют состояние песочницы. */
const SHELL_ROLES = [
  'user',
  'admin',
  'owner',
] as const satisfies readonly UserRole[];

/** Идентификатор: короткая строка без пробелов. */
const identifier = (max = 128) => z.string().min(1).max(max);

/** Свободный текст с верхней границей длины. */
const text = (max: number) => z.string().min(1).max(max);

/** Ячейка таблицы: примитив, который можно безопасно записать. */
const tableCell = z.union([
  z.string().max(2000),
  z.number(),
  z.boolean(),
  z.null(),
]);

/** Строка таблицы. */
const tableRow = z.array(tableCell).max(100);

/** Параметры MCP-действия: плоский JSON-объект ограниченного размера. */
const mcpParams = z
  .record(z.string().max(128), z.unknown())
  .refine(
    (params) => Object.keys(params).length <= 64,
    'слишком много параметров MCP-действия',
  );

/** Схема marketplace MCP-инструментов (Ozon/WB). */
const mcpArgsSchema = z
  .object({
    action: identifier(128).regex(
      /^[A-Za-z0-9_.-]+$/,
      'ожидается имя MCP-инструмента',
    ),
    params: mcpParams,
  })
  .strict();

/** Реестр: имя инструмента -> политика. */
export const TOOL_POLICIES: Readonly<Record<string, ToolPolicy>> = {
  // --- Базовые инструменты песочницы -------------------------------------
  execute_sandbox_code: {
    name: 'execute_sandbox_code',
    schema: z.object({ code: text(20_000) }).strict(),
    requiredPermission: 'shell',
    egress: 'sandbox-network',
    egressRequested: false,
    taint: 'block',
    allowedRoles: SHELL_ROLES,
    shell: 'sandbox',
  },
  web_search: {
    name: 'web_search',
    schema: z.object({ query: text(1_000) }).strict(),
    requiredPermission: 'network',
    egress: 'sandbox-network',
    egressRequested: true,
    taint: 'mask',
    allowedRoles: ALL_ROLES,
  },
  exec: {
    name: 'exec',
    schema: z.object({ command: text(2_000) }).strict(),
    requiredPermission: 'shell',
    egress: 'sandbox-network',
    egressRequested: false,
    taint: 'block',
    allowedRoles: SHELL_ROLES,
    shell: 'exec',
  },
  // --- MCP-коннекторы -----------------------------------------------------
  ozon_mcp_call: {
    name: 'ozon_mcp_call',
    schema: mcpArgsSchema,
    requiredPermission: 'network',
    egress: 'gateway-network',
    egressRequested: true,
    taint: 'block',
    allowedRoles: ALL_ROLES,
  },
  wb_mcp_call: {
    name: 'wb_mcp_call',
    schema: mcpArgsSchema,
    requiredPermission: 'network',
    egress: 'gateway-network',
    egressRequested: true,
    taint: 'block',
    allowedRoles: ALL_ROLES,
  },
  // --- Каналы отправки данных: taint блокирует эксфильтрацию --------------
  send_message: {
    name: 'send_message',
    schema: z
      .object({
        channel: z.enum(['telegram', 'vk', 'whatsapp']),
        to: text(128),
        text: text(4_096),
      })
      .strict(),
    requiredPermission: null,
    egress: 'none',
    egressRequested: false,
    taint: 'block',
    allowedRoles: ALL_ROLES,
  },
  google_sheets_append: {
    name: 'google_sheets_append',
    schema: z
      .object({
        sheetId: identifier(256),
        values: z.array(z.union([tableCell, tableRow])).max(1_000),
      })
      .strict(),
    requiredPermission: null,
    egress: 'none',
    egressRequested: false,
    taint: 'block',
    allowedRoles: ALL_ROLES,
  },
  google_docs_create: {
    name: 'google_docs_create',
    schema: z
      .object({
        title: text(300),
        content: text(50_000),
      })
      .strict(),
    requiredPermission: null,
    egress: 'none',
    egressRequested: false,
    taint: 'block',
    allowedRoles: ALL_ROLES,
  },
  publish_to_dzen: {
    name: 'publish_to_dzen',
    schema: z
      .object({
        title: text(300),
        text: text(50_000),
        imageUrl: z.url().max(2_048).optional(),
      })
      .strict(),
    requiredPermission: null,
    egress: 'none',
    egressRequested: false,
    taint: 'block',
    allowedRoles: ALL_ROLES,
  },
  // --- Остальные инструменты: сеть и taint не затрагивают -----------------
  generate_image: {
    name: 'generate_image',
    schema: z.object({ prompt: text(2_000) }).strict(),
    requiredPermission: null,
    egress: 'none',
    egressRequested: false,
    taint: 'none',
    allowedRoles: ALL_ROLES,
  },
  run_workflow: {
    name: 'run_workflow',
    schema: z
      .object({ steps: z.array(text(500)).min(1).max(50) })
      .strict(),
    requiredPermission: null,
    egress: 'none',
    egressRequested: false,
    taint: 'none',
    allowedRoles: ALL_ROLES,
  },
  calculate_unit_economics: {
    name: 'calculate_unit_economics',
    schema: z.object({ sku: identifier(256) }).strict(),
    requiredPermission: null,
    egress: 'none',
    egressRequested: false,
    taint: 'none',
    allowedRoles: ALL_ROLES,
  },
  detect_profit_leaks: {
    name: 'detect_profit_leaks',
    schema: z.object({ sellerId: identifier(256) }).strict(),
    requiredPermission: null,
    egress: 'none',
    egressRequested: false,
    taint: 'none',
    allowedRoles: ALL_ROLES,
  },
  monitor_competitor_prices: {
    name: 'monitor_competitor_prices',
    schema: z.object({ sku: identifier(256) }).strict(),
    requiredPermission: null,
    egress: 'none',
    egressRequested: false,
    taint: 'none',
    allowedRoles: ALL_ROLES,
  },
  audit_fraud_risk: {
    name: 'audit_fraud_risk',
    schema: z.object({ campaignId: identifier(256) }).strict(),
    requiredPermission: null,
    egress: 'none',
    egressRequested: false,
    taint: 'none',
    allowedRoles: ALL_ROLES,
  },
  check_facts: {
    name: 'check_facts',
    schema: z.object({ text: text(20_000) }).strict(),
    requiredPermission: null,
    egress: 'none',
    egressRequested: false,
    taint: 'none',
    allowedRoles: ALL_ROLES,
  },
  screen_resume: {
    name: 'screen_resume',
    schema: z.object({ resumeText: text(50_000) }).strict(),
    requiredPermission: null,
    egress: 'none',
    egressRequested: false,
    taint: 'none',
    allowedRoles: ALL_ROLES,
  },
  extract_document_data: {
    name: 'extract_document_data',
    schema: z.object({ documentText: text(100_000) }).strict(),
    requiredPermission: null,
    egress: 'none',
    egressRequested: false,
    taint: 'none',
    allowedRoles: ALL_ROLES,
  },
};

/** Имена всех инструментов, для которых объявлена политика. */
export const KNOWN_TOOL_NAMES: readonly string[] = Object.keys(TOOL_POLICIES);

/** Политика инструмента или undefined, если инструмент неизвестен. */
export function getToolPolicy(toolName: string): ToolPolicy | undefined {
  return TOOL_POLICIES[toolName];
}

/**
 * Allowlist бинарников для `exec`: узкий набор CLI, которым пользуются
 * навыки (github и подобные).
 */
export const EXEC_COMMAND_ALLOWLIST: ReadonlySet<string> = new Set([
  'gh',
  'git',
  'curl',
  'jq',
  'python3',
  'node',
  'ls',
  'cat',
  'echo',
  'pwd',
  'head',
  'tail',
  'wc',
  'grep',
  'date',
]);

/** Allowlist бинарников для `execute_sandbox_code`. */
export const SANDBOX_COMMAND_ALLOWLIST: ReadonlySet<string> = new Set([
  'python3',
  'node',
  'curl',
  'jq',
  'gh',
  'git',
  'cat',
  'ls',
  'mkdir',
  'cp',
  'mv',
  'echo',
  'printf',
  'pwd',
  'head',
  'tail',
  'wc',
  'grep',
  'sed',
  'awk',
  'sort',
  'uniq',
  'tr',
  'cut',
  'base64',
  'date',
  'sleep',
  'test',
  'true',
  'false',
  'diff',
  'tee',
]);

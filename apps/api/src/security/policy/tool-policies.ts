import type { SkillPermission } from '@skillwharf/shared';
import { z } from 'zod';
import {
  CheckFactsToolSchema as CheckFactsSchema,
  ScreenResumeToolSchema as ScreenResumeSchema,
} from '../../agent/content/content.schemas.js';
import {
  ExtractDocumentDataToolSchema as ExtractDocumentDataSchema,
  ExtractPdfToolSchema as ExtractPdfSchema,
  OcrDocumentToolSchema as OcrDocumentSchema,
  WriteDocxToolSchema as WriteDocxSchema,
} from '../../agent/documents/document-tools.schemas.js';
import { isFinalDealStage } from '../../agent/tools/erp-tools.js';
import {
  EdoGetDocumentDetailsToolSchema as EdoGetDocumentDetailsSchema,
  EdoListIncomingToolSchema as EdoListIncomingSchema,
  EdoPrepareSignPacketToolSchema as EdoPrepareSignPacketSchema,
  EdoReconcileWithErpToolSchema as EdoReconcileWithErpSchema,
  MarkingCheckCodesToolSchema as MarkingCheckCodesSchema,
  MarkingReportViolationToolSchema as MarkingReportViolationSchema,
  MarkingVerifyShipmentToolSchema as MarkingVerifyShipmentSchema,
} from '../../agent/tools/tool-schemas.js';
import {
  Bitrix24GetDealToolSchema as Bitrix24GetDealSchema,
  Bitrix24UpdateDealToolSchema as Bitrix24UpdateDealSchema,
  MoyskladCheckStockToolSchema as MoyskladCheckStockSchema,
  MoyskladCreateOrderToolSchema as MoyskladCreateOrderSchema,
  MoyskladGetCostToolSchema as MoyskladGetCostSchema,
  OnecCheckDebtToolSchema as OnecCheckDebtSchema,
  OnecCheckStockToolSchema as OnecCheckStockSchema,
  OnecCreateOrderToolSchema as OnecCreateOrderSchema,
  OnecSearchNomenclatureToolSchema as OnecSearchNomenclatureSchema,
} from '../../agent/tools/tool-schemas.js';
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

/**
 * HITL-режим инструмента.
 *
 * `final-stage` — подтверждение нужно только для необратимого перехода
 * (сделка Битрикс24 → «Успешно»/`WON`); Runtime и worker решают это по
 * аргументам вызова через `approvalRule` (KI-079).
 */
export type ToolApprovalMode = 'none' | 'always' | 'final-stage';

/**
 * Условие HITL по аргументу вызова (KI-079).
 *
 * Передаётся worker'у в `GraphContext.approvalRules`: граф останавливается
 * только если значение `arg` входит в `values` (точное совпадение или
 * суффикс стадии вида `C1:WON`).
 */
export interface ToolApprovalRule {
  readonly arg: string;
  readonly values: readonly string[];
}

/** Правило HITL для конкретного инструмента (контракт GraphContext). */
export interface ApprovalRule {
  readonly tool: string;
  readonly arg: string;
  readonly values: string[];
}

/** Аргумент `bitrix24_update_deal`, по которому определяется финал сделки. */
export const DEAL_STAGE_ARG = 'stageId';

/** Значения аргумента стадии, которые требуют подтверждения. */
export const FINAL_DEAL_STAGE_VALUES = ['WON'] as const;

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
  /** HITL-режим; отсутствует — подтверждение не требуется. */
  readonly approval?: ToolApprovalMode;
  /** Условие HITL по аргументу (`final-stage`); worker фильтрует вызовы. */
  readonly approvalRule?: ToolApprovalRule;
  /** Pay-per-Call цена вызова в ₽ (CONNECT-32.1: 20 ₽ для инструментов 1С). */
  readonly priceRub?: number;
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

/** Дата/время ISO 8601 (Z или смещение) — строкой, как в Google API. */
const isoDateTime = () =>
  z
    .string()
    .min(1)
    .max(64)
    .refine(
      (value) => !Number.isNaN(Date.parse(value)),
      'ожидается дата/время ISO 8601',
    );

/** Дата финансового периода YYYY-MM-DD. */
const financeDateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'ожидается дата YYYY-MM-DD')
  .optional();

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
    requiredPermission: null,
    egress: 'none',
    egressRequested: false,
    taint: 'block',
    allowedRoles: ALL_ROLES,
  },
  wb_mcp_call: {
    name: 'wb_mcp_call',
    schema: mcpArgsSchema,
    requiredPermission: null,
    egress: 'none',
    egressRequested: false,
    taint: 'block',
    allowedRoles: ALL_ROLES,
  },
  // --- CRM Битрикс24 и склад МойСклад (Треки K/L) ---------------------------
  bitrix24_get_deal: {
    name: 'bitrix24_get_deal',
    schema: Bitrix24GetDealSchema,
    requiredPermission: null,
    egress: 'none',
    egressRequested: false,
    taint: 'block',
    allowedRoles: ALL_ROLES,
    // Чтение карточки сделки безопасно: явно снимает HITL навыка с записью.
    approval: 'none',
  },
  bitrix24_update_deal: {
    name: 'bitrix24_update_deal',
    schema: Bitrix24UpdateDealSchema,
    requiredPermission: null,
    egress: 'none',
    egressRequested: false,
    taint: 'block',
    allowedRoles: ALL_ROLES,
    // HITL ядра — смена стадии на «Успешно» (необратимый финал сделки).
    approval: 'final-stage',
    approvalRule: {
      arg: DEAL_STAGE_ARG,
      values: FINAL_DEAL_STAGE_VALUES,
    },
  },
  moysklad_check_stock: {
    name: 'moysklad_check_stock',
    schema: MoyskladCheckStockSchema,
    requiredPermission: null,
    egress: 'none',
    egressRequested: false,
    taint: 'block',
    allowedRoles: ALL_ROLES,
    approval: 'none',
  },
  moysklad_get_cost: {
    name: 'moysklad_get_cost',
    schema: MoyskladGetCostSchema,
    requiredPermission: null,
    egress: 'none',
    egressRequested: false,
    taint: 'block',
    allowedRoles: ALL_ROLES,
    approval: 'none',
  },
  moysklad_create_order: {
    name: 'moysklad_create_order',
    schema: MoyskladCreateOrderSchema,
    requiredPermission: null,
    egress: 'none',
    egressRequested: false,
    taint: 'block',
    allowedRoles: ALL_ROLES,
    // Создание документа на складе — всегда необратимо: подтверждение HITL.
    approval: 'always',
  },
  // --- 1С:Предприятие (CONNECT-32.1): Pay-per-Call 20 ₽ --------------------
  onec_search_nomenclature: {
    name: 'onec_search_nomenclature',
    schema: OnecSearchNomenclatureSchema,
    requiredPermission: null,
    egress: 'gateway-network',
    egressRequested: true,
    taint: 'block',
    allowedRoles: ALL_ROLES,
    approval: 'none',
    priceRub: 20,
  },
  onec_check_stock: {
    name: 'onec_check_stock',
    schema: OnecCheckStockSchema,
    requiredPermission: null,
    egress: 'gateway-network',
    egressRequested: true,
    taint: 'block',
    allowedRoles: ALL_ROLES,
    approval: 'none',
    priceRub: 20,
  },
  onec_check_debt: {
    name: 'onec_check_debt',
    schema: OnecCheckDebtSchema,
    requiredPermission: null,
    egress: 'gateway-network',
    egressRequested: true,
    taint: 'block',
    allowedRoles: ALL_ROLES,
    approval: 'none',
    priceRub: 20,
  },
  onec_create_order: {
    name: 'onec_create_order',
    schema: OnecCreateOrderSchema,
    requiredPermission: null,
    egress: 'gateway-network',
    egressRequested: true,
    taint: 'block',
    allowedRoles: ALL_ROLES,
    // Создание документа в 1С — необратимое действие: подтверждение HITL.
    approval: 'always',
    priceRub: 20,
  },
  // --- ЭДО (EDO-41.2/41.3): Диадок и СБИС -------------------------------
  edo_list_incoming_upd: {
    name: 'edo_list_incoming_upd',
    schema: EdoListIncomingSchema,
    requiredPermission: null,
    egress: 'gateway-network',
    egressRequested: true,
    taint: 'block',
    allowedRoles: ALL_ROLES,
    approval: 'none',
  },
  edo_get_document_details: {
    name: 'edo_get_document_details',
    schema: EdoGetDocumentDetailsSchema,
    requiredPermission: null,
    egress: 'gateway-network',
    egressRequested: true,
    taint: 'block',
    allowedRoles: ALL_ROLES,
    approval: 'none',
  },
  edo_reconcile_with_erp: {
    name: 'edo_reconcile_with_erp',
    schema: EdoReconcileWithErpSchema,
    requiredPermission: null,
    egress: 'gateway-network',
    egressRequested: true,
    taint: 'block',
    allowedRoles: ALL_ROLES,
    approval: 'none',
    priceRub: 25,
  },
  edo_prepare_sign_packet: {
    name: 'edo_prepare_sign_packet',
    schema: EdoPrepareSignPacketSchema,
    requiredPermission: null,
    egress: 'gateway-network',
    egressRequested: true,
    taint: 'block',
    allowedRoles: ALL_ROLES,
    // Пакет на КЭП — юридически значимое действие: обязательный HITL.
    approval: 'always',
    priceRub: 25,
  },
  // --- Маркировка «Честный ЗНАК» (MARK-42.2/42.3) ------------------------
  marking_check_codes: {
    name: 'marking_check_codes',
    schema: MarkingCheckCodesSchema,
    requiredPermission: null,
    egress: 'gateway-network',
    egressRequested: true,
    taint: 'block',
    allowedRoles: ALL_ROLES,
    approval: 'none',
    priceRub: 15,
  },
  marking_verify_shipment: {
    name: 'marking_verify_shipment',
    schema: MarkingVerifyShipmentSchema,
    requiredPermission: null,
    egress: 'gateway-network',
    egressRequested: true,
    taint: 'block',
    allowedRoles: ALL_ROLES,
    approval: 'none',
    priceRub: 15,
  },
  marking_report_violation: {
    name: 'marking_report_violation',
    schema: MarkingReportViolationSchema,
    requiredPermission: null,
    egress: 'gateway-network',
    egressRequested: true,
    taint: 'block',
    allowedRoles: ALL_ROLES,
    // Акт о расхождении блокирует партию — юридически значимое действие.
    approval: 'always',
    priceRub: 15,
  },
  // --- Каналы отправки данных: taint блокирует эксфильтрацию --------------
  send_message: {
    name: 'send_message',
    schema: z
      .object({
        channel: z.enum(['telegram', 'vk', 'whatsapp']),
        to: text(128),
        text: text(4_096),
        buttons: z
          .array(
            z
              .object({
                text: text(64),
                url: z.url().max(2_048).optional(),
                callbackData: z.string().min(1).max(64).optional(),
              })
              .strict()
              .refine(
                (button) =>
                  (button.url === undefined) !==
                  (button.callbackData === undefined),
                'кнопка должна содержать ровно одно из полей url или callbackData',
              ),
          )
          .max(8)
          .optional(),
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
        range: identifier(128).optional(),
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
  google_calendar_create: {
    name: 'google_calendar_create',
    schema: z
      .object({
        summary: text(300),
        start: isoDateTime(),
        end: isoDateTime(),
        description: text(5_000).optional(),
        attendees: z.array(z.email().max(320)).max(20).optional(),
        timeZone: identifier(64).optional(),
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
    schema: z
      .object({
        sku: identifier(256),
        marketplace: z.enum(['ozon', 'wb']).optional(),
        cost: z.number().nonnegative().max(100_000_000).optional(),
        price: z.number().nonnegative().max(100_000_000).optional(),
        dateFrom: financeDateSchema,
        dateTo: financeDateSchema,
        sellerId: identifier(64).optional(),
      })
      .strict(),
    requiredPermission: null,
    egress: 'none',
    egressRequested: false,
    taint: 'block',
    allowedRoles: ALL_ROLES,
  },
  detect_profit_leaks: {
    name: 'detect_profit_leaks',
    schema: z
      .object({
        sellerId: identifier(64),
        marketplace: z.enum(['ozon', 'wb']).optional(),
        dateFrom: financeDateSchema,
        dateTo: financeDateSchema,
      })
      .strict(),
    requiredPermission: null,
    egress: 'none',
    egressRequested: false,
    taint: 'block',
    allowedRoles: ALL_ROLES,
  },
  monitor_competitor_prices: {
    name: 'monitor_competitor_prices',
    schema: z
      .object({
        sku: identifier(256),
        marketplace: z.enum(['ozon', 'wb']).optional(),
        productId: z.number().int().positive().optional(),
        sellerId: identifier(64).optional(),
      })
      .strict(),
    requiredPermission: null,
    egress: 'none',
    egressRequested: false,
    taint: 'block',
    allowedRoles: ALL_ROLES,
  },
  audit_fraud_risk: {
    name: 'audit_fraud_risk',
    schema: z
      .object({
        campaignId: identifier(128),
        marketplace: z.enum(['ozon', 'wb']).optional(),
        dateFrom: financeDateSchema,
        dateTo: financeDateSchema,
        sellerId: identifier(64).optional(),
      })
      .strict(),
    requiredPermission: null,
    egress: 'none',
    egressRequested: false,
    taint: 'block',
    allowedRoles: ALL_ROLES,
  },
  check_facts: {
    name: 'check_facts',
    schema: CheckFactsSchema,
    requiredPermission: null,
    egress: 'none',
    egressRequested: false,
    taint: 'none',
    allowedRoles: ALL_ROLES,
  },
  screen_resume: {
    name: 'screen_resume',
    schema: ScreenResumeSchema,
    requiredPermission: null,
    egress: 'none',
    egressRequested: false,
    taint: 'none',
    allowedRoles: ALL_ROLES,
  },
  extract_document_data: {
    name: 'extract_document_data',
    schema: ExtractDocumentDataSchema,
    requiredPermission: null,
    egress: 'none',
    egressRequested: false,
    taint: 'none',
    allowedRoles: ALL_ROLES,
  },
  // --- Документы (Sprint 20): файлы берутся из DOCUMENTS_INPUT_DIR, сети нет -
  extract_pdf: {
    name: 'extract_pdf',
    schema: ExtractPdfSchema,
    requiredPermission: null,
    egress: 'none',
    egressRequested: false,
    taint: 'none',
    allowedRoles: ALL_ROLES,
  },
  write_docx: {
    name: 'write_docx',
    schema: WriteDocxSchema,
    requiredPermission: null,
    egress: 'none',
    egressRequested: false,
    taint: 'none',
    allowedRoles: ALL_ROLES,
  },
  ocr_document: {
    name: 'ocr_document',
    schema: OcrDocumentSchema,
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
 * Совпадает ли значение аргумента с одним из разрешённых значений правила.
 *
 * Для стадий Битрикс24 финальная стадия воронки приходит как `C1:WON`,
 * поэтому кроме точного совпадения принимается суффикс `:<значение>`.
 */
export function approvalRuleMatches(
  value: unknown,
  values: readonly string[],
): boolean {
  if (typeof value !== 'string') {
    return false;
  }

  const normalized = value.trim().toUpperCase();

  return values.some((expected) => {
    const target = expected.trim().toUpperCase();

    return normalized === target || normalized.endsWith(`:${target}`);
  });
}

/** Декларативное правило HITL инструмента или `null`. */
export function approvalRuleFor(toolName: string): ApprovalRule | null {
  const policy = getToolPolicy(toolName);
  const rule = policy?.approvalRule;

  if (policy === undefined || rule === undefined) {
    return null;
  }

  return { tool: toolName, arg: rule.arg, values: [...rule.values] };
}

/**
 * Нужно ли подтверждение пользователя для конкретного вызова инструмента.
 *
 * `always` — каждый вызов (создание заказа МойСклад); `final-stage` — только
 * перевод сделки на «Успешно» (`WON`), потому что вернуть сделку из финала
 * можно лишь вручную. Runtime использует эту функцию как гейт перед вызовом
 * MCP, поэтому она не зависит от текста инструкций навыка.
 */
export function requiresApprovalFor(
  toolName: string,
  args: Readonly<Record<string, unknown>>,
): boolean {
  const policy = getToolPolicy(toolName);
  const approval = policy?.approval ?? 'none';

  if (approval === 'always') {
    return true;
  }

  if (approval !== 'final-stage') {
    return false;
  }

  const rule = policy?.approvalRule;

  if (rule !== undefined) {
    return approvalRuleMatches(args[rule.arg], rule.values);
  }

  const stageId = args[DEAL_STAGE_ARG];

  return typeof stageId === 'string' && isFinalDealStage(stageId);
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

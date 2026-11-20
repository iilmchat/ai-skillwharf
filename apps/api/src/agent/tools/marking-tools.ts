import { z } from 'zod';
import { mcpProviderError } from './mcp-gateway.js';
import { MARKING_MCP_ACTIONS } from './mcp-gateway.js';
import type {
  MarketplaceCallOptions,
  MarketplaceMcpService,
} from './marketplace-mcp.service.js';
import {
  type MarkingCheckCodesArgs,
  type MarkingReportViolationArgs,
  type MarkingVerifyShipmentArgs,
} from './tool-schemas.js';

export interface MarkingToolContext extends MarketplaceCallOptions {
  readonly beforeExecute?: () => Promise<void>;
}

/** Статус приходит от True API как строка; неизвестные значения = UNKNOWN. */
export interface MarkingCodeStatus {
  readonly code: string;
  readonly status: string;
  readonly ownerInn?: string;
  readonly expiresAt?: string;
  /** Поле ГИС МТ в нормализованном ответе marking-mcp. */
  readonly expirationDate?: string;
  readonly legalForSale: boolean;
  readonly gtin?: string;
}

export type MarkingIssueType =
  | 'retired'
  | 'written_off'
  | 'foreign_owner'
  | 'expired'
  | 'shortage'
  | 'oversort'
  | 'unknown_code';

export interface MarkingIssue {
  readonly type: MarkingIssueType;
  readonly code?: string;
  readonly gtin?: string;
  readonly message: string;
  readonly expected?: number;
  readonly actual?: number;
}

const markingCodeStatusSchema = z.object({
  code: z.string().min(1),
  status: z.string().min(1).default('UNKNOWN'),
  ownerInn: z.string().optional(),
  expiresAt: z.string().optional(),
  expirationDate: z.string().optional(),
  legalForSale: z.boolean().default(false),
  gtin: z.string().optional(),
});
const markingCheckResponseSchema = z.object({
  results: z.array(markingCodeStatusSchema),
});
const markingReportResponseSchema = z
  .object({
    reportId: z.string().optional(),
    status: z.string().optional(),
    codes: z.array(z.string()).optional(),
  })
  .passthrough();

/**
 * Детерминированная сверка отсканированных кодов с ожидаемой партией
 * (MARK-42.3): выбывшие марки, чужой ИНН, просрочка, недостача/пересорт.
 * Сторона, сравнивающая ИНН, уже авторизована в ГИС МТ — сравнение по
 * bool/строкам, без сетевых вызовов.
 */
export function verifyMarkingShipment(
  codes: readonly MarkingCodeStatus[],
  expectedItems: readonly { gtin: string; quantity: number; name?: string }[],
  expectedOwnerInn: string,
  now: Date = new Date(),
): { valid: boolean; issues: MarkingIssue[] } {
  const issues: MarkingIssue[] = [];
  const counts = new Map<string, number>();

  for (const code of codes) {
    const status = code.status.toUpperCase();

    if (status === 'RETIRED' || status === 'WRITTEN_OFF') {
      issues.push({
        type: status === 'RETIRED' ? 'retired' : 'written_off',
        code: code.code,
        message: `Марка ${code.code} выбыла из оборота (${code.status})`,
      });
    }

    if (code.ownerInn !== undefined && code.ownerInn !== expectedOwnerInn) {
      issues.push({
        type: 'foreign_owner',
        code: code.code,
        message: `Марка ${code.code} принадлежит другому владельцу (ИНН ${code.ownerInn})`,
      });
    }

    const expiresAt = code.expiresAt ?? code.expirationDate;

    if (
      expiresAt !== undefined &&
      Number.isFinite(Date.parse(expiresAt)) &&
      Date.parse(expiresAt) < now.getTime()
    ) {
      issues.push({
        type: 'expired',
        code: code.code,
        message: `Срок годности марки ${code.code} истёк`,
      });
    }

    if (status === 'UNKNOWN' || status === 'NOT_FOUND') {
      issues.push({
        type: 'unknown_code',
        code: code.code,
        message: `Код ${code.code} не найден в ГИС МТ`,
      });
    }

    if (code.gtin !== undefined) {
      counts.set(code.gtin, (counts.get(code.gtin) ?? 0) + 1);
    }
  }

  for (const item of expectedItems) {
    const actual = counts.get(item.gtin) ?? 0;

    if (actual < item.quantity) {
      issues.push({
        type: 'shortage',
        gtin: item.gtin,
        message: `Недостача маркированных единиц GTIN ${item.gtin}`,
        expected: item.quantity,
        actual,
      });
    } else if (actual > item.quantity) {
      issues.push({
        type: 'oversort',
        gtin: item.gtin,
        message: `Пересорт: больше маркированных единиц GTIN ${item.gtin}, чем в документе`,
        expected: item.quantity,
        actual,
      });
    }
  }

  return { valid: issues.length === 0, issues };
}

async function callMarking(
  mcp: MarketplaceMcpService,
  action: string,
  params: Record<string, unknown>,
  context: MarkingToolContext,
): Promise<unknown> {
  const text = await mcp.call('chestny_znak', action, params, context);

  try {
    const raw: unknown = JSON.parse(text);

    return raw;
  } catch {
    throw mcpProviderError(`MCP-действие ${action} вернуло некорректный JSON`);
  }
}

function parseResult<T>(
  action: string,
  schema: z.ZodType<T>,
  raw: unknown,
): T {
  const parsed = schema.safeParse(raw);

  if (!parsed.success) {
    throw mcpProviderError(`MCP-действие ${action} вернуло неизвестный формат`);
  }

  return parsed.data;
}

/** Проверка списка кодов DataMatrix. */
export async function markingCheckCodes(
  mcp: MarketplaceMcpService,
  args: MarkingCheckCodesArgs,
  context: MarkingToolContext = {},
): Promise<string> {
  const raw = await callMarking(
    mcp,
    MARKING_MCP_ACTIONS.checkCodes,
    { codes: [...args.codes] },
    context,
  );
  const parsed = parseResult(
    MARKING_MCP_ACTIONS.checkCodes,
    markingCheckResponseSchema,
    raw,
  );

  await context.beforeExecute?.();

  return JSON.stringify({ results: parsed.results });
}

/** Сверка кодов с ожидаемой партией (детерминированная, без LLM). */
export async function markingVerifyShipment(
  mcp: MarketplaceMcpService,
  args: MarkingVerifyShipmentArgs,
  context: MarkingToolContext = {},
): Promise<string> {
  const raw = await callMarking(
    mcp,
    MARKING_MCP_ACTIONS.checkCodes,
    { codes: [...args.codes] },
    context,
  );
  const checked = parseResult(
    MARKING_MCP_ACTIONS.checkCodes,
    markingCheckResponseSchema,
    raw,
  );
  const result = verifyMarkingShipment(
    checked.results,
    args.expectedItems,
    args.expectedOwnerInn,
  );

  await context.beforeExecute?.();

  return JSON.stringify({ direction: args.direction, ...result });
}

/** Акт о расхождении: вызывается только после HITL-одобрения. */
export async function markingReportViolation(
  mcp: MarketplaceMcpService,
  args: MarkingReportViolationArgs,
  context: MarkingToolContext = {},
): Promise<string> {
  const raw = await callMarking(
    mcp,
    MARKING_MCP_ACTIONS.reportViolation,
    {
      docId: args.documentRef ?? 'manual-violation',
      discrepancies: args.codes.map((cis) => ({
        cis,
        reason: args.reason,
        ...(args.gtin === undefined ? {} : { gtin: args.gtin }),
      })),
    },
    context,
  );
  const parsed = parseResult(
    MARKING_MCP_ACTIONS.reportViolation,
    markingReportResponseSchema,
    raw,
  );

  await context.beforeExecute?.();

  return JSON.stringify(parsed);
}

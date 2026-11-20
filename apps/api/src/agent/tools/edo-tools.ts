import { z } from 'zod';
import { mcpProviderError } from './mcp-gateway.js';
import type {
  MarketplaceCallOptions,
  MarketplaceMcpService,
} from './marketplace-mcp.service.js';
import {
  type EdoGetDocumentDetailsArgs,
  type EdoListIncomingArgs,
  type EdoPrepareSignPacketArgs,
  type EdoReconcileWithErpArgs,
} from './tool-schemas.js';
import { EDO_MCP_ACTIONS } from './mcp-gateway.js';

/** Контекст вызова EDO-инструмента (аналог ErpToolContext). */
export interface EdoToolContext extends MarketplaceCallOptions {
  readonly beforeExecute?: () => Promise<void>;
}

export interface EdoDocumentSummary {
  readonly id: string;
  readonly title: string;
  readonly type?: string;
  readonly counterparty?: string;
  readonly inn?: string;
  readonly amountRub?: number;
  readonly status?: string;
}

export interface EdoDocumentItem {
  readonly name: string;
  readonly quantity: number;
  readonly priceRub: number;
  readonly vatRub?: number;
}

export interface EdoDocumentDetails {
  readonly id: string;
  readonly title: string;
  readonly supplier?: string;
  readonly inn?: string;
  readonly items: readonly EdoDocumentItem[];
  readonly totalRub?: number;
}

export type EdoDiscrepancyType =
  | 'missing'
  | 'extra'
  | 'quantity'
  | 'price'
  | 'total';

export interface EdoDiscrepancy {
  readonly type: EdoDiscrepancyType;
  readonly item: string;
  readonly message: string;
  readonly expectedMinor?: number;
  readonly actualMinor?: number;
}

const edoDocumentSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  type: z.string().optional(),
  counterparty: z.string().optional(),
  inn: z.string().optional(),
  amountRub: z.number().optional(),
  status: z.string().optional(),
});
const edoListResponseSchema = z.object({
  documents: z.array(edoDocumentSchema),
});
const edoDetailsResponseSchema = z.object({
  id: z.string().min(1).default(''),
  title: z.string().min(1).default(''),
  supplier: z.string().optional(),
  inn: z.string().optional(),
  items: z
    .array(
      z.object({
        name: z.string().min(1),
        quantity: z.number(),
        priceRub: z.number(),
        vatRub: z.number().optional(),
      }),
    )
    .default([]),
  totalRub: z.number().optional(),
});
const edoPacketResponseSchema = z
  .object({
    packetId: z.string().optional(),
    documentId: z.string().optional(),
    documentIds: z.array(z.string()).optional(),
    status: z.string().optional(),
    unsigned: z.boolean().optional(),
  })
  .passthrough();

function toMinorRub(value: number): number {
  return Math.round(value * 100);
}

function normalizeName(name: string): string {
  return name.trim().toLowerCase().replace(/\s+/g, ' ');
}

/**
 * Детерминированная сверка УПД с заказом 1С/МойСклад (EDO-41.3).
 * Все сравнения денег — в копейках, чтобы избежать ошибок float.
 */
export function reconcileDocumentWithOrder(
  document: EdoDocumentDetails,
  orderItems: readonly { name: string; quantity: number; priceRub: number }[],
  orderTotalRub?: number,
): { matched: boolean; discrepancies: EdoDiscrepancy[] } {
  const discrepancies: EdoDiscrepancy[] = [];
  const documentItems = new Map(
    document.items.map((item) => [normalizeName(item.name), item]),
  );
  const order = new Map(
    orderItems.map((item) => [normalizeName(item.name), item]),
  );

  for (const [name, docItem] of documentItems) {
    const orderItem = order.get(name);

    if (orderItem === undefined) {
      discrepancies.push({
        type: 'missing',
        item: docItem.name,
        message: `Позиция «${docItem.name}» отсутствует в заказе`,
      });
      continue;
    }

    if (toMinorRub(docItem.quantity) !== toMinorRub(orderItem.quantity)) {
      discrepancies.push({
        type: 'quantity',
        item: docItem.name,
        message: `Расхождение количества по «${docItem.name}»`,
        expectedMinor: toMinorRub(orderItem.quantity),
        actualMinor: toMinorRub(docItem.quantity),
      });
    }

    if (toMinorRub(docItem.priceRub) !== toMinorRub(orderItem.priceRub)) {
      discrepancies.push({
        type: 'price',
        item: docItem.name,
        message: `Расхождение цены по «${docItem.name}»`,
        expectedMinor: toMinorRub(orderItem.priceRub),
        actualMinor: toMinorRub(docItem.priceRub),
      });
    }
  }

  for (const [name, orderItem] of order) {
    if (!documentItems.has(name)) {
      discrepancies.push({
        type: 'extra',
        item: orderItem.name,
        message: `Позиция «${orderItem.name}» есть в заказе, но отсутствует в УПД`,
      });
    }
  }

  const documentTotalMinor = toMinorRub(
    document.totalRub ??
      document.items.reduce(
        (sum, item) => sum + item.quantity * item.priceRub,
        0,
      ),
  );
  const orderTotalMinor = toMinorRub(
    orderTotalRub ??
      orderItems.reduce((sum, item) => sum + item.quantity * item.priceRub, 0),
  );

  if (documentTotalMinor !== orderTotalMinor) {
    discrepancies.push({
      type: 'total',
      item: 'Итого',
      message: 'Расхождение итоговой суммы УПД и заказа',
      expectedMinor: orderTotalMinor,
      actualMinor: documentTotalMinor,
    });
  }

  return { matched: discrepancies.length === 0, discrepancies };
}

async function callEdo(
  mcp: MarketplaceMcpService,
  provider: 'diadoc' | 'sbis',
  action: string,
  params: Record<string, unknown>,
  context: EdoToolContext,
): Promise<unknown> {
  const text = await mcp.call(provider, action, params, context);

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

/** Список входящих УПД/актов. */
export async function edoListIncomingUpd(
  mcp: MarketplaceMcpService,
  args: EdoListIncomingArgs,
  context: EdoToolContext = {},
): Promise<string> {
  const raw = await callEdo(
    mcp,
    args.provider,
    EDO_MCP_ACTIONS.listIncoming,
    args.limit === undefined ? {} : { limit: args.limit },
    context,
  );
  const parsed = parseResult(
    EDO_MCP_ACTIONS.listIncoming,
    edoListResponseSchema,
    raw,
  );

  await context.beforeExecute?.();

  return JSON.stringify({ documents: parsed.documents });
}

/** Детальная спецификация документа. */
export async function edoGetDocumentDetails(
  mcp: MarketplaceMcpService,
  args: EdoGetDocumentDetailsArgs,
  context: EdoToolContext = {},
): Promise<string> {
  const raw = await callEdo(
    mcp,
    args.provider,
    EDO_MCP_ACTIONS.getDetails,
    { documentId: args.documentId },
    context,
  );
  const parsed = parseResult(
    EDO_MCP_ACTIONS.getDetails,
    edoDetailsResponseSchema,
    raw,
  );

  await context.beforeExecute?.();

  return JSON.stringify(parsed);
}

/** Сверка УПД с заказом ERP: возвращает matched и расхождения в копейках. */
export async function edoReconcileWithErp(
  mcp: MarketplaceMcpService,
  args: EdoReconcileWithErpArgs,
  context: EdoToolContext = {},
): Promise<string> {
  const raw = await callEdo(
    mcp,
    args.provider,
    EDO_MCP_ACTIONS.getDetails,
    { provider: args.provider, documentId: args.documentId },
    context,
  );
  const document = parseResult(
    EDO_MCP_ACTIONS.getDetails,
    edoDetailsResponseSchema,
    raw,
  );
  const result = reconcileDocumentWithOrder(
    document,
    args.orderItems,
    args.orderTotalRub,
  );

  await context.beforeExecute?.();

  return JSON.stringify({
    documentId: args.documentId,
    ...result,
  });
}

/** Подготовка пакета на подпись КЭП (выполняется только после HITL). */
export async function edoPrepareSignPacket(
  mcp: MarketplaceMcpService,
  args: EdoPrepareSignPacketArgs,
  context: EdoToolContext = {},
): Promise<string> {
  const packets = [];

  for (const documentId of args.documentIds) {
    const raw = await callEdo(
      mcp,
      args.provider,
      EDO_MCP_ACTIONS.prepareSign,
      { documentId, signer: args.signer },
      context,
    );

    packets.push(
      parseResult(EDO_MCP_ACTIONS.prepareSign, edoPacketResponseSchema, raw),
    );
  }

  await context.beforeExecute?.();

  return JSON.stringify({ packets });
}

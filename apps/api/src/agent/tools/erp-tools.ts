/**
 * Инструменты Треков K (Опт) и L (Производство): CRM Битрикс24 и склад
 * МойСклад.
 *
 * Контракт с MCP-серверами (`infra/mcp/bitrix24`, `infra/mcp/moysklad`):
 *  - `crm_deal_get` / `crm_deal_update` — сделка Битрикс24;
 *  - `product_get` — товар МойСклад (остаток и закупочная цена);
 *  - `customer_order_create` — заказ покупателя МойСклад.
 *
 * Слой осознанно тонкий: он переводит аргументы LLM в параметры MCP-действия,
 * проверяет ответ провайдера Zod-схемой и отдаёт агенту нормализованный JSON.
 * REST-вызовы, таймауты и retry остаются за `MarketplaceMcpService`.
 */
import { z } from 'zod';
import type { ApiException } from '../../common/api-error.js';
import {
  BITRIX24_MCP_ACTIONS,
  MOYSKLAD_MCP_ACTIONS,
  mcpProviderError,
} from './mcp-gateway.js';
import type {
  MarketplaceCallOptions,
  MarketplaceMcpService,
} from './marketplace-mcp.service.js';
import type {
  Bitrix24GetDealArgs,
  Bitrix24UpdateDealArgs,
  MoyskladCheckStockArgs,
  MoyskladCreateOrderArgs,
  MoyskladGetCostArgs,
} from './tool-schemas.js';

/** Контекст вызова ERP-инструмента (endpoint берётся из манифеста навыка). */
export interface ErpToolContext extends MarketplaceCallOptions {
  /** Списание Pay-per-Call: вызывается после успешного ответа MCP. */
  beforeExecute?: () => Promise<void>;
}

/** Сделку можно закрыть только стадией успеха (WON в любой воронке). */
export function isFinalDealStage(stageId: string): boolean {
  const normalized = stageId.trim().toUpperCase();

  return normalized === 'WON' || normalized.endsWith(':WON');
}

/** Число или строка с числом → число (Битрикс24 отдаёт и так, и так). */
const numericSchema = z
  .union([z.number(), z.string().regex(/^-?\d+(?:[.,]\d+)?$/)])
  .transform((value) =>
    typeof value === 'number' ? value : Number(value.replace(',', '.')),
  );

/** Идентификатор Битрикс24: число или строка → строка. */
const bitrixIdSchema = z
  .union([z.string().min(1), z.number().int()])
  .transform(String);

/** Сделка Битрикс24 в ответе `crm.deal.get` (`result`). */
const bitrixDealSchema = z.object({
  ID: bitrixIdSchema,
  TITLE: z.string().optional(),
  STAGE_ID: z.string().optional(),
  OPPORTUNITY: numericSchema.optional(),
  CURRENCY_ID: z.string().optional(),
  COMMENTS: z.string().optional(),
  COMPANY_ID: bitrixIdSchema.optional(),
  CONTACT_ID: bitrixIdSchema.optional(),
  ASSIGNED_BY_ID: bitrixIdSchema.optional(),
});

const bitrixDealResponseSchema = z.object({ result: bitrixDealSchema });

const bitrixUpdateResponseSchema = z.object({
  result: z.union([z.boolean(), z.record(z.string(), z.unknown())]),
});

/** Товар МойСклад: остаток, резерв и закупочная цена. */
const moyskladProductSchema = z.object({
  id: z.string().min(1),
  name: z.string().optional(),
  article: z.string().optional(),
  code: z.string().optional(),
  stock: numericSchema.optional(),
  reserve: numericSchema.optional(),
  buyPrice: z.object({ value: numericSchema }).optional(),
  salePrices: z.array(z.object({ value: numericSchema })).optional(),
  meta: z.object({ href: z.string().min(1) }).optional(),
});

/** Заказ покупателя в ответе `customer_order_create`. */
const moyskladOrderSchema = z.object({
  id: z.string().min(1),
  name: z.string().optional(),
  sum: numericSchema.optional(),
  description: z.string().optional(),
});

/** Копейки МойСклад / 100 → рубли с двумя знаками. */
function minorToRubles(value: number): number {
  return Math.round(value) / 100;
}

/** Рубли → копейки для тела заказа. */
function rublesToMinor(value: number): number {
  return Math.round(value * 100);
}

/** Разбирает JSON-ответ MCP; не-JSON текст — ошибка провайдера. */
function parseMcpJson(action: string, text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    throw providerFailure(action, text);
  }
}

/**
 * Ошибка провайдера с сохранением HTTP-статуса из текста MCP-сервера:
 * агент и пользователь видят причину (401/429), а не «неизвестный сбой».
 */
function providerFailure(action: string, text: string): ApiException {
  const status = /HTTP (\d{3})/.exec(text)?.[1];

  return mcpProviderError(
    status === undefined
      ? `MCP-действие ${action} вернуло некорректный ответ`
      : `MCP-действие ${action}: провайдер ответил HTTP ${status}`,
  );
}

/** Валидирует ответ провайдера; расхождение схемы — тоже ошибка провайдера. */
function parseProviderResult<T>(
  action: string,
  schema: z.ZodType<T>,
  raw: unknown,
): T {
  const parsed = schema.safeParse(raw);

  if (!parsed.success) {
    throw mcpProviderError(
      `MCP-действие ${action} вернуло ответ неизвестного формата`,
    );
  }

  return parsed.data;
}

/** Получает сделку Битрикс24 и отдаёт нормализованное представление. */
export async function bitrix24GetDeal(
  mcp: MarketplaceMcpService,
  args: Bitrix24GetDealArgs,
  context: ErpToolContext = {},
): Promise<string> {
  const action = BITRIX24_MCP_ACTIONS.dealGet;
  const text = await mcp.call('bitrix24', action, { id: args.dealId }, context);
  const response = parseProviderResult(
    action,
    bitrixDealResponseSchema,
    parseMcpJson(action, text),
  );
  const deal = response.result;

  await context.beforeExecute?.();

  return JSON.stringify({
    dealId: deal.ID,
    title: deal.TITLE,
    stageId: deal.STAGE_ID,
    stageFinal:
      deal.STAGE_ID === undefined ? false : isFinalDealStage(deal.STAGE_ID),
    amount: deal.OPPORTUNITY,
    currency: deal.CURRENCY_ID,
    comments: deal.COMMENTS,
    companyId: deal.COMPANY_ID,
    contactId: deal.CONTACT_ID,
    assignedById: deal.ASSIGNED_BY_ID,
  });
}

/**
 * Обновляет сделку Битрикс24: стадию и/или комментарий.
 *
 * Смена стадии на финальную (`WON`) — необратимое действие: политика
 * `bitrix24_update_deal` помечает его как HITL (`final-stage`), Runtime
 * выполняет вызов только после подтверждения пользователя.
 */
export async function bitrix24UpdateDeal(
  mcp: MarketplaceMcpService,
  args: Bitrix24UpdateDealArgs,
  context: ErpToolContext = {},
): Promise<string> {
  const action = BITRIX24_MCP_ACTIONS.dealUpdate;
  const fields: Record<string, string> = {};

  if (args.stageId !== undefined) {
    fields['STAGE_ID'] = args.stageId;
  }

  if (args.comments !== undefined) {
    fields['COMMENTS'] = args.comments;
  }

  const text = await mcp.call(
    'bitrix24',
    action,
    { id: args.dealId, fields },
    context,
  );
  const response = parseProviderResult(
    action,
    bitrixUpdateResponseSchema,
    parseMcpJson(action, text),
  );

  await context.beforeExecute?.();

  return JSON.stringify({
    dealId: args.dealId,
    updated: response.result !== false,
    stageId: args.stageId,
    finalStage:
      args.stageId === undefined ? false : isFinalDealStage(args.stageId),
    commentsUpdated: args.comments !== undefined,
  });
}

/** Проверяет доступный остаток товара МойСклад под запрошенное количество. */
export async function moyskladCheckStock(
  mcp: MarketplaceMcpService,
  args: MoyskladCheckStockArgs,
  context: ErpToolContext = {},
): Promise<string> {
  const action = MOYSKLAD_MCP_ACTIONS.productGet;
  const text = await mcp.call(
    'moysklad',
    action,
    { id: args.productId },
    context,
  );
  const product = parseProviderResult(
    action,
    moyskladProductSchema,
    parseMcpJson(action, text),
  );

  if (product.stock === undefined) {
    throw mcpProviderError(
      `МойСклад не вернул остаток товара ${args.productId}: позиция не учитывается по складу`,
    );
  }

  const reserve = product.reserve ?? 0;
  const available = Math.max(product.stock - reserve, 0);

  await context.beforeExecute?.();

  return JSON.stringify({
    productId: product.id,
    name: product.name,
    article: product.article,
    onHand: product.stock,
    reserve,
    available,
    requested: args.quantity,
    enough: available >= args.quantity,
  });
}

/** Возвращает себестоимость единицы товара (закупочную цену) в рублях. */
export async function moyskladGetCost(
  mcp: MarketplaceMcpService,
  args: MoyskladGetCostArgs,
  context: ErpToolContext = {},
): Promise<string> {
  const action = MOYSKLAD_MCP_ACTIONS.productGet;
  const text = await mcp.call(
    'moysklad',
    action,
    { id: args.productId },
    context,
  );
  const product = parseProviderResult(
    action,
    moyskladProductSchema,
    parseMcpJson(action, text),
  );

  if (product.buyPrice === undefined) {
    throw mcpProviderError(
      `МойСклад не вернул себестоимость товара ${args.productId}: закупочная цена не задана`,
    );
  }

  await context.beforeExecute?.();

  return JSON.stringify({
    productId: product.id,
    name: product.name,
    article: product.article,
    cost: minorToRubles(product.buyPrice.value),
    currency: 'RUB',
    source: 'buyPrice',
  });
}

/**
 * Создаёт заказ покупателя МойСклад по сделке Битрикс24.
 *
 * Позиции собираются по ID товаров: `product_get` даёт `meta.href` (без него
 * JSON API 1.2 не принимает позицию) и цену продажи, если её не передали.
 * Заказ создаётся без организации и контрагента: их должен подставлять
 * MCP-сервер из своего окружения (см. KI-080).
 */
export async function moyskladCreateOrder(
  mcp: MarketplaceMcpService,
  args: MoyskladCreateOrderArgs,
  context: ErpToolContext = {},
): Promise<string> {
  const positions: Array<{
    quantity: number;
    price: number;
    assortment: { meta: { href: string; type: string; mediaType: string } };
  }> = [];

  for (const item of args.items) {
    const productText = await mcp.call(
      'moysklad',
      MOYSKLAD_MCP_ACTIONS.productGet,
      { id: item.productId },
      context,
    );
    const product = parseProviderResult(
      MOYSKLAD_MCP_ACTIONS.productGet,
      moyskladProductSchema,
      parseMcpJson(MOYSKLAD_MCP_ACTIONS.productGet, productText),
    );

    if (product.meta === undefined) {
      throw mcpProviderError(
        `МойСклад не вернул ссылку на товар ${item.productId}`,
      );
    }

    if (item.price === undefined && product.salePrices?.[0] === undefined) {
      throw mcpProviderError(
        `МойСклад не вернул цену продажи товара ${item.productId}: передайте price в позиции`,
      );
    }

    const price =
      item.price ?? minorToRubles(product.salePrices?.[0]?.value ?? 0);

    positions.push({
      quantity: item.quantity,
      price: rublesToMinor(price),
      assortment: {
        meta: {
          href: product.meta.href,
          type: 'product',
          mediaType: 'application/json',
        },
      },
    });
  }

  const action = MOYSKLAD_MCP_ACTIONS.customerOrderCreate;
  const text = await mcp.call(
    'moysklad',
    action,
    {
      payload: {
        description: `Заказ по сделке Битрикс24 #${args.dealId}`,
        positions,
      },
    },
    context,
  );
  const order = parseProviderResult(
    action,
    moyskladOrderSchema,
    parseMcpJson(action, text),
  );

  await context.beforeExecute?.();

  return JSON.stringify({
    orderId: order.id,
    orderName: order.name,
    dealId: args.dealId,
    positions: positions.length,
    sum:
      order.sum === undefined
        ? positions.reduce(
            (total, position) =>
              total + minorToRubles(position.price) * position.quantity,
            0,
          )
        : minorToRubles(order.sum),
  });
}

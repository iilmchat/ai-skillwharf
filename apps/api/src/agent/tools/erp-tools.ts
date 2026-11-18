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
import {
  providerNotConfiguredError,
  type ApiException,
} from '../../common/api-error.js';
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

/** Склад в строке отчёта `stock_report`: строка или объект с `name`. */
const warehouseRefSchema = z.union([
  z.string().min(1),
  z.object({ name: z.string().min(1) }),
]);

/**
 * Строка отчёта `stock_report` (`GET /report/stock/all`).
 *
 * Отчёт может отдавать остаток по складам (`warehouse`/`store`) либо только
 * агрегат по товару — поля необязательны, разбор не должен падать на
 * неполном ответе МойСклада.
 */
const moyskladStockReportRowSchema = z.object({
  article: z.string().optional(),
  code: z.string().optional(),
  name: z.string().optional(),
  stock: numericSchema.optional(),
  reserve: numericSchema.optional(),
  warehouse: warehouseRefSchema.optional(),
  store: warehouseRefSchema.optional(),
});

/** Ответ `stock_report`: массив строк или конверт `{ rows }`. */
const moyskladStockReportSchema = z.union([
  z.array(moyskladStockReportRowSchema),
  z.object({ rows: z.array(moyskladStockReportRowSchema) }),
]);

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

/** Название склада в строке отчёта или `undefined`. */
function stockReportWarehouseName(
  row: z.infer<typeof moyskladStockReportRowSchema>,
): string | undefined {
  const ref = row.warehouse ?? row.store;

  if (ref === undefined) {
    return undefined;
  }

  return typeof ref === 'string' ? ref.trim() : ref.name.trim();
}

/**
 * Остатки по складам из `stock_report` (KI-081).
 *
 * Отчёт — дополнительная детализация: если он недоступен, ошибка провайдера
 * не должна ломать проверку остатка, инструмент возвращает общий остаток
 * карточки с пустым `warehouses`.
 */
async function stockReportWarehouses(
  mcp: MarketplaceMcpService,
  context: ErpToolContext,
  article: string,
): Promise<Array<{ name: string; stock: number }>> {
  const action = MOYSKLAD_MCP_ACTIONS.stockReport;

  try {
    const text = await mcp.call(
      'moysklad',
      action,
      { filter: `article=${article}`, limit: 100 },
      context,
    );
    const parsed = parseProviderResult(
      action,
      moyskladStockReportSchema,
      parseMcpJson(action, text),
    );
    const rows = Array.isArray(parsed) ? parsed : parsed.rows;
    const byWarehouse = new Map<string, number>();

    for (const row of rows) {
      const name = stockReportWarehouseName(row);

      if (name === undefined || name === '' || row.stock === undefined) {
        continue;
      }

      byWarehouse.set(name, (byWarehouse.get(name) ?? 0) + row.stock);
    }

    return [...byWarehouse.entries()].map(([name, stock]) => ({ name, stock }));
  } catch {
    return [];
  }
}

/**
 * Проверяет доступный остаток товара МойСклад под запрошенное количество.
 *
 * Для услуг, комплектов и других нетарифицируемых позиций в карточке нет
 * `stock`/`reserve`: это не ошибка провайдера, а `tracked: false` с
 * `available: true` (KI-081). Для товаров с артикулом дополнительно
 * запрашивается `stock_report` с разбивкой по складам; при недоступном
 * отчёте остаётся общий остаток карточки.
 */
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
    await context.beforeExecute?.();

    return JSON.stringify({
      productId: product.id,
      tracked: false,
      available: true,
      stock: null,
      reserve: null,
      reason: 'untracked_item',
    });
  }

  const reserve = product.reserve ?? 0;
  const available = Math.max(product.stock - reserve, 0);
  const warehouses =
    product.article === undefined
      ? []
      : await stockReportWarehouses(mcp, context, product.article);

  await context.beforeExecute?.();

  return JSON.stringify({
    productId: product.id,
    name: product.name,
    article: product.article,
    tracked: true,
    onHand: product.stock,
    reserve,
    available,
    requested: args.quantity,
    enough: available >= args.quantity,
    warehouses,
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

/** Ссылка на сущность МойСклада для тела JSON API 1.2. */
type MoyskladMetaLink = {
  meta: { href: string; type: string; mediaType: string };
};

/** Обязательные поля заказа покупателя: организация и контрагент. */
interface MoyskladOrderDefaults {
  readonly organization: MoyskladMetaLink;
  readonly agent: MoyskladMetaLink;
}

/** Базовый URL JSON API 1.2, если `MOYSKLAD_BASE_URL` не задан. */
const DEFAULT_MOYSKLAD_BASE_URL = 'https://api.moysklad.ru/api/remap/1.2';

/** ID сущности МойСклада: UUID/код, ровно как в `meta.href`. */
const MOYSKLAD_ENTITY_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

/** Читает непустое значение окружения или `null`. */
function readOptionalEnv(name: string): string | null {
  const value = process.env[name]?.trim() ?? '';

  return value === '' ? null : value;
}

/**
 * Организация и контрагент по умолчанию для заказа покупателя.
 *
 * JSON API 1.2 требует оба поля, а в сделке Битрикс24 лежат только ID
 * компании/контакта CRM, которые не являются сущностями МойСклада. Для
 * пилота берём дефолтные ID из окружения API (KI-080); если их нет или
 * формат неверный — понятная 503 `errors.provider_not_configured`, а не 412
 * от МойСклада после успешного сбора позиций.
 */
function resolveMoyskladOrderDefaults(): MoyskladOrderDefaults {
  const organizationId = readOptionalEnv('MOYSKLAD_DEFAULT_ORGANIZATION_ID');
  const agentId = readOptionalEnv('MOYSKLAD_DEFAULT_AGENT_ID');
  const missing: string[] = [];

  if (organizationId === null) {
    missing.push('MOYSKLAD_DEFAULT_ORGANIZATION_ID');
  }

  if (agentId === null) {
    missing.push('MOYSKLAD_DEFAULT_AGENT_ID');
  }

  if (missing.length > 0) {
    throw providerNotConfiguredError(
      `МойСклад: заказ покупателя требует организацию и контрагента. Задайте ${missing.join(', ')} (ID сущностей МойСклада)`,
    );
  }

  if (
    !MOYSKLAD_ENTITY_ID_PATTERN.test(organizationId ?? '') ||
    !MOYSKLAD_ENTITY_ID_PATTERN.test(agentId ?? '')
  ) {
    throw providerNotConfiguredError(
      'МойСклад: MOYSKLAD_DEFAULT_ORGANIZATION_ID и MOYSKLAD_DEFAULT_AGENT_ID должны быть ID сущностей (буквы, цифры, дефис и подчёркивание)',
    );
  }

  const base = (
    readOptionalEnv('MOYSKLAD_BASE_URL') ?? DEFAULT_MOYSKLAD_BASE_URL
  ).replace(/\/+$/, '');

  return {
    organization: {
      meta: {
        href: `${base}/entity/organization/${organizationId}`,
        type: 'organization',
        mediaType: 'application/json',
      },
    },
    agent: {
      meta: {
        href: `${base}/entity/counterparty/${agentId}`,
        type: 'counterparty',
        mediaType: 'application/json',
      },
    },
  };
}

/**
 * Создаёт заказ покупателя МойСклад по сделке Битрикс24.
 *
 * Позиции собираются по ID товаров: `product_get` даёт `meta.href` (без него
 * JSON API 1.2 не принимает позицию) и цену продажи, если её не передали.
 * Организация и контрагент — обязательные поля заказа: для пилота они берутся
 * из `MOYSKLAD_DEFAULT_ORGANIZATION_ID`/`MOYSKLAD_DEFAULT_AGENT_ID`, иначе
 * вызов падает с 503 `errors.provider_not_configured` (KI-080).
 */
export async function moyskladCreateOrder(
  mcp: MarketplaceMcpService,
  args: MoyskladCreateOrderArgs,
  context: ErpToolContext = {},
): Promise<string> {
  // Проверяем конфигурацию до вызовов MCP: не собираем позиции впустую.
  const defaults = resolveMoyskladOrderDefaults();
  const positions: Array<{
    quantity: number;
    price: number;
    assortment: MoyskladMetaLink;
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
        organization: defaults.organization,
        agent: defaults.agent,
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

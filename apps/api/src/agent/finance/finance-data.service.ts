import { Injectable, Logger } from '@nestjs/common';
import { mcpProviderError } from '../tools/mcp-gateway.js';
import { MarketplaceMcpService } from '../tools/marketplace-mcp.service.js';
import type { MarketplaceSkillSnapshot } from '../tools/marketplace-mcp.service.js';
import {
  assertOzonPeriod,
  containsMarker,
  extractRows,
  isRecord,
  parseMcpJson,
  readNumber,
  readString,
  toNumber,
  type FinancePeriod,
} from './finance.schemas.js';

/** Строка услуг Ozon (type_id + расшифровка, если сервер её отдал). */
export interface OzonServiceLine {
  readonly name: string;
  readonly amount: number;
}

/** Финансовая транзакция Ozon (начисление) за период. */
export interface OzonTransactionRow {
  readonly category: string;
  readonly amount: number;
  readonly date: string | null;
}

/** Итоги финансов Ozon за период (реальные начисления из accrual/by-day). */
export interface OzonFinanceTotals {
  readonly total: number;
  readonly byCategory: Readonly<Record<string, number>>;
  readonly services: readonly OzonServiceLine[];
  readonly returnsAndCancellations: number;
  readonly accruals: number;
}

/** Аналитика Ozon по конкретному SKU. */
export interface OzonSkuAnalytics {
  readonly sku: string;
  readonly found: boolean;
  readonly revenue: number | null;
  readonly orderedUnits: number | null;
  readonly returns: number | null;
}

/** Цена товара Ozon из `/v5/product/info/prices`. */
export interface OzonPriceInfo {
  readonly offerId: string | null;
  readonly productId: string | null;
  readonly price: number;
  readonly priceIndex: number | null;
}

/** Строка отчёта о реализации WB (реальные комиссии/логистика/штрафы). */
export interface WbFinanceRow {
  readonly nmId: string | null;
  readonly vendorCode: string | null;
  readonly retailAmount: number;
  readonly commission: number;
  readonly logistics: number;
  readonly returns: number;
  readonly penalty: number;
  readonly deduction: number;
  readonly storage: number;
  readonly acceptance: number;
  readonly acquiring: number;
  readonly payout: number;
  readonly quantity: number;
}

/** Цена WB из `/api/v2/list/goods/filter`. */
export interface WbPriceRow {
  readonly nmId: string | null;
  readonly price: number | null;
  readonly discount: number | null;
}

/** Удержание/штраф WB. */
export interface WbDeductionRow {
  readonly nmId: string | null;
  readonly amount: number;
  readonly reason: string | null;
  readonly date: string | null;
}

/** Параметры выбора магазина (мульти-магазинные MCP-серверы). */
export interface FinanceQueryContext {
  readonly skills?: readonly MarketplaceSkillSnapshot[];
  readonly shopId?: string;
}

const OZON_ROWS = ['result', 'data', 'list', 'items', 'accruals'] as const;
const WB_ROWS = [
  'report',
  'reports',
  'data',
  'list',
  'items',
  'rows',
  'adverts',
  'history',
] as const;

/**
 * Реальные данные Ozon/WB через MCP.
 *
 * Никаких демонстрационных значений: если MCP вернул не JSON или пустой
 * обязательный набор полей — `errors.mcp_provider`; если записей по
 * конкретному SKU нет — `found: false` (это тоже реальный ответ).
 */
@Injectable()
export class FinanceDataService {
  private readonly logger = new Logger(FinanceDataService.name);

  constructor(private readonly mcp: MarketplaceMcpService) {}

  /** Итоги финансов Ozon за период (комиссии, логистика, возвраты). */
  async ozonFinanceTotals(
    period: FinancePeriod,
    context: FinanceQueryContext = {},
  ): Promise<OzonFinanceTotals> {
    assertOzonPeriod(period);

    const text = await this.mcp.call(
      'ozon',
      'ozon_finance_totals',
      {
        date_from: `${period.from}T00:00:00Z`,
        date_to: `${period.to}T23:59:59Z`,
        ...this.shopParam(context),
      },
      context,
    );
    const payload = parseMcpJson('Ozon', 'ozon_finance_totals', text);

    if (!isRecord(payload)) {
      throw mcpProviderError(
        'Ozon: ozon_finance_totals вернул не объект с итогами',
      );
    }

    const total = toNumber(payload.total);
    const byCategory = readNumberMap(payload.by_category);
    const returns = toNumber(payload.returns_and_cancellations) ?? 0;
    const services = readServiceLines(payload.by_service);

    if (total === null && services.length === 0) {
      throw mcpProviderError(
        'Ozon: ozon_finance_totals не содержит total/by_service',
      );
    }

    return {
      total: total ?? services.reduce((sum, line) => sum + line.amount, 0),
      byCategory,
      services,
      returnsAndCancellations: returns,
      accruals: toNumber(payload.accruals) ?? 0,
    };
  }

  /**
   * Финансовые операции Ozon за период.
   *
   * Аудит API (11.2026) указывает `/v3/finance/transaction/list`, но этот
   * endpoint отключён Ozon: MCP-сервер `ozon-mcp-server` пересобирает
   * операции из `/v1/finance/accrual/by-day`. Мы не вызываем «выдуманный»
   * URL напрямую — используем MCP-действие, которое инкапсулирует
   * актуальный источник (см. комментарий в `server.py` пакета).
   */
  async ozonFinanceTransactions(
    period: FinancePeriod,
    context: FinanceQueryContext = {},
  ): Promise<OzonTransactionRow[]> {
    assertOzonPeriod(period);

    const text = await this.mcp.call(
      'ozon',
      'ozon_finance_transactions',
      {
        date_from: `${period.from}T00:00:00Z`,
        date_to: `${period.to}T23:59:59Z`,
        page: 1,
        page_size: 1000,
        view: 'full',
        ...this.shopParam(context),
      },
      context,
    );
    const payload = parseMcpJson('Ozon', 'ozon_finance_transactions', text);
    const rows = extractRows(payload, ['accruals', 'data', 'items']);

    return rows.map((row) => ({
      category:
        readString(row, ['accrued_category', 'category', 'type']) ??
        'UNKNOWN',
      amount: readNumber(row, ['total_amount', 'amount', 'sum']) ?? 0,
      date: readString(row, ['date', 'created_at']),
    }));
  }

  /** Аналитика Ozon по SKU: выручка, заказы, возвраты. */
  async ozonSkuAnalytics(
    period: FinancePeriod,
    sku: string,
    context: FinanceQueryContext = {},
  ): Promise<OzonSkuAnalytics> {
    assertOzonPeriod(period);

    const text = await this.mcp.call(
      'ozon',
      'ozon_analytics',
      {
        date_from: period.from,
        date_to: period.to,
        metrics: ['revenue', 'ordered_units', 'returns'],
        dimensions: ['sku'],
        limit: 1000,
        ...this.shopParam(context),
      },
      context,
    );
    const payload = parseMcpJson('Ozon', 'ozon_analytics', text);
    const result = isRecord(payload) && isRecord(payload.result)
      ? payload.result
      : null;
    const rows = result !== null && Array.isArray(result.data)
      ? result.data.filter(isRecord)
      : [];

    const row = rows.find((item) => {
      const dimensions = item.dimensions;

      return (
        Array.isArray(dimensions) &&
        dimensions.some((dimension) => String(dimension) === sku)
      );
    });

    if (row === undefined) {
      return {
        sku,
        found: false,
        revenue: null,
        orderedUnits: null,
        returns: null,
      };
    }

    const metrics = Array.isArray(row.metrics) ? row.metrics : [];

    return {
      sku,
      found: true,
      revenue: toNumber(metrics[0]),
      orderedUnits: toNumber(metrics[1]),
      returns: toNumber(metrics[2]),
    };
  }

  /** Выручка всех SKU за период (для распределения общих расходов Ozon). */
  async ozonRevenueRows(
    period: FinancePeriod,
    context: FinanceQueryContext = {},
  ): Promise<number[]> {
    assertOzonPeriod(period);

    const text = await this.mcp.call(
      'ozon',
      'ozon_analytics',
      {
        date_from: period.from,
        date_to: period.to,
        metrics: ['revenue'],
        dimensions: ['sku'],
        limit: 1000,
        ...this.shopParam(context),
      },
      context,
    );
    const payload = parseMcpJson('Ozon', 'ozon_analytics', text);
    const result =
      isRecord(payload) && isRecord(payload.result) ? payload.result : null;
    const rows =
      result !== null && Array.isArray(result.data)
        ? result.data.filter(isRecord)
        : [];

    return rows
      .map((row) => {
        const metrics = Array.isArray(row.metrics) ? row.metrics : [];
        const revenue = toNumber(metrics[0]);

        return revenue === null ? null : revenue;
      })
      .filter((revenue): revenue is number => revenue !== null);
  }

  /**
   * Текущая цена Ozon по offer_id или product_id.
   *
   * Аудит (11.2026) называет `/v1/product/import/prices`, но это write-метод
   * импорта цен; чтение MCP-сервер выполняет через
   * `/v5/product/info/prices` (v4 удалён Ozon). Используем MCP-действие
   * `ozon_get_prices`, чтобы не вызывать write-endpoint для чтения.
   */
  async ozonPrice(
    sku: string,
    context: FinanceQueryContext = {},
  ): Promise<OzonPriceInfo | null> {
    const numeric = Number.parseInt(sku, 10);
    const filter = Number.isInteger(numeric) && String(numeric) === sku
      ? { product_id: [numeric] }
      : { offer_id: [sku] };
    const text = await this.mcp.call(
      'ozon',
      'ozon_get_prices',
      { ...filter, limit: 10, view: 'full', ...this.shopParam(context) },
      context,
    );
    const rows = extractRows(
      parseMcpJson('Ozon', 'ozon_get_prices', text),
      OZON_ROWS,
    );
    const row = rows.find((item) => {
      const offerId = readString(item, ['offer_id', 'offerId']);
      const productId = readString(item, ['product_id', 'productId']);

      return offerId === sku || productId === sku || rows.length === 1;
    });

    if (row === undefined) {
      return null;
    }

    const priceBlock = isRecord(row.price) ? row.price : row;
    const price = readNumber(priceBlock, ['price', 'price_amount', 'amount']);

    if (price === null) {
      throw mcpProviderError('Ozon: ozon_get_prices не содержит price');
    }

    const priceIndex = readNumber(row, [
      'price_index',
      'priceIndex',
      'price_index_value',
    ]);

    return {
      offerId: readString(row, ['offer_id', 'offerId']),
      productId: readString(row, ['product_id', 'productId']),
      price,
      priceIndex,
    };
  }

  /** Цена товара у конкурента (Ozon Pricing API). */
  async ozonCompetitorPrice(
    productId: number,
    context: FinanceQueryContext = {},
  ): Promise<number> {
    const text = await this.mcp.call(
      'ozon',
      'ozon_pricing_competitor_prices',
      { product_id: productId, ...this.shopParam(context) },
      context,
    );
    const payload = parseMcpJson(
      'Ozon',
      'ozon_pricing_competitor_prices',
      text,
    );
    const price = findNumericByKey(payload, /price/i);

    if (price === null) {
      throw mcpProviderError(
        'Ozon: pricing API не вернул цену конкурента',
      );
    }

    return price;
  }

  /** Рекламные кампании Ozon (сырые записи для аудита ERID/UTM). */
  async ozonCampaigns(
    campaignIds: readonly number[] | undefined,
    context: FinanceQueryContext = {},
  ): Promise<ReadonlyArray<Record<string, unknown>>> {
    const text = await this.mcp.call(
      'ozon',
      'ozon_ad_campaigns',
      {
        ...(campaignIds === undefined ? {} : { campaign_ids: [...campaignIds] }),
        view: 'full',
        ...this.shopParam(context),
      },
      context,
    );
    const payload = parseMcpJson('Ozon', 'ozon_ad_campaigns', text);

    return extractRows(payload, ['list', 'campaigns', 'result', 'data']);
  }

  /** Расход на рекламу Ozon за период (если API вернул суммы). */
  async ozonAdExpenses(
    campaignIds: readonly number[] | undefined,
    period: FinancePeriod,
    context: FinanceQueryContext = {},
  ): Promise<number> {
    const text = await this.mcp.call(
      'ozon',
      'ozon_ad_statistics_expenses',
      {
        campaigns: [...(campaignIds ?? [])],
        date_from: period.from,
        date_to: period.to,
        ...this.shopParam(context),
      },
      context,
    );
    const payload = parseMcpJson('Ozon', 'ozon_ad_statistics_expenses', text);

    return sumNumericByKey(payload, /(expense|spend|money|amount|cost)/i);
  }

  /** Строки отчёта о реализации WB за период. */
  async wbFinanceRows(
    period: FinancePeriod,
    context: FinanceQueryContext = {},
  ): Promise<WbFinanceRow[]> {
    const text = await this.mcp.call(
      'wb',
      'wb_finance_report',
      { date_from: period.from, date_to: period.to, limit: 500 },
      context,
    );
    const payload = parseMcpJson('WB', 'wb_finance_report', text);
    const rows = extractRows(payload, WB_ROWS);

    return rows.map(normalizeWbFinanceRow);
  }

  /**
   * Цены WB.
   *
   * Цены живут на отдельном хосте `discounts-prices-api.wildberries.ru`;
   * MCP-сервер `wb-mcp-server` читает их через `/api/v2/list/goods/filter`
   * (авторизация — raw `Authorization`, без `Bearer`, это его внутренняя
   * деталь). Наружу отдаём MCP-действие `wb_prices_list`.
   */
  async wbPrices(
    nmId: number | undefined,
    context: FinanceQueryContext = {},
  ): Promise<WbPriceRow[]> {
    const text = await this.mcp.call(
      'wb',
      'wb_prices_list',
      {
        limit: 1000,
        ...(nmId === undefined ? {} : { filter_nm_id: nmId }),
      },
      context,
    );
    const rows = extractRows(parseMcpJson('WB', 'wb_prices_list', text), [
      'data',
      'list',
      'items',
    ]);

    return rows.map((row) => ({
      nmId: readString(row, ['nmID', 'nmId', 'nm_id']),
      price: readNumber(row, ['price', 'Price', 'priceWithDiscount']),
      discount: readNumber(row, ['discount', 'discountPercent']),
    }));
  }

  /** Товары WB в ценовом карантине (аномалии цены). */
  async wbPriceQuarantine(
    context: FinanceQueryContext = {},
  ): Promise<ReadonlyArray<Record<string, unknown>>> {
    const text = await this.mcp.call(
      'wb',
      'wb_prices_quarantine',
      { limit: 100 },
      context,
    );

    return extractRows(parseMcpJson('WB', 'wb_prices_quarantine', text), [
      'data',
      'list',
      'items',
    ]);
  }

  /** Удержания за подмены/неверные вложения. */
  async wbDeductions(
    period: FinancePeriod,
    context: FinanceQueryContext = {},
  ): Promise<WbDeductionRow[]> {
    const text = await this.mcp.call(
      'wb',
      'wb_deductions',
      { date_from: period.from, date_to: period.to, limit: 100 },
      context,
    );
    const rows = extractRows(parseMcpJson('WB', 'wb_deductions', text), [
      'data',
      'list',
      'items',
    ]);

    return rows.map((row) => ({
      nmId: readString(row, ['nm_id', 'nmId', 'nmID']),
      amount:
        readNumber(row, ['sum', 'amount', 'deduction', 'withheld']) ?? 0,
      reason: readString(row, ['reason', 'reason_name', 'description']),
      date: readString(row, ['dt', 'date', 'created_at']),
    }));
  }

  /** Удержания за самовыкупы (отчёт по средам). */
  async wbAntifraud(
    date: string,
    context: FinanceQueryContext = {},
  ): Promise<ReadonlyArray<Record<string, unknown>>> {
    const text = await this.mcp.call(
      'wb',
      'wb_analytics_antifraud',
      { date },
      context,
    );

    return extractRows(parseMcpJson('WB', 'wb_analytics_antifraud', text), [
      'data',
      'list',
      'items',
    ]);
  }

  /** Рекламные кампании WB. */
  async wbAdvertCampaigns(
    ids: readonly number[] | undefined,
    context: FinanceQueryContext = {},
  ): Promise<ReadonlyArray<Record<string, unknown>>> {
    const text = await this.mcp.call(
      'wb',
      'wb_advert_list',
      ids === undefined ? {} : { ids: [...ids] },
      context,
    );

    return extractRows(parseMcpJson('WB', 'wb_advert_list', text), [
      'adverts',
      'data',
      'list',
    ]);
  }

  /** История затрат на рекламу WB. */
  async wbAdvertCosts(
    period: FinancePeriod,
    context: FinanceQueryContext = {},
  ): Promise<number> {
    const text = await this.mcp.call(
      'wb',
      'wb_advert_costs',
      { date_from: period.from, date_to: period.to },
      context,
    );

    return sumNumericByKey(
      parseMcpJson('WB', 'wb_advert_costs', text),
      /(amount|cost|sum|spend|upd_sum)/i,
    );
  }

  /** Проверка наличия ERID/UTM в сырых данных кампаний. */
  campaignMarkers(payload: unknown): { erid: boolean; utm: boolean } {
    return {
      erid: containsMarker(payload, ['erid']),
      utm: containsMarker(payload, ['utm']),
    };
  }

  private shopParam(
    context: FinanceQueryContext,
  ): Record<string, string> {
    return context.shopId === undefined || context.shopId.trim() === ''
      ? {}
      : { shop_id: context.shopId };
  }
}

function readNumberMap(value: unknown): Record<string, number> {
  if (!isRecord(value)) {
    return {};
  }

  const result: Record<string, number> = {};

  for (const [key, raw] of Object.entries(value)) {
    const parsed = toNumber(raw);

    if (parsed !== null) {
      result[key] = parsed;
    }
  }

  return result;
}

function readServiceLines(value: unknown): OzonServiceLine[] {
  if (!isRecord(value)) {
    return [];
  }

  const lines: OzonServiceLine[] = [];

  for (const [name, raw] of Object.entries(value)) {
    const amount = toNumber(raw);

    if (amount !== null) {
      lines.push({ name, amount });
    }
  }

  return lines;
}

function findNumericByKey(value: unknown, keyPattern: RegExp): number | null {
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findNumericByKey(item, keyPattern);

      if (found !== null) {
        return found;
      }
    }

    return null;
  }

  if (!isRecord(value)) {
    return null;
  }

  for (const [key, raw] of Object.entries(value)) {
    if (keyPattern.test(key)) {
      const parsed = toNumber(raw);

      if (parsed !== null) {
        return parsed;
      }
    }

    const nested = findNumericByKey(raw, keyPattern);

    if (nested !== null) {
      return nested;
    }
  }

  return null;
}

function sumNumericByKey(value: unknown, keyPattern: RegExp): number {
  if (Array.isArray(value)) {
    return value.reduce<number>(
      (sum, item) => sum + sumNumericByKey(item, keyPattern),
      0,
    );
  }

  if (!isRecord(value)) {
    return 0;
  }

  let total = 0;

  for (const [key, raw] of Object.entries(value)) {
    if (keyPattern.test(key)) {
      const parsed = toNumber(raw);

      if (parsed !== null) {
        total += parsed;
        continue;
      }
    }

    // Ключ может содержать массив/объект с суммами глубже (например,
    // `expenses: [{money: {amount}}]`) — рекурсия обязательна.
    total += sumNumericByKey(raw, keyPattern);
  }

  return total;
}

function normalizeWbFinanceRow(
  row: Record<string, unknown>,
): WbFinanceRow {
  return {
    nmId: readString(row, ['nmId', 'nm_id', 'nmID']),
    vendorCode: readString(row, ['vendorCode', 'vendor_code', 'sa_name']),
    retailAmount:
      readNumber(row, [
        'retailAmount',
        'retail_amount',
        'retailPriceWithDisc',
        'retail_price_with_disc',
      ]) ?? 0,
    commission:
      readNumber(row, [
        'ppvzSalesCommission',
        'ppvz_sales_commission',
        'commission',
      ]) ?? 0,
    logistics:
      readNumber(row, [
        'deliveryRub',
        'delivery_rub',
        'rebillLogisticCost',
        'rebill_logistic_cost',
      ]) ?? 0,
    returns:
      readNumber(row, ['returnAmount', 'return_amount', 'returnCount']) ?? 0,
    penalty: readNumber(row, ['penalty']) ?? 0,
    deduction: readNumber(row, ['deduction']) ?? 0,
    storage:
      readNumber(row, ['paidStorage', 'paid_storage', 'storage_fee']) ?? 0,
    acceptance:
      readNumber(row, ['paidAcceptance', 'paid_acceptance']) ?? 0,
    acquiring:
      readNumber(row, ['acquiringFee', 'acquiring_fee', 'acquiring']) ?? 0,
    payout:
      readNumber(row, ['ppvzForPay', 'ppvz_for_pay', 'forPay', 'for_pay']) ??
      0,
    quantity: readNumber(row, ['quantity', 'qty']) ?? 0,
  };
}

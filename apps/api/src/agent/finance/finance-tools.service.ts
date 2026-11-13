import { Injectable, Logger } from '@nestjs/common';
import type { MarketplaceSkillSnapshot } from '../tools/marketplace-mcp.service.js';
import {
  FinanceDataService,
  type FinanceQueryContext,
  type OzonFinanceTotals,
  type WbFinanceRow,
} from './finance-data.service.js';
import {
  resolvePeriod,
  type FinancePeriod,
} from './finance.schemas.js';

/** Общий контекст вызова финансового инструмента. */
export interface FinanceToolContext {
  readonly skills?: readonly MarketplaceSkillSnapshot[];
  /** Идентификатор магазина (Ozon `shop_id`); из аргумента sellerId. */
  readonly shopId?: string;
}

/** Вход `calculate_unit_economics`. */
export interface UnitEconomicsInput {
  readonly sku: string;
  readonly marketplace?: 'ozon' | 'wb';
  /** Себестоимость единицы, ₽ (если нет в ответе MCP). */
  readonly cost?: number;
  /** Цена продажи, ₽ (если нет в MCP). */
  readonly price?: number;
  readonly dateFrom?: string;
  readonly dateTo?: string;
  readonly sellerId?: string;
}

/** Вход `detect_profit_leaks`. */
export interface ProfitLeaksInput {
  readonly sellerId: string;
  readonly marketplace?: 'ozon' | 'wb';
  readonly dateFrom?: string;
  readonly dateTo?: string;
}

/** Вход `monitor_competitor_prices`. */
export interface PriceMonitorInput {
  readonly sku: string;
  readonly marketplace?: 'ozon' | 'wb';
  readonly productId?: number;
  readonly sellerId?: string;
}

/** Вход `audit_fraud_risk`. */
export interface FraudAuditInput {
  readonly campaignId: string;
  readonly marketplace?: 'ozon' | 'wb';
  readonly dateFrom?: string;
  readonly dateTo?: string;
  readonly sellerId?: string;
}

/** Найденная утечка/риск. */
export interface FinanceFinding {
  readonly code: string;
  readonly severity: 'low' | 'medium' | 'high';
  readonly amount?: number;
  readonly detail: string;
  readonly source: string;
}

/** Результат unit-economics (JSON уходит в LLM как есть). */
export interface UnitEconomicsResult {
  readonly tool: 'unit-economics';
  readonly marketplace: 'ozon' | 'wb';
  readonly sku: string;
  readonly period: FinancePeriod;
  readonly dataAvailable: boolean;
  readonly reason?: string;
  readonly units?: number;
  readonly revenue?: number;
  readonly revenueCurrency: 'RUB';
  readonly costs?: {
    readonly commission: number;
    readonly logistics: number;
    readonly returns: number;
    readonly storage: number;
    readonly penalties: number;
    readonly acquiring: number;
  };
  readonly costOfGoods?: number | null;
  readonly margin?: number;
  readonly marginPercent?: number;
  readonly perUnit?: {
    readonly price: number | null;
    readonly margin: number | null;
    readonly cost: number | null;
  };
  readonly assumptions: readonly string[];
  readonly sources: readonly string[];
}

const CURRENCY = 'RUB' as const;
const CENTS = 100;

function money(value: number): number {
  return Math.round(value * CENTS) / CENTS;
}

function percent(numerator: number, denominator: number): number {
  if (denominator === 0) {
    return 0;
  }

  return Math.round((numerator / denominator) * 10_000) / 100;
}

/** Категория услуги Ozon/WB по названию (RU/EN). */
function classifyService(
  name: string,
): 'commission' | 'logistics' | 'returns' | 'storage' | 'penalties' | 'acquiring' | 'other' {
  const lower = name.toLowerCase();

  if (/комисс|commission|вознагражд/.test(lower)) {
    return 'commission';
  }

  if (/возврат|return|отмен|cancel/.test(lower)) {
    return 'returns';
  }

  if (/логист|достав|logistic|delivery|перевоз|транспорт/.test(lower)) {
    return 'logistics';
  }

  if (/хранен|storage/.test(lower)) {
    return 'storage';
  }

  if (/штраф|penalt|удержан|deduction/.test(lower)) {
    return 'penalties';
  }

  if (/эквайринг|acquiring/.test(lower)) {
    return 'acquiring';
  }

  return 'other';
}

/** Суммы услуг Ozon по категориям (из by_service MCP-сервера). */
function sumOzonServices(totals: OzonFinanceTotals): {
  commission: number;
  logistics: number;
  returns: number;
  storage: number;
  penalties: number;
  acquiring: number;
  other: number;
} {
  const sums = {
    commission: 0,
    logistics: 0,
    returns: 0,
    storage: 0,
    penalties: 0,
    acquiring: 0,
    other: 0,
  };

  for (const line of totals.services) {
    // type_id 32 — логистика возврата: сервер уже включил её в
    // returns_and_cancellations, отдельно не суммируем.
    if (line.name.startsWith('32')) {
      continue;
    }

    // Начисления Ozon приходят отрицательными (расход); для расчёта
    // маржи и отчёта используем абсолютные суммы.
    sums[classifyService(line.name)] += Math.abs(line.amount);
  }

  sums.returns = Math.abs(totals.returnsAndCancellations);

  return sums;
}

/** Строка WB относится к SKU (vendorCode/nmId). */
function wbRowMatchesSku(row: WbFinanceRow, sku: string): boolean {
  const normalized = sku.trim();

  return (
    row.vendorCode === normalized ||
    row.nmId === normalized ||
    String(row.nmId) === normalized
  );
}

function sumWbRows(rows: readonly WbFinanceRow[]): {
  revenue: number;
  commission: number;
  logistics: number;
  returns: number;
  penalty: number;
  deduction: number;
  storage: number;
  acceptance: number;
  acquiring: number;
  payout: number;
  quantity: number;
} {
  const totals = {
    revenue: 0,
    commission: 0,
    logistics: 0,
    returns: 0,
    penalty: 0,
    deduction: 0,
    storage: 0,
    acceptance: 0,
    acquiring: 0,
    payout: 0,
    quantity: 0,
  };

  for (const row of rows) {
    totals.revenue += row.retailAmount;
    totals.commission += row.commission;
    totals.logistics += row.logistics;
    totals.returns += row.returns;
    totals.penalty += row.penalty;
    totals.deduction += row.deduction;
    totals.storage += row.storage;
    totals.acceptance += row.acceptance;
    totals.acquiring += row.acquiring;
    totals.payout += row.payout;
    totals.quantity += row.quantity;
  }

  return totals;
}

/**
 * Финансовые инструменты на реальных данных MCP.
 *
 * Ни один метод не возвращает демонстрационные суммы: при отсутствии данных
 * `dataAvailable: false` с причиной, при непригодном ответе MCP — ошибка
 * `errors.mcp_provider` из `FinanceDataService`.
 */
@Injectable()
export class FinanceToolsService {
  private readonly logger = new Logger(FinanceToolsService.name);

  constructor(private readonly data: FinanceDataService) {}

  /** Реальная юнит-экономика SKU (Ozon — аналитика + итоги, WB — отчёт). */
  async unitEconomics(
    input: UnitEconomicsInput,
    toolContext: FinanceToolContext = {},
    now: Date = new Date(),
  ): Promise<UnitEconomicsResult> {
    const marketplace = input.marketplace ?? 'ozon';
    const period = resolvePeriod(input, now);
    const context = this.context(input.sellerId, toolContext.skills);

    if (marketplace === 'wb') {
      return this.wbUnitEconomics(input, period, context);
    }

    return this.ozonUnitEconomics(input, period, context);
  }

  /** Утечки прибыли: штрафы, удержания, возвраты, карантин цен. */
  async profitLeaks(
    input: ProfitLeaksInput,
    toolContext: FinanceToolContext = {},
    now: Date = new Date(),
  ): Promise<Record<string, unknown>> {
    const marketplace = input.marketplace ?? 'wb';
    const period = resolvePeriod(input, now);
    const context = this.context(input.sellerId, toolContext.skills);

    return marketplace === 'wb'
      ? this.wbProfitLeaks(period, context)
      : this.ozonProfitLeaks(period, context);
  }

  /** Цены: собственная цена и цена конкурента (если MCP поддерживает). */
  async priceMonitor(
    input: PriceMonitorInput,
    toolContext: FinanceToolContext = {},
  ): Promise<Record<string, unknown>> {
    const marketplace = input.marketplace ?? 'ozon';
    const context = this.context(input.sellerId, toolContext.skills);

    if (marketplace === 'wb') {
      return this.wbPriceMonitor(input, context);
    }

    return this.ozonPriceMonitor(input, context);
  }

  /** Аудит рисков: ERID/UTM, расходы, удержания, антифрод. */
  async fraudAudit(
    input: FraudAuditInput,
    toolContext: FinanceToolContext = {},
    now: Date = new Date(),
  ): Promise<Record<string, unknown>> {
    const marketplace = input.marketplace ?? 'ozon';
    const period = resolvePeriod(input, now);
    const context = this.context(input.sellerId, toolContext.skills);

    return marketplace === 'wb'
      ? this.wbFraudAudit(input, period, context)
      : this.ozonFraudAudit(input, period, context);
  }

  private async ozonUnitEconomics(
    input: UnitEconomicsInput,
    period: FinancePeriod,
    context: FinanceQueryContext,
  ): Promise<UnitEconomicsResult> {
    const [totals, analytics, price] = await Promise.all([
      this.data.ozonFinanceTotals(period, context),
      this.data.ozonSkuAnalytics(period, input.sku, context),
      this.data.ozonPrice(input.sku, context).catch(() => null),
    ]);
    const sources = ['ozon_finance_totals', 'ozon_analytics'];

    if (price !== null) {
      sources.push('ozon_get_prices');
    }

    if (!analytics.found || analytics.revenue === null) {
      return {
        tool: 'unit-economics',
        marketplace: 'ozon',
        sku: input.sku,
        period,
        dataAvailable: false,
        revenueCurrency: CURRENCY,
        reason: 'Ozon analytics не вернул показатели по SKU за период',
        assumptions: [],
        sources,
      };
    }

    const companyRevenue = await this.ozonCompanyRevenue(
      period,
      context,
      analytics.revenue,
    );
    const services = sumOzonServices(totals);
    const ratio = companyRevenue > 0 ? analytics.revenue / companyRevenue : 1;
    const costs = {
      commission: money(services.commission * ratio),
      logistics: money(services.logistics * ratio),
      returns: money(services.returns * ratio),
      storage: money(services.storage * ratio),
      penalties: money(services.penalties * ratio),
      acquiring: money(services.acquiring * ratio),
    };
    const units = analytics.orderedUnits ?? 0;
    const pricePerUnit =
      input.price ?? (price === null ? null : price.price);
    const salePrice =
      pricePerUnit === null
        ? units > 0
          ? money(analytics.revenue / units)
          : null
        : pricePerUnit;
    const costPerUnit = input.cost ?? null;
    const costOfGoods =
      costPerUnit === null ? null : money(costPerUnit * units);
    const totalCosts = money(
      costs.commission +
        costs.logistics +
        costs.returns +
        costs.storage +
        costs.penalties +
        costs.acquiring,
    );
    const margin =
      costOfGoods === null
        ? null
        : money(analytics.revenue - totalCosts - costOfGoods);

    return {
      tool: 'unit-economics',
      marketplace: 'ozon',
      sku: input.sku,
      period,
      dataAvailable: true,
      units,
      revenue: money(analytics.revenue),
      revenueCurrency: CURRENCY,
      costs,
      costOfGoods,
      ...(margin === null ? {} : { margin }),
      ...(margin === null
        ? {}
        : { marginPercent: percent(margin, analytics.revenue) }),
      perUnit: {
        price: salePrice === null ? null : money(salePrice),
        margin:
          margin === null || units === 0 ? null : money(margin / units),
        cost: costPerUnit,
      },
      assumptions: [
        'Комиссия/логистика/хранение Ozon в начислениях не привязаны к SKU: расходы распределены пропорционально выручке SKU в аналитике за период.',
        costOfGoods === null
          ? 'Себестоимость не передана (cost) и не найдена в MCP — маржа без закупочной стоимости не рассчитывается.'
          : 'Себестоимость взята из аргумента cost.',
        'Возвраты Ozon учитываются отдельно от логистики (type_id 32 сервер относит к доставке) и вычитаются из маржи.',
        'Маржа = выручка − распределённые расходы − себестоимость; без cost маржа не рассчитывается.',
      ],
      sources,
    };
  }

  private async wbUnitEconomics(
    input: UnitEconomicsInput,
    period: FinancePeriod,
    context: FinanceQueryContext,
  ): Promise<UnitEconomicsResult> {
    const rows = await this.data.wbFinanceRows(period, context);
    const matched = rows.filter((row) => wbRowMatchesSku(row, input.sku));

    if (matched.length === 0) {
      return {
        tool: 'unit-economics',
        marketplace: 'wb',
        sku: input.sku,
        period,
        dataAvailable: false,
        revenueCurrency: CURRENCY,
        reason:
          'WB finance report не содержит строк по этому SKU за период (проверьте nmId/vendorCode и период)',
        assumptions: [],
        sources: ['wb_finance_report'],
      };
    }

    const totals = sumWbRows(matched);
    const costOfGoods =
      input.cost === undefined
        ? null
        : money(input.cost * totals.quantity);
    const margin = money(totals.payout - (costOfGoods ?? 0));
    const salePrice =
      input.price ??
      (totals.quantity > 0 ? money(totals.revenue / totals.quantity) : null);

    return {
      tool: 'unit-economics',
      marketplace: 'wb',
      sku: input.sku,
      period,
      dataAvailable: true,
      units: totals.quantity,
      revenue: money(totals.revenue),
      revenueCurrency: CURRENCY,
      costs: {
        commission: money(totals.commission),
        logistics: money(totals.logistics),
        returns: money(totals.returns),
        storage: money(totals.storage + totals.acceptance),
        penalties: money(totals.penalty),
        acquiring: money(totals.acquiring),
      },
      costOfGoods,
      margin,
      marginPercent: percent(margin, totals.revenue),
      perUnit: {
        price: salePrice === null ? null : money(salePrice),
        margin:
          totals.quantity === 0 ? null : money(margin / totals.quantity),
        cost: input.cost ?? null,
      },
      assumptions: [
        'Данные — отчёт о реализации WB по строкам SKU (комиссия, логистика, возвраты, штрафы, удержания, хранение, эквайринг).',
        input.cost === undefined
          ? 'Себестоимость не передана (cost), маржа = выплата WB без закупочной стоимости.'
          : 'Маржа = выплата WB − себестоимость × количество.',
        'Удержания (deduction) не вычитаются из margin повторно, если уже входят в ppvzForPay; проверяйте в отчёте WB.',
      ],
      sources: ['wb_finance_report'],
    };
  }

  private async wbProfitLeaks(
    period: FinancePeriod,
    context: FinanceQueryContext,
  ): Promise<Record<string, unknown>> {
    const [rows, deductions, quarantine] = await Promise.all([
      this.data.wbFinanceRows(period, context),
      this.data.wbDeductions(period, context),
      this.data.wbPriceQuarantine(context).catch(() => []),
    ]);
    const totals = sumWbRows(rows);
    const findings: FinanceFinding[] = [];

    for (const row of deductions) {
      if (row.amount > 0) {
        findings.push({
          code: 'deduction',
          severity: 'medium',
          amount: money(row.amount),
          detail: `Удержание WB${row.reason === null ? '' : `: ${row.reason}`}${
            row.nmId === null ? '' : ` (nmId ${row.nmId})`
          }`,
          source: 'wb_deductions',
        });
      }
    }

    if (totals.penalty > 0) {
      findings.push({
        code: 'penalty',
        severity: 'high',
        amount: money(totals.penalty),
        detail: 'Штрафы в отчёте о реализации WB',
        source: 'wb_finance_report',
      });
    }

    if (totals.deduction > 0) {
      findings.push({
        code: 'finance_deduction',
        severity: 'medium',
        amount: money(totals.deduction),
        detail: 'Удержания в отчёте о реализации WB',
        source: 'wb_finance_report',
      });
    }

    if (quarantine.length > 0) {
      findings.push({
        code: 'price_quarantine',
        severity: 'medium',
        detail: `${quarantine.length} товаров WB в ценовом карантине`,
        source: 'wb_prices_quarantine',
      });
    }

    const dataAvailable =
      rows.length > 0 || deductions.length > 0 || quarantine.length > 0;

    return {
      tool: 'profit-leak-detector',
      marketplace: 'wb',
      period,
      dataAvailable,
      ...(dataAvailable
        ? {}
        : { reason: 'WB не вернул ни финансовый отчёт, ни удержания, ни карантин' }),
      totals: {
        penalties: money(totals.penalty),
        deductions: money(totals.deduction),
        returns: money(totals.returns),
        logistics: money(totals.logistics),
        storage: money(totals.storage + totals.acceptance),
      },
      findings,
      sources: ['wb_finance_report', 'wb_deductions', 'wb_prices_quarantine'],
    };
  }

  private async ozonProfitLeaks(
    period: FinancePeriod,
    context: FinanceQueryContext,
  ): Promise<Record<string, unknown>> {
    const [totals, transactions] = await Promise.all([
      this.data.ozonFinanceTotals(period, context),
      this.data.ozonFinanceTransactions(period, context).catch(() => []),
    ]);
    const services = sumOzonServices(totals);
    const findings: FinanceFinding[] = [];

    // Аномалии по реальным транзакциям: отрицательные начисления,
    // сгруппированные по категории (штрафы/удержания/логистика/прочее).
    const byCategory = new Map<string, number>();

    for (const row of transactions) {
      if (row.amount < 0) {
        byCategory.set(
          row.category,
          (byCategory.get(row.category) ?? 0) + Math.abs(row.amount),
        );
      }
    }

    const anomalies = [...byCategory.entries()]
      .sort((left, right) => right[1] - left[1])
      .slice(0, 5);

    for (const [category, amount] of anomalies) {
      findings.push({
        code: 'transaction_anomaly',
        severity: /штраф|penalt|удержан/i.test(category) ? 'high' : 'medium',
        amount: money(amount),
        detail: `Отрицательные начисления Ozon по категории «${category}»`,
        source: 'ozon_finance_transactions',
      });
    }

    for (const line of totals.services) {
      const category =
        line.name.startsWith('32') ? 'returns' : classifyService(line.name);
      const amount = Math.abs(line.amount);

      if (category === 'penalties' && amount > 0) {
        findings.push({
          code: 'penalty',
          severity: 'high',
          amount: money(amount),
          detail: `Штраф/удержание Ozon: ${line.name}`,
          source: 'ozon_finance_totals',
        });
      }

      if (category === 'storage' && amount > 0) {
        findings.push({
          code: 'storage',
          severity: 'low',
          amount: money(amount),
          detail: `Платное хранение Ozon: ${line.name}`,
          source: 'ozon_finance_totals',
        });
      }
    }

    if (Math.abs(totals.returnsAndCancellations) > 0) {
      findings.push({
        code: 'returns',
        severity: 'medium',
        amount: money(Math.abs(totals.returnsAndCancellations)),
        detail: 'Возвраты и отмены Ozon в начислениях',
        source: 'ozon_finance_totals',
      });
    }

    const dataAvailable = totals.accruals > 0;

    return {
      tool: 'profit-leak-detector',
      marketplace: 'ozon',
      period,
      dataAvailable,
      ...(dataAvailable
        ? {}
        : { reason: 'Ozon не вернул начислений за период' }),
      totals: {
        netAccruals: money(totals.total),
        returns: money(services.returns),
        logistics: money(services.logistics),
        commission: money(services.commission),
        storage: money(services.storage),
        penalties: money(services.penalties),
        accruals: totals.accruals,
      },
      findings,
      sources: ['ozon_finance_totals', 'ozon_finance_transactions'],
    };
  }

  private async ozonPriceMonitor(
    input: PriceMonitorInput,
    context: FinanceQueryContext,
  ): Promise<Record<string, unknown>> {
    const own = await this.data.ozonPrice(input.sku, context);

    if (own === null) {
      return {
        tool: 'price-monitor',
        marketplace: 'ozon',
        sku: input.sku,
        dataAvailable: false,
        reason: 'Ozon не вернул цену по этому SKU',
        sources: ['ozon_get_prices'],
      };
    }

    const productId =
      input.productId ??
      (own.productId === null ? null : Number.parseInt(own.productId, 10));
    let competitorPrice: number | null = null;
    let competitorReason: string | undefined;

    if (productId === null || !Number.isInteger(productId)) {
      competitorReason =
        'Ozon API конкурентных цен требует product_id; передайте productId';
    } else {
      try {
        competitorPrice = await this.data.ozonCompetitorPrice(
          productId,
          context,
        );
      } catch (error) {
        this.logger.warn(
          `Ozon: цена конкурента недоступна: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
        competitorReason =
          'Ozon Pricing API не вернул цену конкурента для product_id';
      }
    }

    const difference =
      competitorPrice === null
        ? null
        : money(own.price - competitorPrice);

    return {
      tool: 'price-monitor',
      marketplace: 'ozon',
      sku: input.sku,
      dataAvailable: true,
      ownPrice: money(own.price),
      priceIndex: own.priceIndex,
      competitorPrice,
      ...(competitorReason === undefined
        ? {}
        : { competitorUnavailableReason: competitorReason }),
      difference,
      differencePercent:
        competitorPrice === null
          ? null
          : percent(own.price - competitorPrice, competitorPrice),
      sources: ['ozon_get_prices', 'ozon_pricing_competitor_prices'],
    };
  }

  private async wbPriceMonitor(
    input: PriceMonitorInput,
    context: FinanceQueryContext,
  ): Promise<Record<string, unknown>> {
    const numeric = Number.parseInt(input.sku, 10);
    const nmId =
      input.productId ??
      (Number.isInteger(numeric) && String(numeric) === input.sku
        ? numeric
        : undefined);

    if (nmId === undefined) {
      return {
        tool: 'price-monitor',
        marketplace: 'wb',
        sku: input.sku,
        dataAvailable: false,
        reason:
          'WB prices API фильтрует по nmId: передайте числовой SKU или productId',
        sources: ['wb_prices_list'],
      };
    }

    const rows = await this.data.wbPrices(nmId, context);
    const row = rows.find((item) => item.nmId === String(nmId)) ?? rows[0];

    if (row === undefined || row.price === null) {
      return {
        tool: 'price-monitor',
        marketplace: 'wb',
        sku: input.sku,
        dataAvailable: false,
        reason: 'WB не вернул цену по этому nmId',
        sources: ['wb_prices_list'],
      };
    }

    return {
      tool: 'price-monitor',
      marketplace: 'wb',
      sku: input.sku,
      dataAvailable: true,
      ownPrice: money(row.price),
      discount: row.discount,
      competitorPrice: null,
      competitorUnavailableReason:
        'MCP-сервер WB не отдаёт цены конкурентов (только собственные цены и карантин)',
      sources: ['wb_prices_list'],
    };
  }

  private async ozonFraudAudit(
    input: FraudAuditInput,
    period: FinancePeriod,
    context: FinanceQueryContext,
  ): Promise<Record<string, unknown>> {
    const numericId = Number.parseInt(input.campaignId, 10);
    const campaigns = await this.data.ozonCampaigns(
      Number.isInteger(numericId) ? [numericId] : undefined,
      context,
    );
    const campaign = campaigns.find(
      (item) =>
        readIdentifier(item, ['id', 'campaign_id', 'campaignId']) ===
        input.campaignId,
    );

    if (campaign === undefined) {
      return {
        tool: 'fraud-shield-audit',
        marketplace: 'ozon',
        campaignId: input.campaignId,
        period,
        dataAvailable: false,
        reason: 'Кампания не найдена в Ozon Performance API',
        sources: ['ozon_ad_campaigns'],
      };
    }

    const expenses = await this.data
      .ozonAdExpenses([numericId], period, context)
      .catch(() => null);
    const markers = this.data.campaignMarkers({
      campaign,
      expenses,
    });
    const findings: FinanceFinding[] = [];

    if (!markers.erid) {
      findings.push({
        code: 'missing_erid',
        severity: 'high',
        detail:
          'В данных кампании MCP не найден ERID — проверьте маркировку рекламы вручную',
        source: 'ozon_ad_campaigns',
      });
    }

    if (!markers.utm) {
      findings.push({
        code: 'missing_utm',
        severity: 'medium',
        detail: 'В данных кампании MCP не найден UTM-разметка',
        source: 'ozon_ad_campaigns',
      });
    }

    if (expenses === null) {
      findings.push({
        code: 'spend_unavailable',
        severity: 'medium',
        detail: 'Ozon не вернул расход по кампании за период',
        source: 'ozon_ad_statistics_expenses',
      });
    }

    return {
      tool: 'fraud-shield-audit',
      marketplace: 'ozon',
      campaignId: input.campaignId,
      period,
      dataAvailable: true,
      eridPresent: markers.erid,
      utmPresent: markers.utm,
      spend: expenses === null ? null : money(expenses),
      findings,
      checks: [
        { id: 'campaign_found', passed: true },
        { id: 'erid_present', passed: markers.erid },
        { id: 'utm_present', passed: markers.utm },
        { id: 'spend_available', passed: expenses !== null },
      ],
      sources: ['ozon_ad_campaigns', 'ozon_ad_statistics_expenses'],
    };
  }

  private async wbFraudAudit(
    input: FraudAuditInput,
    period: FinancePeriod,
    context: FinanceQueryContext,
  ): Promise<Record<string, unknown>> {
    const numericId = Number.parseInt(input.campaignId, 10);
    const campaigns = await this.data.wbAdvertCampaigns(
      Number.isInteger(numericId) ? [numericId] : undefined,
      context,
    );
    const campaign = campaigns.find(
      (item) =>
        readIdentifier(item, ['id', 'advert_id', 'advertId']) ===
        input.campaignId,
    );

    if (campaign === undefined) {
      return {
        tool: 'fraud-shield-audit',
        marketplace: 'wb',
        campaignId: input.campaignId,
        period,
        dataAvailable: false,
        reason: 'Кампания не найдена в WB Advert API',
        sources: ['wb_advert_list'],
      };
    }

    const [costs, deductions, antifraud] = await Promise.all([
      this.data.wbAdvertCosts(period, context).catch(() => null),
      this.data.wbDeductions(period, context).catch(() => []),
      this.data.wbAntifraud(period.to, context).catch(() => []),
    ]);
    const markers = this.data.campaignMarkers({ campaign, costs });
    const findings: FinanceFinding[] = [];

    if (!markers.erid) {
      findings.push({
        code: 'missing_erid',
        severity: 'high',
        detail:
          'В данных кампании MCP не найден ERID — проверьте маркировку рекламы вручную',
        source: 'wb_advert_list',
      });
    }

    if (!markers.utm) {
      findings.push({
        code: 'missing_utm',
        severity: 'medium',
        detail: 'В данных кампании MCP не найден UTM-разметка',
        source: 'wb_advert_list',
      });
    }

    const deductionTotal = deductions.reduce(
      (sum, row) => sum + row.amount,
      0,
    );

    if (deductionTotal > 0) {
      findings.push({
        code: 'deductions',
        severity: 'medium',
        amount: money(deductionTotal),
        detail: `Удержания WB за период: ${deductions.length} записей`,
        source: 'wb_deductions',
      });
    }

    if (antifraud.length > 0) {
      findings.push({
        code: 'antifraud',
        severity: 'high',
        detail: `WB antifraud: ${antifraud.length} подозрительных начислений (самовыкупы)`,
        source: 'wb_analytics_antifraud',
      });
    }

    return {
      tool: 'fraud-shield-audit',
      marketplace: 'wb',
      campaignId: input.campaignId,
      period,
      dataAvailable: true,
      eridPresent: markers.erid,
      utmPresent: markers.utm,
      adSpend: costs === null ? null : money(costs),
      deductions: money(deductionTotal),
      antifraudRecords: antifraud.length,
      findings,
      checks: [
        { id: 'campaign_found', passed: true },
        { id: 'erid_present', passed: markers.erid },
        { id: 'utm_present', passed: markers.utm },
        { id: 'spend_available', passed: costs !== null },
        { id: 'no_antifraud', passed: antifraud.length === 0 },
      ],
      sources: [
        'wb_advert_list',
        'wb_advert_costs',
        'wb_deductions',
        'wb_analytics_antifraud',
      ],
    };
  }

  /** Выручка всех SKU за период — база для распределения расходов Ozon. */
  private async ozonCompanyRevenue(
    period: FinancePeriod,
    context: FinanceQueryContext,
    fallback: number,
  ): Promise<number> {
    try {
      const text = await this.data.ozonRevenueRows(period, context);
      const total = text.reduce((sum, value) => sum + value, 0);

      return total > 0 ? total : fallback;
    } catch (error) {
      this.logger.warn(
        `Ozon: не удалось получить выручку всех SKU: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );

      return fallback;
    }
  }

  private context(
    sellerId?: string,
    skills?: readonly MarketplaceSkillSnapshot[],
  ): FinanceQueryContext {
    const shopId = sellerId?.trim() ?? '';

    return {
      ...(shopId === '' ? {} : { shopId }),
      ...(skills === undefined ? {} : { skills }),
    };
  }
}

/** Идентификатор из сырой записи MCP (число или строка). */
function readIdentifier(
  record: Record<string, unknown>,
  keys: readonly string[],
): string | null {
  for (const key of keys) {
    const value = record[key];

    if (typeof value === 'string' && value !== '') {
      return value;
    }

    if (typeof value === 'number' && Number.isFinite(value)) {
      return String(value);
    }
  }

  return null;
}

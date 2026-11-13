import { describe, expect, it, vi } from 'vitest';
import { ApiException } from '../../common/api-error.js';
import { ERROR_KEYS } from '../../i18n/error-keys.js';
import type { MarketplaceMcpService } from '../tools/marketplace-mcp.service.js';
import { FinanceDataService } from './finance-data.service.js';
import { FinanceToolsService } from './finance-tools.service.js';

type MockFn = ReturnType<typeof vi.fn>;

const PERIOD = { dateFrom: '2026-11-01', dateTo: '2026-11-13' };

const OZON_TOTALS = {
  accruals: 120,
  total: -95_345.67,
  by_category: { ITEM: 120_000, POSTING: -200_000 },
  by_service: {
    '32 — Логистика возврата': -12_000,
    'Комиссия за продажу': -45_000,
    'Логистика': -30_000,
    'Штраф за габариты': -5_000,
    'Платное хранение': -3_000,
  },
  returns_and_cancellations: -12_000,
};

const OZON_ANALYTICS = {
  result: {
    data: [
      { dimensions: ['SKU-1'], metrics: [100_000, 50, 3] },
      { dimensions: ['SKU-2'], metrics: [50_000, 25, 1] },
    ],
  },
};

const OZON_PRICES = {
  items: [
    {
      product_id: 123,
      offer_id: 'SKU-1',
      price: { price: '2000', old_price: '2500' },
    },
  ],
};

const WB_REPORT = {
  report: [
    {
      nmId: 111,
      vendorCode: 'SKU-1',
      retailAmount: 10_000,
      ppvzSalesCommission: 1_500,
      deliveryRub: 500,
      returnAmount: 200,
      penalty: 0,
      deduction: 100,
      paidStorage: 50,
      paidAcceptance: 20,
      acquiringFee: 30,
      ppvzForPay: 7_600,
      quantity: 10,
    },
  ],
};

interface Harness {
  tools: FinanceToolsService;
  call: MockFn;
}

function createHarness(): Harness {
  const call = vi.fn(async (provider: string, action: string) => {
    const fixtures: Record<string, unknown> = {
      ozon_finance_totals: OZON_TOTALS,
      ozon_finance_transactions: {
        accruals: [
          {
            accrued_category: 'Штраф за габариты',
            total_amount: { amount: '-5000', currency: 'RUB' },
            date: '2026-11-05',
          },
          {
            accrued_category: 'Комиссия',
            total_amount: { amount: '-45000', currency: 'RUB' },
            date: '2026-11-06',
          },
        ],
      },
      ozon_analytics: OZON_ANALYTICS,
      ozon_get_prices: OZON_PRICES,
      ozon_pricing_competitor_prices: { result: { competitor_price: '1800' } },
      ozon_ad_campaigns: {
        list: [{ id: 555, name: 'Ozon campaign', state: 'RUNNING' }],
      },
      ozon_ad_statistics_expenses: {
        expenses: [{ campaign_id: 555, money: { amount: '3000.50' } }],
      },
      wb_finance_report: WB_REPORT,
      wb_deductions: {
        data: [{ nm_id: 111, sum: 300, reason: 'подмена' }],
      },
      wb_prices_list: { data: { list: [{ nmID: 111, price: 2000, discount: 10 }] } },
      wb_prices_quarantine: { data: [] },
      wb_advert_list: {
        adverts: [{ id: 777, status: 9, settings: { utm: 'utm_source=wb' } }],
      },
      wb_advert_costs: { data: [{ advert_id: 777, amount: 500 }] },
      wb_analytics_antifraud: { data: [{ nm_id: 111, sum: 1000 }] },
    };

    if (!(action in fixtures)) {
      throw new Error(`unexpected MCP action ${provider}.${action}`);
    }

    return JSON.stringify(fixtures[action]);
  });
  const data = new FinanceDataService({
    call,
  } as unknown as MarketplaceMcpService);

  return { tools: new FinanceToolsService(data), call };
}

describe('FinanceToolsService: unit-economics на реальных MCP-данных', () => {
  it('Ozon: распределяет комиссию/логистику/возвраты и считает маржу', async () => {
    const { tools } = createHarness();

    const result = await tools.unitEconomics(
      {
        sku: 'SKU-1',
        marketplace: 'ozon',
        cost: 500,
        ...PERIOD,
      },
      {},
      new Date('2026-11-13T00:00:00Z'),
    );

    expect(result.dataAvailable).toBe(true);
    expect(result.revenue).toBe(100_000);
    expect(result.units).toBe(50);
    expect(result.costOfGoods).toBe(25_000);
    expect(result.costs).toEqual({
      commission: 30_000,
      logistics: 20_000,
      returns: 8_000,
      storage: 2_000,
      penalties: 3_333.33,
      acquiring: 0,
    });
    // 100000 − (30000+20000+8000+2000+3333.33) − 25000
    expect(result.margin).toBe(11_666.67);
    expect(result.marginPercent).toBe(11.67);
    expect(result.sources).toContain('ozon_finance_totals');
  });

  it('Ozon: нет SKU в аналитике — dataAvailable=false, без фейковой маржи', async () => {
    const { tools } = createHarness();

    const result = await tools.unitEconomics(
      { sku: 'SKU-404', marketplace: 'ozon', ...PERIOD },
      {},
      new Date('2026-11-13T00:00:00Z'),
    );

    expect(result.dataAvailable).toBe(false);
    expect(result.margin).toBeUndefined();
    expect(result.reason).toContain('SKU');
  });

  it('WB: считает маржу по строкам отчёта о реализации', async () => {
    const { tools } = createHarness();

    const result = await tools.unitEconomics(
      { sku: 'SKU-1', marketplace: 'wb', cost: 500, ...PERIOD },
      {},
      new Date('2026-11-13T00:00:00Z'),
    );

    expect(result.dataAvailable).toBe(true);
    expect(result.revenue).toBe(10_000);
    expect(result.costOfGoods).toBe(5_000);
    expect(result.costs).toEqual({
      commission: 1_500,
      logistics: 500,
      returns: 200,
      storage: 70,
      penalties: 0,
      acquiring: 30,
    });
    expect(result.margin).toBe(2_600);
  });

  it('WB: нет строк по SKU — dataAvailable=false', async () => {
    const { tools } = createHarness();

    const result = await tools.unitEconomics(
      { sku: 'SKU-404', marketplace: 'wb', ...PERIOD },
      {},
      new Date('2026-11-13T00:00:00Z'),
    );

    expect(result.dataAvailable).toBe(false);
    expect(result.reason).toContain('WB finance report');
  });

  it('ошибка провайдера MCP пробрасывается, а не заменяется цифрами', async () => {
    const { tools, call } = createHarness();

    call.mockRejectedValueOnce(
      new ApiException({
        statusCode: 502,
        error: 'Bad Gateway',
        code: ERROR_KEYS.mcpProvider,
        message: 'MCP down',
      }),
    );

    await expect(
      tools.unitEconomics(
        { sku: 'SKU-1', marketplace: 'ozon', ...PERIOD },
        {},
        new Date('2026-11-13T00:00:00Z'),
      ),
    ).rejects.toMatchObject({ status: 502 });
  });
});

describe('FinanceToolsService: profit-leak-detector', () => {
  it('WB: находит удержания и штрафы из реальных отчётов', async () => {
    const { tools } = createHarness();

    const result = (await tools.profitLeaks(
      { sellerId: 'shop-1', marketplace: 'wb', ...PERIOD },
      {},
      new Date('2026-11-13T00:00:00Z'),
    )) as {
      dataAvailable: boolean;
      findings: Array<{ code: string; amount?: number }>;
      totals: { deductions: number };
    };

    expect(result.dataAvailable).toBe(true);
    expect(result.findings.map((item) => item.code)).toEqual(
      expect.arrayContaining(['deduction', 'finance_deduction']),
    );
    expect(result.findings.find((item) => item.code === 'deduction')?.amount).toBe(
      300,
    );
    expect(result.totals.deductions).toBe(100);
  });

  it('Ozon: возвраты и штрафы из начислений', async () => {
    const { tools } = createHarness();

    const result = (await tools.profitLeaks(
      { sellerId: 'shop-1', marketplace: 'ozon', ...PERIOD },
      {},
      new Date('2026-11-13T00:00:00Z'),
    )) as {
      dataAvailable: boolean;
      findings: Array<{ code: string }>;
      totals: { returns: number; penalties: number };
    };

    expect(result.dataAvailable).toBe(true);
    expect(result.findings.map((item) => item.code)).toEqual(
      expect.arrayContaining(['returns', 'penalty', 'transaction_anomaly']),
    );
    expect(result.totals.returns).toBe(12_000);
    expect(result.totals.penalties).toBe(5_000);
  });
});

describe('FinanceToolsService: price-monitor', () => {
  it('Ozon: своя цена и цена конкурента по product_id', async () => {
    const { tools } = createHarness();

    await expect(
      tools.priceMonitor({
        sku: 'SKU-1',
        marketplace: 'ozon',
        productId: 123,
      }),
    ).resolves.toMatchObject({
      dataAvailable: true,
      ownPrice: 2000,
      competitorPrice: 1800,
      difference: 200,
    });
  });

  it('WB: конкурентные цены MCP не поддерживает — честно сообщает', async () => {
    const { tools } = createHarness();

    const result = (await tools.priceMonitor({
      sku: '111',
      marketplace: 'wb',
    })) as {
      dataAvailable: boolean;
      ownPrice: number;
      competitorPrice: null;
      competitorUnavailableReason: string;
    };

    expect(result.dataAvailable).toBe(true);
    expect(result.ownPrice).toBe(2000);
    expect(result.competitorPrice).toBeNull();
    expect(result.competitorUnavailableReason).toContain('не отдаёт');
  });
});

describe('FinanceToolsService: fraud-shield-audit', () => {
  it('Ozon: кампания без ERID/UTM помечается рисками', async () => {
    const { tools } = createHarness();

    const result = (await tools.fraudAudit(
      { campaignId: '555', marketplace: 'ozon', ...PERIOD },
      {},
      new Date('2026-11-13T00:00:00Z'),
    )) as {
      dataAvailable: boolean;
      eridPresent: boolean;
      utmPresent: boolean;
      spend: number;
      findings: Array<{ code: string }>;
    };

    expect(result.dataAvailable).toBe(true);
    expect(result.eridPresent).toBe(false);
    expect(result.utmPresent).toBe(false);
    expect(result.spend).toBe(3000.5);
    expect(result.findings.map((item) => item.code)).toEqual(
      expect.arrayContaining(['missing_erid', 'missing_utm']),
    );
  });

  it('Ozon: неизвестная кампания — dataAvailable=false', async () => {
    const { tools } = createHarness();

    const result = (await tools.fraudAudit(
      { campaignId: '999', marketplace: 'ozon', ...PERIOD },
      {},
      new Date('2026-11-13T00:00:00Z'),
    )) as { dataAvailable: boolean; reason: string };

    expect(result.dataAvailable).toBe(false);
    expect(result.reason).toContain('не найдена');
  });

  it('WB: антифрод и удержания попадают в findings', async () => {
    const { tools } = createHarness();

    const result = (await tools.fraudAudit(
      { campaignId: '777', marketplace: 'wb', ...PERIOD },
      {},
      new Date('2026-11-13T00:00:00Z'),
    )) as {
      dataAvailable: boolean;
      eridPresent: boolean;
      utmPresent: boolean;
      findings: Array<{ code: string }>;
    };

    expect(result.dataAvailable).toBe(true);
    expect(result.utmPresent).toBe(true);
    expect(result.eridPresent).toBe(false);
    expect(result.findings.map((item) => item.code)).toEqual(
      expect.arrayContaining(['missing_erid', 'deductions', 'antifraud']),
    );
  });
});

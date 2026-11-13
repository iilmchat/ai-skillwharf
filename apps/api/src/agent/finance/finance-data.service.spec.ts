import { describe, expect, it, vi } from 'vitest';
import { ApiException } from '../../common/api-error.js';
import { ERROR_KEYS } from '../../i18n/error-keys.js';
import type { MarketplaceMcpService } from '../tools/marketplace-mcp.service.js';
import { FinanceDataService } from './finance-data.service.js';

type MockFn = ReturnType<typeof vi.fn>;

interface Harness {
  service: FinanceDataService;
  call: MockFn;
}

const PERIOD = { from: '2026-11-01', to: '2026-11-13' };

function createHarness(): Harness {
  const call = vi.fn(async () => '{}');
  const service = new FinanceDataService({
    call,
  } as unknown as MarketplaceMcpService);

  return { service, call };
}

const OZON_TOTALS = {
  source: '/v1/finance/accrual/by-day',
  period: { from: '2026-11-01', to: '2026-11-13' },
  accruals: 120,
  total: -95_345.67,
  by_category: { ITEM: 120_000, POSTING: -200_000, NON_ITEM: -15_345.67 },
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
    totals: [150_000, 75, 4],
  },
};

describe('FinanceDataService (MCP → Zod/нормализация)', () => {
  it('запрашивает финансы Ozon за период и разбирает услуги', async () => {
    const { service, call } = createHarness();

    call.mockResolvedValueOnce(JSON.stringify(OZON_TOTALS));

    const totals = await service.ozonFinanceTotals(PERIOD);

    expect(call).toHaveBeenCalledWith(
      'ozon',
      'ozon_finance_totals',
      expect.objectContaining({
        date_from: '2026-11-01T00:00:00Z',
        date_to: '2026-11-13T23:59:59Z',
      }),
      expect.objectContaining({}),
    );
    expect(totals.total).toBe(-95_345.67);
    expect(totals.returnsAndCancellations).toBe(-12_000);
    expect(totals.services).toContainEqual({
      name: 'Комиссия за продажу',
      amount: -45_000,
    });
    expect(totals.accruals).toBe(120);
  });

  it('находит SKU в аналитике Ozon и возвращает метрики', async () => {
    const { service, call } = createHarness();

    call.mockResolvedValueOnce(JSON.stringify(OZON_ANALYTICS));

    await expect(
      service.ozonSkuAnalytics(PERIOD, 'SKU-2'),
    ).resolves.toEqual({
      sku: 'SKU-2',
      found: true,
      revenue: 50_000,
      orderedUnits: 25,
      returns: 1,
    });
  });

  it('нет SKU в аналитике — found=false, без фейковых чисел', async () => {
    const { service, call } = createHarness();

    call.mockResolvedValueOnce(JSON.stringify(OZON_ANALYTICS));

    await expect(
      service.ozonSkuAnalytics(PERIOD, 'SKU-404'),
    ).resolves.toEqual({
      sku: 'SKU-404',
      found: false,
      revenue: null,
      orderedUnits: null,
      returns: null,
    });
  });

  it('не-JSON от MCP — ошибка провайдера mcp_provider', async () => {
    const { service, call } = createHarness();

    call.mockResolvedValueOnce('<html>gateway error</html>');

    const error: unknown = await service
      .ozonFinanceTotals(PERIOD)
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ApiException);
    expect((error as ApiException).getResponse()).toMatchObject({
      statusCode: 502,
      code: ERROR_KEYS.mcpProvider,
    });
  });

  it('период Ozon длиннее 31 дня отклоняется до вызова', async () => {
    const { service, call } = createHarness();

    const error: unknown = await service
      .ozonFinanceTotals({ from: '2026-10-01', to: '2026-12-01' })
      .catch((caught: unknown) => caught);

    expect((error as ApiException).getResponse()).toMatchObject({
      statusCode: 400,
      code: ERROR_KEYS.invalidRequest,
    });
    expect(call).not.toHaveBeenCalled();
  });

  it('разбирает отчёт WB за разными обёртками и snake_case', async () => {
    const { service, call } = createHarness();

    call.mockResolvedValueOnce(
      JSON.stringify({
        report: [
          {
            nm_id: 111,
            vendor_code: 'SKU-1',
            retail_amount: 10_000,
            ppvz_sales_commission: 1_500,
            delivery_rub: 500,
            return_amount: 200,
            penalty: 0,
            deduction: 100,
            paid_storage: 50,
            paid_acceptance: 20,
            acquiring_fee: 30,
            ppvz_for_pay: 7_600,
            quantity: 10,
          },
        ],
      }),
    );

    const rows = await service.wbFinanceRows(PERIOD);

    expect(call).toHaveBeenCalledWith(
      'wb',
      'wb_finance_report',
      { date_from: PERIOD.from, date_to: PERIOD.to, limit: 500 },
      expect.objectContaining({}),
    );
    expect(rows).toEqual([
      {
        nmId: '111',
        vendorCode: 'SKU-1',
        retailAmount: 10_000,
        commission: 1_500,
        logistics: 500,
        returns: 200,
        penalty: 0,
        deduction: 100,
        storage: 50,
        acceptance: 20,
        acquiring: 30,
        payout: 7_600,
        quantity: 10,
      },
    ]);
  });

  it('разбирает финансовые транзакции Ozon (accruals)', async () => {
    const { service, call } = createHarness();

    call.mockResolvedValueOnce(
      JSON.stringify({
        accruals: [
          {
            accrued_category: 'Штраф за габариты',
            total_amount: { amount: '-5000', currency: 'RUB' },
            date: '2026-11-05',
          },
        ],
      }),
    );

    const rows = await service.ozonFinanceTransactions(PERIOD);

    expect(call).toHaveBeenCalledWith(
      'ozon',
      'ozon_finance_transactions',
      expect.objectContaining({
        page: 1,
        page_size: 1000,
        view: 'full',
      }),
      expect.objectContaining({}),
    );
    expect(rows).toEqual([
      { category: 'Штраф за габариты', amount: -5000, date: '2026-11-05' },
    ]);
  });

  it('находит ERID/UTM в сырых данных кампании', () => {
    const { service } = createHarness();

    expect(
      service.campaignMarkers({
        campaign: { settings: { utm: 'utm_source=ozon', erid: 'ERID-1' } },
      }),
    ).toEqual({ erid: true, utm: true });

    expect(
      service.campaignMarkers({ campaign: { id: 1, title: 'Без разметки' } }),
    ).toEqual({ erid: false, utm: false });
  });

  it('складывает расход рекламы Ozon из вложенных сумм', async () => {
    const { service, call } = createHarness();

    call.mockResolvedValueOnce(
      JSON.stringify({
        expenses: [
          { campaign_id: 1, money: { amount: '1000.50' } },
          { campaign_id: 2, money: { amount: '2000.25' } },
        ],
      }),
    );

    await expect(
      service.ozonAdExpenses([1, 2], PERIOD),
    ).resolves.toBe(3000.75);
  });
});

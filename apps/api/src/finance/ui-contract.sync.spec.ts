import { describe, expect, it } from 'vitest';
// Реальная Zod-схема UI: импорт из `apps/web` возможен только в тесте
// (production-сборка API не тянет код web). Если UI-контракт изменится,
// этот тест упадёт первым — без дублирования схемы.
import { financeOverviewSchema } from '../../../web/src/lib/finance.js';
import { FinanceSnapshotStore } from '../agent/finance/finance-snapshot.store.js';
import { FinanceController } from './finance.controller.js';
import { FinanceService } from './finance.service.js';

type Request = Parameters<FinanceController['overview']>[0];

function request(userId: string): Request {
  return {
    user: { userId, email: 'user@example.com', role: 'user' },
  } as unknown as Request;
}

const UNIT_ECONOMICS = {
  tool: 'unit-economics',
  marketplace: 'ozon',
  sku: 'SKU-1',
  period: { from: '2026-11-01', to: '2026-11-13' },
  dataAvailable: true,
  units: 50,
  revenue: 100_000,
  revenueCurrency: 'RUB',
  costs: {
    commission: 30_000,
    logistics: 20_000,
    returns: 8_000,
    storage: 2_000,
    penalties: 3_333.33,
    acquiring: 0,
  },
  costOfGoods: 25_000,
  margin: 11_666.67,
  marginPercent: 11.67,
  perUnit: { price: 2_000, margin: 233.33, cost: 500 },
  assumptions: ['Расходы Ozon распределены пропорционально выручке SKU'],
  sources: ['ozon_finance_totals', 'ozon_analytics'],
};

const PROFIT_LEAKS = {
  tool: 'profit-leak-detector',
  marketplace: 'wb',
  period: { from: '2026-11-01', to: '2026-11-13' },
  dataAvailable: true,
  totals: { penalties: 0, deductions: 100, returns: 200 },
  findings: [
    {
      code: 'deduction',
      severity: 'medium',
      amount: 100,
      detail: 'Удержание WB за подмену',
      source: 'wb_finance_report',
    },
  ],
  sources: ['wb_finance_report', 'wb_deductions'],
};

const FRAUD_AUDIT = {
  tool: 'fraud-shield-audit',
  marketplace: 'ozon',
  campaignId: '555',
  period: { from: '2026-11-01', to: '2026-11-13' },
  dataAvailable: true,
  eridPresent: false,
  utmPresent: false,
  spend: 3_000.5,
  findings: [
    {
      code: 'missing_erid',
      severity: 'high',
      detail: 'ERID не найден в данных кампании',
      source: 'ozon_ad_campaigns',
    },
  ],
  checks: [
    { id: 'campaign_found', passed: true },
    { id: 'erid_present', passed: false },
    { id: 'utm_present', passed: false },
    { id: 'spend_available', passed: true },
  ],
  sources: ['ozon_ad_campaigns', 'ozon_ad_statistics_expenses'],
};

describe('Совместимость с Zod-схемой UI (apps/web/src/lib/finance.ts)', () => {
  it('пустой дашборд парсится UI-схемой', async () => {
    const controller = new FinanceController(
      new FinanceService(new FinanceSnapshotStore('')),
    );

    const response = await controller.overview(request('user-1'));

    expect(financeOverviewSchema.parse(response)).toEqual({
      currency: 'RUB',
      unitEconomics: [],
      profitLeaks: [],
      fraudShield: null,
    });
    expect(response.dataAvailable).toBe(false);
  });

  it('агрегат с реальными результатами инструментов парсится UI-схемой', async () => {
    const store = new FinanceSnapshotStore('');
    const controller = new FinanceController(new FinanceService(store));

    await store.record('user-1', 'unitEconomics', UNIT_ECONOMICS, 'ozon|SKU-1');
    await store.record('user-1', 'profitLeaks', PROFIT_LEAKS);
    await store.record('user-1', 'fraudShield', FRAUD_AUDIT);

    const response = await controller.overview(request('user-1'));
    const parsed = financeOverviewSchema.parse(response);

    expect(parsed.unitEconomics).toHaveLength(1);
    expect(parsed.unitEconomics[0]).toMatchObject({
      sku: 'SKU-1',
      margin: 11_666.67,
      marginPercent: 11.67,
    });
    expect(parsed.profitLeaks[0]?.findings[0]?.code).toBe('deduction');
    expect(parsed.fraudShield?.campaignId).toBe('555');
  });

  it('fallback-ответы (`{ items }`) парсятся UI-схемой', async () => {
    const store = new FinanceSnapshotStore('');
    const controller = new FinanceController(new FinanceService(store));

    await store.record('user-1', 'unitEconomics', UNIT_ECONOMICS, 'ozon|SKU-1');
    await store.record('user-1', 'profitLeaks', PROFIT_LEAKS);

    const unit = await controller.unitEconomics(request('user-1'), {});
    const leaks = await controller.profitLeaks(request('user-1'), {});
    const empty = await controller.unitEconomics(request('user-1'), {
      sku: 'SKU-404',
    });

    expect(
      financeOverviewSchema.parse({
        unitEconomics: unit,
        profitLeaks: leaks,
      }).unitEconomics,
    ).toHaveLength(1);
    expect(
      financeOverviewSchema.parse({
        unitEconomics: empty,
        profitLeaks: leaks,
      }).unitEconomics,
    ).toEqual([]);
  });

  it('ответ fraud-shield парсится UI-схемой аудита', async () => {
    const store = new FinanceSnapshotStore('');
    const controller = new FinanceController(new FinanceService(store));

    await store.record('user-1', 'fraudShield', FRAUD_AUDIT);

    const found = await controller.fraudShield(request('user-1'), {});
    const empty = await controller.fraudShield(request('user-1'), {
      campaignId: '999',
    });

    expect(
      financeOverviewSchema.parse({ fraudShield: found }).fraudShield,
    ).toMatchObject({ campaignId: '555', dataAvailable: true });
    expect(
      financeOverviewSchema.parse({ fraudShield: empty }).fraudShield,
    ).toMatchObject({ dataAvailable: false });
  });
});

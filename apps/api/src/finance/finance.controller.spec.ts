import { UnauthorizedException } from '@nestjs/common';
import { describe, expect, it } from 'vitest';
import { FinanceSnapshotStore } from '../agent/finance/finance-snapshot.store.js';
import { ApiException } from '../common/api-error.js';
import { ERROR_KEYS } from '../i18n/error-keys.js';
import { FinanceController } from './finance.controller.js';
import { FinanceService } from './finance.service.js';

/**
 * Поведение `/finance/*`: авторизация, валидация query, фильтры и честное
 * «нет данных». Совместимость ответа с Zod-схемой UI проверяет
 * `ui-contract.sync.spec.ts` (импортирует настоящую схему из `apps/web`).
 */
type Request = Parameters<FinanceController['overview']>[0];

function request(userId?: string): Request {
  return {
    user:
      userId === undefined
        ? undefined
        : { userId, email: 'user@example.com', role: 'user' },
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
  ],
  sources: ['ozon_ad_campaigns', 'ozon_ad_statistics_expenses'],
};

function createController(): {
  controller: FinanceController;
  store: FinanceSnapshotStore;
} {
  const store = new FinanceSnapshotStore('');

  return { controller: new FinanceController(new FinanceService(store)), store };
}

describe('FinanceController: GET /finance/overview', () => {
  it('без аутентификации — 401', async () => {
    const { controller } = createController();

    const error: unknown = await controller
      .overview(request())
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(UnauthorizedException);
  });

  it('нет расчётов — dataAvailable:false с причиной, а не вымышленные суммы', async () => {
    const { controller } = createController();

    const response = await controller.overview(request('user-1'));

    expect(response).toMatchObject({
      currency: 'RUB',
      dataAvailable: false,
      unitEconomics: [],
      profitLeaks: [],
      fraudShield: null,
    });
    expect(response.reason).toContain('запустите');
  });

  it('агрегирует все три вида результатов', async () => {
    const { controller, store } = createController();

    await store.record('user-1', 'unitEconomics', UNIT_ECONOMICS, 'ozon|SKU-1');
    await store.record('user-1', 'profitLeaks', PROFIT_LEAKS);
    await store.record('user-1', 'fraudShield', FRAUD_AUDIT);

    const response = await controller.overview(request('user-1'));

    expect(response.currency).toBe('RUB');
    expect(response.dataAvailable).toBe(true);
    expect(response.unitEconomics).toHaveLength(1);
    expect(response.unitEconomics[0]).toMatchObject({
      sku: 'SKU-1',
      margin: 11_666.67,
      revenueCurrency: 'RUB',
    });
    expect(response.profitLeaks).toHaveLength(1);
    expect(response.fraudShield).toMatchObject({ campaignId: '555' });
    expect(response.period).toEqual({ from: '2026-11-01', to: '2026-11-13' });
    expect(response.updatedAt).toBeDefined();
  });

  it('данные одного пользователя не попадают в дашборд другого', async () => {
    const { controller, store } = createController();

    await store.record('user-1', 'unitEconomics', UNIT_ECONOMICS, 'ozon|SKU-1');

    await expect(controller.overview(request('user-2'))).resolves.toMatchObject({
      dataAvailable: false,
      unitEconomics: [],
    });
  });

  it('записи, не проходящие схему, отбрасываются (а не ломают ответ)', async () => {
    const { controller, store } = createController();

    await store.record('user-1', 'unitEconomics', { sku: 'broken' }, 'ozon|X');

    const response = await controller.overview(request('user-1'));

    expect(response.dataAvailable).toBe(false);
    expect(response.unitEconomics).toEqual([]);
  });
});

describe('FinanceController: fallback-маршруты', () => {
  it('unit-economics отдаёт items и фильтрует по sku/marketplace', async () => {
    const { controller, store } = createController();

    await store.record('user-1', 'unitEconomics', UNIT_ECONOMICS, 'ozon|SKU-1');
    await store.record(
      'user-1',
      'unitEconomics',
      { ...UNIT_ECONOMICS, sku: 'SKU-2', marketplace: 'wb' },
      'wb|SKU-2',
    );

    const all = await controller.unitEconomics(request('user-1'), {});
    const filtered = await controller.unitEconomics(request('user-1'), {
      sku: 'SKU-2',
      marketplace: 'wb',
    });
    const empty = await controller.unitEconomics(request('user-1'), {
      sku: 'SKU-404',
    });

    expect(all.dataAvailable).toBe(true);
    expect(all.items).toHaveLength(2);
    expect(filtered.items).toHaveLength(1);
    expect(empty).toMatchObject({ dataAvailable: false, items: [] });
    expect(empty.reason).toBeDefined();
  });

  it('profit-leaks фильтрует по marketplace и честно сообщает об отсутствии данных', async () => {
    const { controller, store } = createController();

    await store.record('user-1', 'profitLeaks', PROFIT_LEAKS);

    await expect(
      controller.profitLeaks(request('user-1'), { marketplace: 'wb' }),
    ).resolves.toMatchObject({ dataAvailable: true, items: [PROFIT_LEAKS] });
    await expect(
      controller.profitLeaks(request('user-1'), { marketplace: 'ozon' }),
    ).resolves.toMatchObject({ dataAvailable: false, items: [] });
  });

  it('fraud-shield отдаёт последний аудит и фильтрует по campaignId', async () => {
    const { controller, store } = createController();

    await store.record('user-1', 'fraudShield', FRAUD_AUDIT);

    const found = await controller.fraudShield(request('user-1'), {
      campaignId: '555',
    });
    const missing = await controller.fraudShield(request('user-1'), {
      campaignId: '999',
    });

    expect(found).toMatchObject({ campaignId: '555', dataAvailable: true });
    expect(missing).toMatchObject({
      dataAvailable: false,
      findings: [],
      checks: [],
    });
    expect(missing.reason).toContain('999');
  });

  it('некорректные query-параметры — 400 invalid_request', async () => {
    const { controller } = createController();

    const cases: ReadonlyArray<readonly [string, unknown]> = [
      ['unitEconomics', { marketplace: 'avito' }],
      ['profitLeaks', { dateFrom: '13.11.2026' }],
      ['fraudShield', { sellerId: 'x'.repeat(65) }],
    ];

    for (const [method, query] of cases) {
      const invoke = controller[method] as (
        req: Request,
        input: unknown,
      ) => Promise<unknown>;
      const error: unknown = await invoke(request('user-1'), query).catch(
        (caught: unknown) => caught,
      );

      expect(error).toBeInstanceOf(ApiException);
      expect((error as ApiException).getResponse()).toMatchObject({
        statusCode: 400,
        code: ERROR_KEYS.invalidRequest,
      });
    }
  });

  it('лишние query-параметры отклоняются (strict-схема)', async () => {
    const { controller } = createController();
    const error: unknown = await controller
      .unitEconomics(request('user-1'), { sku: 'SKU-1', unknown: '1' })
      .catch((caught: unknown) => caught);

    expect((error as ApiException).getResponse()).toMatchObject({
      statusCode: 400,
      code: ERROR_KEYS.invalidRequest,
    });
  });
});

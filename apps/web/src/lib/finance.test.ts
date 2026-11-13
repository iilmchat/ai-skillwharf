import { AxiosError, type AxiosResponse } from 'axios';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ZodError } from 'zod';
import {
  fetchFinanceOverview,
  financeOverviewSchema,
  getFinanceErrorDetails,
  getFraudShieldRisks,
  getFraudShieldStatus,
  getProfitLeakFindings,
  getTotalMarginPercent,
  sumUnitEconomicsMargin,
  sumUnitEconomicsRevenue,
  type FraudAuditResult,
  type ProfitLeakResult,
  type UnitEconomicsResult,
} from './finance';

const { getMock } = vi.hoisted(() => ({ getMock: vi.fn() }));

vi.mock('./api', () => ({
  api: { get: getMock },
}));

function axiosErrorWith(data: unknown, status: number): AxiosError {
  const response = {
    data,
    status,
    statusText: 'Error',
    headers: {},
    config: {},
  } as unknown as AxiosResponse;

  return new AxiosError(
    'Request failed',
    undefined,
    undefined,
    undefined,
    response,
  );
}

const PERIOD = { from: '2026-11-01', to: '2026-11-30' };

const UNIT_ECONOMICS: UnitEconomicsResult = {
  tool: 'unit-economics',
  marketplace: 'ozon',
  sku: 'SKU-1',
  period: PERIOD,
  dataAvailable: true,
  revenue: 120000,
  margin: 30000,
  marginPercent: 25,
};

const PROFIT_LEAKS: ProfitLeakResult = {
  tool: 'profit-leak-detector',
  marketplace: 'ozon',
  period: PERIOD,
  dataAvailable: true,
  totals: { penalties: 100 },
  findings: [
    {
      code: 'penalty',
      severity: 'high',
      amount: 100,
      detail: 'Штраф Ozon',
      source: 'ozon_finance_totals',
    },
  ],
};

const FRAUD_AUDIT: FraudAuditResult = {
  tool: 'fraud-shield-audit',
  marketplace: 'ozon',
  campaignId: 'campaign-1',
  period: PERIOD,
  dataAvailable: true,
  findings: [],
  checks: [{ id: 'erid_present', passed: true }],
};

const OVERVIEW = {
  currency: 'RUB',
  period: PERIOD,
  unitEconomics: [UNIT_ECONOMICS],
  profitLeaks: [PROFIT_LEAKS],
  fraudShield: FRAUD_AUDIT,
};

describe('financeOverviewSchema', () => {
  it('принимает реальные поля unit-economics, profit-leak и fraud-audit', () => {
    expect(financeOverviewSchema.parse(OVERVIEW)).toEqual(OVERVIEW);
  });

  it('заполняет пустые коллекции и не требует fraudShield', () => {
    expect(financeOverviewSchema.parse({})).toEqual({
      currency: 'RUB',
      unitEconomics: [],
      profitLeaks: [],
    });
  });

  it('отклоняет битые данные инструментов', () => {
    expect(
      financeOverviewSchema.safeParse({
        unitEconomics: [{ sku: 'SKU-1' }],
      }).success,
    ).toBe(false);
    expect(
      financeOverviewSchema.safeParse({
        fraudShield: { findings: [] },
      }).success,
    ).toBe(false);
  });

  it('принимает расширенный ответ backend (`dataAvailable`, `reason`, лишние поля)', () => {
    const parsed = financeOverviewSchema.parse({
      ...OVERVIEW,
      dataAvailable: false,
      reason: 'Ozon не вернул начислений за период',
      updatedAt: '2026-11-14T00:00:00.000Z',
      unitEconomics: [
        {
          ...UNIT_ECONOMICS,
          // API не отбрасывает служебные поля инструментов (passthrough).
          marketplace: 'wb',
          spend: 1000,
          adSpend: 500,
        },
      ],
      profitLeaks: [
        {
          ...PROFIT_LEAKS,
          findings: [
            {
              ...PROFIT_LEAKS.findings[0],
              antifraudRecords: 3,
            },
          ],
        },
      ],
    });

    expect(parsed.unitEconomics[0]?.marketplace).toBe('wb');
    expect(parsed.profitLeaks[0]?.findings[0]?.code).toBe('penalty');
  });
});

describe('суммы unit-economics', () => {
  it('складывает выручку и абсолютную прибыль (margin)', () => {
    expect(sumUnitEconomicsRevenue([UNIT_ECONOMICS])).toBe(120000);
    expect(sumUnitEconomicsMargin([UNIT_ECONOMICS])).toBe(30000);
    expect(getTotalMarginPercent([UNIT_ECONOMICS])).toBe(25);
  });

  it('не учитывает SKU без данных и не делит на нулевую выручку', () => {
    const unavailable = {
      ...UNIT_ECONOMICS,
      sku: 'SKU-404',
      dataAvailable: false,
      revenue: 5000,
      margin: 1000,
    };

    expect(sumUnitEconomicsRevenue([UNIT_ECONOMICS, unavailable])).toBe(
      120000,
    );
    expect(sumUnitEconomicsMargin([UNIT_ECONOMICS, unavailable])).toBe(30000);
    expect(
      getTotalMarginPercent([{ ...UNIT_ECONOMICS, revenue: 0, margin: 0 }]),
    ).toBeNull();
  });
});

describe('profit-leak и fraud-shield', () => {
  it('собирает findings только из доступных отчётов', () => {
    expect(getProfitLeakFindings([PROFIT_LEAKS])).toEqual(
      PROFIT_LEAKS.findings,
    );
    expect(
      getProfitLeakFindings([{ ...PROFIT_LEAKS, dataAvailable: false }]),
    ).toEqual([]);
  });

  it('выводит статус fraud-shield из findings и checks', () => {
    expect(getFraudShieldStatus(FRAUD_AUDIT)).toBe('complete');
    expect(
      getFraudShieldStatus({
        ...FRAUD_AUDIT,
        findings: PROFIT_LEAKS.findings,
      }),
    ).toBe('risks');
    expect(
      getFraudShieldStatus({
        ...FRAUD_AUDIT,
        checks: [{ id: 'erid_present', passed: false }],
      }),
    ).toBe('risks');
    expect(getFraudShieldStatus({ ...FRAUD_AUDIT, dataAvailable: false })).toBe(
      'unknown',
    );
    expect(getFraudShieldStatus(null)).toBe('unknown');
  });

  it('возвращает тексты рисков из findings', () => {
    expect(
      getFraudShieldRisks({
        ...FRAUD_AUDIT,
        findings: PROFIT_LEAKS.findings,
      }),
    ).toEqual(['Штраф Ozon']);
  });
});

describe('fetchFinanceOverview', () => {
  beforeEach(() => {
    getMock.mockReset();
  });

  it('читает агрегированный overview', async () => {
    getMock.mockResolvedValueOnce({ data: OVERVIEW });

    await expect(fetchFinanceOverview()).resolves.toEqual(OVERVIEW);
    expect(getMock).toHaveBeenCalledWith('/finance/overview');
  });

  it('делает fallback на отдельные endpoints при 404', async () => {
    getMock
      .mockRejectedValueOnce(axiosErrorWith({ message: 'Not found' }, 404))
      .mockResolvedValueOnce({ data: [UNIT_ECONOMICS] })
      .mockResolvedValueOnce({ data: [PROFIT_LEAKS] })
      .mockResolvedValueOnce({ data: FRAUD_AUDIT });

    await expect(fetchFinanceOverview()).resolves.toEqual(OVERVIEW);
    expect(getMock).toHaveBeenNthCalledWith(2, '/finance/unit-economics');
    expect(getMock).toHaveBeenNthCalledWith(3, '/finance/profit-leaks');
    expect(getMock).toHaveBeenNthCalledWith(4, '/finance/fraud-shield');
  });
});

describe('getFinanceErrorDetails', () => {
  it('маппит сеть, 401, 403, 404 и 5xx', () => {
    expect(getFinanceErrorDetails(new AxiosError('Network')).kind).toBe(
      'network',
    );
    expect(getFinanceErrorDetails(axiosErrorWith({}, 401)).kind).toBe(
      'sessionExpired',
    );
    expect(getFinanceErrorDetails(axiosErrorWith({}, 403)).kind).toBe(
      'forbidden',
    );
    expect(getFinanceErrorDetails(axiosErrorWith({}, 404)).kind).toBe(
      'notFound',
    );
    expect(
      getFinanceErrorDetails(
        axiosErrorWith({ code: 'errors.provider_unavailable' }, 502),
      ),
    ).toEqual({
      kind: 'unavailable',
      serverMessage: 'errors.provider_unavailable',
    });
  });

  it('распознаёт ZodError и неизвестную ошибку', () => {
    expect(getFinanceErrorDetails(new ZodError([]))).toEqual({
      kind: 'invalidResponse',
      serverMessage: null,
    });
    expect(getFinanceErrorDetails(new Error('boom'))).toEqual({
      kind: 'unknown',
      serverMessage: null,
    });
  });
});

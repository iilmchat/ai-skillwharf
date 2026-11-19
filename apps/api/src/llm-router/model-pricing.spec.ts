import { describe, expect, it } from 'vitest';
import { calculateLlmCost } from '../agent/llm-budget.service.js';
import {
  calculateModelCost,
  parseModelPricingJson,
  resolveModelPricing,
} from './model-pricing.js';

describe('Per-model тарифы LLM (API-28.2 / KI-040)', () => {
  it('считает input и output раздельно', () => {
    const pricing = { inputCostPer1k: 0.1, outputCostPer1k: 0.5 };

    // 1000 input * 0.1 / 1000 = 0.1; 100 output * 0.5 / 1000 = 0.05.
    expect(calculateModelCost(1_000, 100, pricing)).toBe(0.15);
    expect(calculateModelCost(0, 100, pricing)).toBe(0.05);
    expect(calculateModelCost(100, 0, pricing)).toBe(0.01);
    expect(calculateModelCost(0, 0, pricing)).toBe(0);
  });

  it('округляет вверх до копеек и применяет минимальный порог', () => {
    const pricing = { inputCostPer1k: 0.001, outputCostPer1k: 0.001 };

    expect(calculateModelCost(1, 1, pricing)).toBe(0.01);
    expect(calculateModelCost(999, 1, pricing, 0)).toBe(0.01);
  });

  it('читает JSON-карту моделей и валидирует её через Zod', () => {
    const map = parseModelPricingJson(
      JSON.stringify({
        'gpt-4o': { inputCostPer1k: 0.5, outputCostPer1k: 1.5 },
      }),
    );

    expect(map['gpt-4o']).toEqual({
      inputCostPer1k: 0.5,
      outputCostPer1k: 1.5,
    });
    expect(() =>
      parseModelPricingJson('{"m":{"inputCostPer1k":-1}}'),
    ).toThrow();
    expect(parseModelPricingJson(undefined)).toEqual({});
  });

  it('переопределение из маршрута имеет приоритет над JSON', () => {
    const map = { 'gpt-4o': { inputCostPer1k: 0.5, outputCostPer1k: 1.5 } };

    expect(resolveModelPricing('gpt-4o', {}, map)).toEqual(map['gpt-4o']);
    expect(
      resolveModelPricing('gpt-4o', { outputCostPer1k: 0.01 }, map),
    ).toEqual({ inputCostPer1k: 0.5, outputCostPer1k: 0.01 });
    expect(resolveModelPricing('unknown', {}, map)).toEqual({
      inputCostPer1k: 0.01,
      outputCostPer1k: 0.01,
    });
  });

  it('calculateLlmCost совместим со старым вызовом и использует модель', () => {
    expect(calculateLlmCost(1_000, 0)).toBe(0.01);

    const priced = calculateLlmCost(1_000, 0, 'gpt-4o', {
      id: 'r1',
      name: 'route',
      modelName: 'gpt-4o',
      providerType: 'OpenAI',
      baseUrl: 'http://localhost',
      apiKeyEnvVar: null,
      taskType: 'chat',
      dailyCostLimit: null,
      inputCostPer1k: 0.25,
      outputCostPer1k: 0.75,
    });

    expect(priced).toBe(0.25);
  });
});

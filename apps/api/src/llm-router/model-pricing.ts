import { z } from 'zod';

/** Legacy-тариф: ₽ за 1000 любых токенов, когда per-model тариф не задан. */
export const LLM_COST_PER_1K_TOKENS = 0.01;

/**
 * Динамические per-model тарифы LLM (API-28.2 / KI-040).
 *
 * Источники в порядке приоритета: поля LlmRoute → `LLM_MODEL_PRICING_JSON`
 * → `LLM_COST_PER_1K_TOKENS` (единый fallback для input и output).
 * Стоимость считается раздельно: `(prompt * inputRate + completion *
 * outputRate) / 1000`.
 */

export const modelPricingSchema = z.object({
  inputCostPer1k: z.number().nonnegative().finite(),
  outputCostPer1k: z.number().nonnegative().finite(),
});

export type ModelPricing = z.infer<typeof modelPricingSchema>;

const pricingMapSchema = z.record(
  z.string().min(1),
  modelPricingSchema,
);

/** Парсит `LLM_MODEL_PRICING_JSON`: невалидная конфигурация — ошибка. */
export function parseModelPricingJson(
  raw: string | undefined,
): Readonly<Record<string, ModelPricing>> {
  const source = (raw ?? '').trim();

  if (source === '') {
    return {};
  }

  let parsed: unknown;

  try {
    parsed = JSON.parse(source) as unknown;
  } catch {
    throw new Error('LLM_MODEL_PRICING_JSON: некорректный JSON');
  }

  const result = pricingMapSchema.safeParse(parsed);

  if (!result.success) {
    throw new Error(
      `LLM_MODEL_PRICING_JSON: ${result.error.issues.map((issue) => issue.message).join('; ')}`,
    );
  }

  return result.data;
}

/** Тариф по умолчанию из legacy-переменной. */
export function fallbackPricing(): ModelPricing {
  const rate = z
    .number()
    .nonnegative()
    .finite()
    .parse(LLM_COST_PER_1K_TOKENS);

  return { inputCostPer1k: rate, outputCostPer1k: rate };
}

/**
 * Разрешает тариф для модели: переопределение из маршрута имеет приоритет
 * над JSON-картой, затем идёт legacy-fallback.
 */
export function resolveModelPricing(
  model: string,
  overrides: Partial<ModelPricing> = {},
  map: Readonly<Record<string, ModelPricing>> = parseModelPricingJson(
    process.env.LLM_MODEL_PRICING_JSON,
  ),
): ModelPricing {
  const fallback = fallbackPricing();
  const configured = map[model] ?? fallback;
  const result = modelPricingSchema.safeParse({
    inputCostPer1k: overrides.inputCostPer1k ?? configured.inputCostPer1k,
    outputCostPer1k: overrides.outputCostPer1k ?? configured.outputCostPer1k,
  });

  return result.success ? result.data : fallback;
}

/** Стоимость вызова с раздельными тарифами input/output (₽, 2 знака). */
export function calculateModelCost(
  promptTokens: number,
  completionTokens: number,
  pricing: ModelPricing,
  minimum = 0,
): number {
  const prompt = Math.max(0, Math.trunc(promptTokens || 0));
  const completion = Math.max(0, Math.trunc(completionTokens || 0));

  if (prompt === 0 && completion === 0) {
    return 0;
  }

  const parsed = modelPricingSchema.parse(pricing);
  const raw =
    (prompt * parsed.inputCostPer1k + completion * parsed.outputCostPer1k) /
    1000;

  return Math.max(minimum, Math.ceil(raw * 100) / 100);
}

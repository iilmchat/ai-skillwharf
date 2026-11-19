import { z } from 'zod';

export const experimentStatusSchema = z.enum(['running', 'stopped', 'completed']);
export type ExperimentStatus = z.infer<typeof experimentStatusSchema>;

export const experimentVariantSchema = z.enum(['A', 'B']);
export type ExperimentVariant = z.infer<typeof experimentVariantSchema>;

/** POST /prompts/:id/experiments — запуск A/B-эксперимента. */
export const createExperimentSchema = z
  .object({
    name: z.string().trim().min(1).max(128),
    variantAVersionId: z.string().min(1),
    variantBVersionId: z.string().min(1),
    trafficSplitB: z.number().int().min(0).max(100).default(50),
  })
  .refine(
    (value) => value.variantAVersionId !== value.variantBVersionId,
    { message: 'варианты A и B должны быть разными версиями' },
  );

export type CreateExperimentInput = z.infer<typeof createExperimentSchema>;

/** POST /prompts/experiments/:expId/stop — остановка с опциональным промоушеном. */
export const stopExperimentSchema = z.object({
  promoteVersionId: z.string().min(1).optional(),
  /** Явное требование зелёного Evals-прогона для этого промоушена. */
  requirePassingEval: z.boolean().optional(),
});

export type StopExperimentInput = z.infer<typeof stopExperimentSchema>;

/** Агрегаты по одному варианту (внутреннее представление в metricsJson). */
export const variantMetricsSchema = z.object({
  requests: z.number().int().nonnegative().default(0),
  totalLatencyMs: z.number().nonnegative().default(0),
  totalCost: z.number().nonnegative().default(0),
});

export type VariantMetrics = z.infer<typeof variantMetricsSchema>;

export const experimentMetricsSchema = z.object({
  A: variantMetricsSchema,
  B: variantMetricsSchema,
});

export type ExperimentMetrics = z.infer<typeof experimentMetricsSchema>;

export function emptyExperimentMetrics(): ExperimentMetrics {
  return {
    A: { requests: 0, totalLatencyMs: 0, totalCost: 0 },
    B: { requests: 0, totalLatencyMs: 0, totalCost: 0 },
  };
}

/** Метрика варианта со средними значениями для Control Plane UI. */
export const experimentVariantMetricsViewSchema = z.object({
  requests: z.number().int().nonnegative(),
  avgLatencyMs: z.number().nonnegative(),
  avgCost: z.number().nonnegative(),
});

/** Элемент списка экспериментов в ответе API. */
export const experimentViewSchema = z.object({
  id: z.string(),
  promptId: z.string(),
  name: z.string(),
  variantAVersionId: z.string(),
  variantBVersionId: z.string(),
  trafficSplitB: z.number().int().min(0).max(100),
  status: experimentStatusSchema,
  winnerVersionId: z.string().nullable(),
  metrics: z.object({
    A: experimentVariantMetricsViewSchema,
    B: experimentVariantMetricsViewSchema,
  }),
  createdAt: z.string(),
  stoppedAt: z.string().nullable(),
});

export type ExperimentView = z.infer<typeof experimentViewSchema>;

/** Внутренний результат выбора варианта при генерации промпта. */
export interface ResolvedPromptVariant {
  readonly content: string;
  readonly experimentId: string | null;
  readonly variant: ExperimentVariant | null;
  readonly versionId: string | null;
}

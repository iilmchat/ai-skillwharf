import { z } from 'zod';

/**
 * Схемы автоматической оценки промптов (Sprint 29 / EVAL-29.1, EVAL-29.2).
 * Все внешние данные — датасеты и ответ LLM-судьи — валидируются Zod.
 */

/** Трек A..L из матрицы монетизации (тот же набор, что и в каталоге). */
export const EVAL_TRACKS = [
  'A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'J', 'K', 'L',
] as const;

export const evalTrackSchema = z.enum(EVAL_TRACKS);

/** Эталонный кейс из датасета `evals/datasets/track-*.json`. */
export const evalCaseSchema = z.object({
  id: z.string().min(1),
  trackId: evalTrackSchema,
  title: z.string().min(1).max(256),
  input: z.string().min(1).max(20_000),
  expectedTools: z.array(z.string().min(1)).max(50),
  requiresHitl: z.boolean(),
  rubric: z.array(z.string().min(1)).min(1).max(50),
});

export type EvalCase = z.infer<typeof evalCaseSchema>;

/**
 * Формат рубрики в самих датасетах: либо массив строк, либо объект с
 * `required`/`forbidden`. Приводится к плоскому массиву для `evalCaseSchema`.
 */
const datasetRubricSchema = z.union([
  z.array(z.string().min(1)).min(1),
  z
    .object({
      required: z.array(z.string().min(1)).min(1),
      forbidden: z.array(z.string().min(1)).optional(),
    })
    .transform((rubric) => [
      ...rubric.required,
      ...(rubric.forbidden ?? []).map((item) => `НЕ: ${item}`),
    ]),
]);

const datasetCaseSchema = z.object({
  id: z.string().min(1),
  trackId: evalTrackSchema,
  title: z.string().min(1).max(256),
  input: z.string().min(1).max(20_000),
  expectedTools: z.array(z.string().min(1)).max(50),
  requiresHitl: z.boolean(),
  rubric: datasetRubricSchema,
});

const datasetFileSchema = z.object({
  trackId: evalTrackSchema,
  title: z.string().optional(),
  source: z.string().optional(),
  cases: z.array(datasetCaseSchema).min(1),
});

/** Читает один `track-*.json`, отклоняя невалидные поля. */
export function parseEvalDataset(raw: unknown): EvalCase[] {
  const parsed = datasetFileSchema.safeParse(raw);

  if (!parsed.success) {
    throw new Error(
      `некорректный eval-датасет: ${parsed.error.issues
        .map((issue) => `${issue.path.join('.') || 'dataset'}: ${issue.message}`)
        .join('; ')}`,
    );
  }

  // datasetRubricSchema уже привёл рубрику к плоскому массиву строк.
  return parsed.data.cases.map((item) => evalCaseSchema.parse(item));
}

/** Вердикт LLM-судьи: строгий JSON, без произвольных полей. */
export const judgeVerdictSchema = z
  .object({
    score: z.number().min(0).max(100),
    passed: z.boolean(),
    reasoning: z.string().min(1).max(4_000),
  })
  .strict();

export type JudgeVerdict = z.infer<typeof judgeVerdictSchema>;

/** POST /prompts/:id/evals/run. */
export const runEvalSchema = z.object({
  versionId: z.string().min(1),
  trackId: evalTrackSchema.optional(),
  cases: z.array(evalCaseSchema).min(1).max(100).optional(),
});

export type RunEvalInput = z.infer<typeof runEvalSchema>;

/** Детальный результат по одному кейсу (в `resultsJson`). */
export const evalCaseResultSchema = z.object({
  caseId: z.string(),
  trackId: evalTrackSchema,
  deterministicPassed: z.boolean(),
  toolCallsMatch: z.boolean(),
  hitlMatch: z.boolean(),
  verdict: judgeVerdictSchema,
});

export type EvalCaseResult = z.infer<typeof evalCaseResultSchema>;

export const evalResultsSchema = z.array(evalCaseResultSchema);

/** Элемент истории прогонов в ответе API. */
export const evalRunViewSchema = z.object({
  id: z.string(),
  promptId: z.string(),
  versionId: z.string(),
  trackFilter: evalTrackSchema.nullable(),
  totalCases: z.number().int().nonnegative(),
  passedCases: z.number().int().nonnegative(),
  passRate: z.number().min(0).max(1),
  avgScore: z.number().min(0).max(100),
  status: z.enum(['running', 'passed', 'failed']),
  results: z.array(evalCaseResultSchema),
  createdAt: z.string(),
  completedAt: z.string().nullable(),
});

export type EvalRunView = z.infer<typeof evalRunViewSchema>;

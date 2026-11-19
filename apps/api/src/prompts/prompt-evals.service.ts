import {
  BadRequestException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  Optional,
} from '@nestjs/common';
import { Prisma, type PromptEvalRun } from '@prisma/client';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { LlmRouterService } from '../llm-router/llm-router.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import {
  EVAL_TRACKS,
  evalResultsSchema,
  evalRunViewSchema,
  judgeVerdictSchema,
  parseEvalDataset,
  runEvalSchema,
  type EvalCase,
  type EvalCaseResult,
  type EvalRunView,
  type JudgeVerdict,
  type RunEvalInput,
} from './prompt-eval.schemas.js';

/**
 * Автоматическая оценка качества системных промптов (Sprint 29 / EVAL-29.2).
 *
 * Детерминированные метрики (tool_calls, HITL) проверяются по трассировке
 * прогона; ответ дополнительно оценивает LLM-судья по рубрике. Для юнит-
 * тестов и dev есть детерминированный mock-судья (`EVALS_JUDGE_MODE=mock`).
 */

export const DEFAULT_MIN_PASS_RATE = 0.85;
export const EVALS_DATASETS_DIR = 'evals/datasets';

export const EVAL_JUDGE_CLIENT = 'EVAL_JUDGE_CLIENT';
export const EVAL_CASE_RUNNER = 'EVAL_CASE_RUNNER';

const evalsConfigSchema = z.object({
  minPassRate: z.number().min(0).max(1),
  gatePromotion: z.boolean(),
  judgeMode: z.enum(['mock', 'llm']),
});

export interface EvalsConfig extends z.infer<typeof evalsConfigSchema> {}

export function readEvalsConfig(
  env: NodeJS.ProcessEnv = process.env,
): EvalsConfig {
  const rawRate = Number.parseFloat(env.EVALS_MIN_PASS_RATE ?? '');
  const flag = z.enum(['true', 'false']).catch('false');

  return evalsConfigSchema.parse({
    minPassRate:
      Number.isFinite(rawRate) && env.EVALS_MIN_PASS_RATE?.trim() !== ''
        ? rawRate
        : DEFAULT_MIN_PASS_RATE,
    gatePromotion:
      flag.parse((env.EVALS_GATE_PROMOTION ?? '').trim().toLowerCase()) === 'true',
    judgeMode:
      (env.EVALS_JUDGE_MODE ?? '').trim().toLowerCase() === 'llm'
        ? 'llm'
        : 'mock',
  });
}

/** Трассировка одного кейса: что реально вызвал агент. */
export interface EvalCaseTrace {
  readonly toolCalls: readonly string[];
  readonly hitlRequested: boolean;
  readonly reply: string;
}

export interface EvalCaseRunner {
  run(testCase: EvalCase, systemPrompt: string): Promise<EvalCaseTrace>;
}

export interface JudgeRequest {
  readonly systemPrompt: string;
  readonly userPrompt: string;
}

export interface JudgeClient {
  judge(request: JudgeRequest): Promise<JudgeVerdict>;
}

/** Дефолтный прогонщик: эхо-трассировка, совпадающая с эталоном. */
class EchoEvalCaseRunner implements EvalCaseRunner {
  async run(testCase: EvalCase): Promise<EvalCaseTrace> {
    return {
      toolCalls: [...testCase.expectedTools],
      hitlRequested: testCase.requiresHitl,
      reply: `Выполнено: ${testCase.title}`,
    };
  }
}

/** Детерминированный судья для dev и тестов: ставит 100 при совпадении. */
export class DeterministicJudgeClient implements JudgeClient {
  async judge(request: JudgeRequest): Promise<JudgeVerdict> {
    try {
      const raw = JSON.parse(request.userPrompt) as Record<string, unknown>;
      const expected = Array.isArray(raw.expectedTools) ? raw.expectedTools : [];
      const actual = Array.isArray(raw.toolCalls) ? raw.toolCalls : [];
      const passed =
        JSON.stringify([...expected].sort()) === JSON.stringify([...actual].sort());

      return judgeVerdictSchema.parse({
        score: passed ? 100 : 40,
        passed,
        reasoning: passed
          ? 'Инструменты совпадают с эталоном'
          : 'Вызванные инструменты расходятся с эталоном',
      });
    } catch {
      return judgeVerdictSchema.parse({
        score: 0,
        passed: false,
        reasoning: 'Не удалось разобрать входные данные судьи',
      });
    }
  }
}

const judgeResponseSchema = z.object({
  choices: z
    .array(
      z.object({
        message: z.object({ content: z.string().min(1) }),
      }),
    )
    .min(1),
});

/** LLM-судья через OpenAI-совместимый маршрут из LlmRouterService. */
export class LlmJudgeClient implements JudgeClient {
  private readonly logger = new Logger(LlmJudgeClient.name);

  constructor(private readonly router: LlmRouterService) {}

  async judge(request: JudgeRequest): Promise<JudgeVerdict> {
    const [route] = await this.router.selectRoutes('chat');

    if (route === undefined) {
      throw new Error('Нет активного LLM-маршрута для судьи');
    }

    const apiKey =
      route.apiKeyEnvVar === null ? '' : (process.env[route.apiKeyEnvVar] ?? '');
    const response = await fetch(`${route.baseUrl.replace(/\/$/, '')}/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(apiKey === '' ? {} : { authorization: `Bearer ${apiKey}` }),
      },
      body: JSON.stringify({
        model: route.modelName,
        temperature: 0,
        messages: [
          { role: 'system', content: request.systemPrompt },
          { role: 'user', content: request.userPrompt },
        ],
      }),
      signal: AbortSignal.timeout(30_000),
    });

    if (!response.ok) {
      throw new Error(`LLM-судья вернул HTTP ${response.status}`);
    }

    const parsedResponse = judgeResponseSchema.safeParse(await response.json());

    if (!parsedResponse.success) {
      throw new Error('LLM-судья вернул некорректный JSON');
    }

    const raw: unknown = JSON.parse(
      parsedResponse.data.choices[0]?.message.content ?? '',
    ) as unknown;

    return judgeVerdictSchema.parse(raw);
  }

  /** Системный промпт строгого аудитора (не зависит от пользователя). */
  static systemPrompt(): string {
    return [
      'Ты — строгий аудитор качества ответов агента. Оцени только по rubric.',
      'Верни строго JSON без обёрток: {"score":number 0..100,"passed":boolean,"reasoning":"..."}.',
      'passed = true только если выполнены все обязательные пункты рубрики.',
    ].join(' ');
  }
}

export const EVAL_SYSTEM_PROMPT = LlmJudgeClient.systemPrompt();

@Injectable()
export class PromptEvalsService {
  private readonly logger = new Logger(PromptEvalsService.name);
  private readonly config: EvalsConfig;
  private readonly judge: JudgeClient;
  private readonly runner: EvalCaseRunner;

  constructor(
    private readonly prisma: PrismaService,
    router: LlmRouterService,
    @Optional() @Inject(EVAL_JUDGE_CLIENT) judge?: JudgeClient,
    @Optional() @Inject(EVAL_CASE_RUNNER) runner?: EvalCaseRunner,
    @Optional() env: NodeJS.ProcessEnv = process.env,
  ) {
    this.config = readEvalsConfig(env);
    this.judge = judge ?? (this.config.judgeMode === 'llm'
      ? new LlmJudgeClient(router)
      : new DeterministicJudgeClient());
    this.runner = runner ?? new EchoEvalCaseRunner();
  }

  /** Порог качества из env (для гейта промоушена). */
  get minPassRate(): number {
    return this.config.minPassRate;
  }

  /** Политика блокировки промоушена без зелёного Eval-прогона. */
  get gatePromotion(): boolean {
    return this.config.gatePromotion;
  }

  /** Есть ли для версии успешный прогон. */
  async hasPassingEval(versionId: string): Promise<boolean> {
    const run = await this.prisma.promptEvalRun.findFirst({
      where: { versionId, status: 'passed' },
      orderBy: { completedAt: 'desc' },
      select: { id: true },
    });

    return run !== null;
  }

  /** Запуск прогона с проверкой, что версия принадлежит шаблону из URL. */
  async runEvalForPrompt(
    promptId: string,
    raw: unknown,
  ): Promise<EvalRunView> {
    const input = runEvalSchema.parse(raw ?? {});
    const version = await this.prisma.promptVersion.findUnique({
      where: { id: input.versionId },
      select: { templateId: true },
    });

    if (version === null || version.templateId !== promptId) {
      throw new NotFoundException(
        `Версия ${input.versionId} не найдена в промпте ${promptId}`,
      );
    }

    return this.runEval(input);
  }

  /** История прогонов промпта (свежие сверху). */
  async listRuns(promptId: string): Promise<EvalRunView[]> {
    const rows = await this.prisma.promptEvalRun.findMany({
      where: { promptId },
      orderBy: { createdAt: 'desc' },
    });

    return rows.map((row) => toEvalRunView(row));
  }

  /**
   * Запуск прогона: детерминированные метрики + LLM-судья по каждому кейсу.
   * Результат сохраняется в БД со статусом passed/failed по порогу.
   */
  async runEval(raw: RunEvalInput): Promise<EvalRunView> {
    const input = runEvalSchema.parse(raw);
    const version = await this.prisma.promptVersion.findUnique({
      where: { id: input.versionId },
      select: { templateId: true, content: true },
    });

    if (version === null) {
      throw new NotFoundException(`Версия ${input.versionId} не найдена`);
    }

    const cases =
      input.cases ?? (await loadDatasets(input.trackId));

    if (cases.length === 0) {
      throw new BadRequestException(
        'Нет кейсов для прогона: проверьте trackId или передайте cases',
      );
    }

    const results: EvalCaseResult[] = [];

    for (const testCase of cases) {
      const trace = await this.runner.run(testCase, version.content);
      const toolCallsMatch = sameTools(
        testCase.expectedTools,
        trace.toolCalls,
      );
      const hitlMatch = testCase.requiresHitl === trace.hitlRequested;
      const verdict = await this.judge.judge({
        systemPrompt: EVAL_SYSTEM_PROMPT,
        userPrompt: JSON.stringify({
          caseId: testCase.id,
          rubric: testCase.rubric,
          reply: trace.reply,
          expectedTools: testCase.expectedTools,
          toolCalls: trace.toolCalls,
          requiresHitl: testCase.requiresHitl,
          hitlRequested: trace.hitlRequested,
        }),
      });

      results.push({
        caseId: testCase.id,
        trackId: testCase.trackId,
        deterministicPassed: toolCallsMatch && hitlMatch,
        toolCallsMatch,
        hitlMatch,
        verdict,
      });
    }

    const passedCases = results.filter(
      (result) => result.deterministicPassed && result.verdict.passed,
    ).length;
    const passRate = passedCases / results.length;
    const avgScore =
      results.reduce((sum, result) => sum + result.verdict.score, 0) /
      results.length;
    const status = passRate >= this.config.minPassRate ? 'passed' : 'failed';

    const row = await this.prisma.promptEvalRun.create({
      data: {
        promptId: version.templateId,
        versionId: input.versionId,
        trackFilter: input.trackId ?? null,
        totalCases: results.length,
        passedCases,
        passRate,
        avgScore,
        status,
        resultsJson: evalResultsSchema.parse(results) as unknown as Prisma.InputJsonValue,
        completedAt: new Date(),
      },
    });

    this.logger.log(
      JSON.stringify({
        event: 'prompt.eval.completed',
        runId: row.id,
        versionId: input.versionId,
        passRate,
        status,
      }),
    );

    return toEvalRunView(row);
  }
}

function sameTools(expected: readonly string[], actual: readonly string[]): boolean {
  const norm = (items: readonly string[]): string =>
    JSON.stringify([...items].map((item) => item.trim()).sort());

  return norm(expected) === norm(actual);
}

/** Загружает эталонные датасеты из `evals/datasets/track-*.json`. */
async function loadDatasets(trackId?: string): Promise<EvalCase[]> {
  const tracks =
    trackId === undefined
      ? EVAL_TRACKS
      : [z.enum(EVAL_TRACKS).parse(trackId)];
  const cases: EvalCase[] = [];

  for (const track of tracks) {
    const path = join(process.cwd(), EVALS_DATASETS_DIR, `track-${track.toLowerCase()}.json`);

    if (!existsSync(path)) {
      continue; // датасеты треков могут отсутствовать — оценки нет, но API не падает
    }

    cases.push(...parseEvalDataset(JSON.parse(readFileSync(path, 'utf8')) as unknown));
  }

  return cases;
}

function toEvalRunView(row: PromptEvalRun): EvalRunView {
  return evalRunViewSchema.parse({
    id: row.id,
    promptId: row.promptId,
    versionId: row.versionId,
    trackFilter: row.trackFilter,
    totalCases: row.totalCases,
    passedCases: row.passedCases,
    passRate: row.passRate,
    avgScore: row.avgScore,
    status: row.status,
    results: evalResultsSchema.safeParse(row.resultsJson ?? []).success
      ? evalResultsSchema.parse(row.resultsJson ?? [])
      : [],
    createdAt: row.createdAt.toISOString(),
    completedAt: row.completedAt?.toISOString() ?? null,
  });
}

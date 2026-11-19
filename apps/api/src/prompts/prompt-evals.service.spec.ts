import { describe, expect, it, vi } from 'vitest';
import type { LlmRouterService } from '../llm-router/llm-router.service.js';
import type { PrismaService } from '../prisma/prisma.service.js';
import type {
  EvalCaseTrace,
  JudgeClient,
  JudgeVerdict,
} from './prompt-evals.service.js';
import {
  DeterministicJudgeClient,
  PromptEvalsService,
  readEvalsConfig,
} from './prompt-evals.service.js';

const VERSION_ID = 'version-2';
const PROMPT_ID = 'prompt-1';

const cases = [
  {
    id: 'A-01',
    trackId: 'A' as const,
    title: 'Кейс 1',
    input: 'Вопрос 1',
    expectedTools: ['tool_a'],
    requiresHitl: false,
    rubric: ['Правильный инструмент'],
  },
  {
    id: 'A-02',
    trackId: 'A' as const,
    title: 'Кейс 2',
    input: 'Вопрос 2',
    expectedTools: ['tool_b'],
    requiresHitl: true,
    rubric: ['Запрошено подтверждение'],
  },
];

function harness(options: {
  judge?: JudgeClient;
  runner?: { run: (testCase: (typeof cases)[number]) => Promise<EvalCaseTrace> };
  env?: NodeJS.ProcessEnv;
} = {}) {
  const rows: Array<Record<string, unknown>> = [];
  const prisma = {
    promptVersion: {
      findUnique: vi.fn(async ({ where }: { where: { id: string } }) =>
        where.id === VERSION_ID
          ? { templateId: PROMPT_ID, content: 'system prompt' }
          : null,
      ),
    },
    promptEvalRun: {
      create: vi.fn(async (args: { data: Record<string, unknown> }) => {
        const row = {
          id: `run-${rows.length + 1}`,
          ...args.data,
          createdAt: new Date('2026-11-19T10:00:00Z'),
          completedAt: new Date('2026-11-19T10:00:01Z'),
        };

        rows.push(row);

        return row;
      }),
      findMany: vi.fn(async () => rows),
      findFirst: vi.fn(async () => rows[0] ?? null),
    },
  };
  const router = {} as LlmRouterService;
  const service = new PromptEvalsService(
    prisma as unknown as PrismaService,
    router,
    options.judge ?? new DeterministicJudgeClient(),
    options.runner,
    options.env ?? {},
  );

  return { service, rows, prisma };
}

describe('PromptEvalsService (EVAL-29.2)', () => {
  it('считает passRate и статус passed при пороге по умолчанию', async () => {
    const { service, rows } = harness();

    const result = await service.runEval({ versionId: VERSION_ID, cases });

    expect(result.passRate).toBe(1);
    expect(result.avgScore).toBe(100);
    expect(result.status).toBe('passed');
    expect(result.results).toHaveLength(2);
    expect(result.results.every((item) => item.deterministicPassed)).toBe(true);
    expect(rows[0]).toMatchObject({
      versionId: VERSION_ID,
      totalCases: 2,
      passedCases: 2,
      status: 'passed',
    });
  });

  it('помечает прогон failed, если judged-вердикт отрицательный', async () => {
    const failingJudge: JudgeClient = {
      judge: vi.fn(async (): Promise<JudgeVerdict> => ({
        score: 42,
        passed: false,
        reasoning: 'Не выполнены обязательные пункты',
      })),
    };
    const { service } = harness({ judge: failingJudge });
    const result = await service.runEval({ versionId: VERSION_ID, cases });

    expect(result.passRate).toBe(0);
    expect(result.avgScore).toBe(42);
    expect(result.status).toBe('failed');
    expect(result.results[0]?.deterministicPassed).toBe(true);
    expect(result.results[0]?.verdict.passed).toBe(false);
  });

  it('детерминированные метрики ловят расхождение tool_calls и HITL', async () => {
    const runner = {
      run: vi.fn(
        async (testCase: (typeof cases)[number]): Promise<EvalCaseTrace> => ({
          toolCalls: ['wrong_tool'],
          hitlRequested: !testCase.requiresHitl,
          reply: 'неверный ответ',
        }),
      ),
    };
    const { service } = harness({ runner });
    const result = await service.runEval({ versionId: VERSION_ID, cases });

    expect(result.results[0]).toMatchObject({
      toolCallsMatch: false,
      hitlMatch: false,
      deterministicPassed: false,
    });
    expect(result.status).toBe('failed');
  });

  it('учитывает кастомный порог EVALS_MIN_PASS_RATE', async () => {
    const judge: JudgeClient = {
      judge: vi.fn(async (request): Promise<JudgeVerdict> => {
        const input = JSON.parse(request.userPrompt) as { caseId: string };

        return {
          score: input.caseId === 'A-01' ? 90 : 40,
          passed: input.caseId === 'A-01',
          reasoning: 'по рубрике',
        };
      }),
    };
    const { service } = harness({
      judge,
      env: { EVALS_MIN_PASS_RATE: '0.4' },
    });

    expect(readEvalsConfig({ EVALS_MIN_PASS_RATE: '0.4' }).minPassRate).toBe(0.4);
    const result = await service.runEval({ versionId: VERSION_ID, cases });

    expect(result.passRate).toBe(0.5);
    expect(result.status).toBe('passed');
  });

  it('отклоняет прогон без кейсов', async () => {
    const { service } = harness({});

    await expect(
      service.runEval({ versionId: VERSION_ID, trackId: 'Z' as never }),
    ).rejects.toThrow();
    // Пустой массив кейсов отклоняется уже Zod-схемой запроса.
    await expect(
      service.runEval({ versionId: VERSION_ID, cases: [] }),
    ).rejects.toThrow();
  });
});

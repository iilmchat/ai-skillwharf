import { AxiosError, type AxiosResponse } from 'axios';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  fetchPromptEvals,
  getAdminErrorMessage,
  promptEvalCaseResultSchema,
  promptEvalRunListSchema,
  promptEvalRunSchema,
  runPromptEval,
  runPromptEvalSchema,
} from './admin';

const { getMock, postMock } = vi.hoisted(() => ({
  getMock: vi.fn(),
  postMock: vi.fn(),
}));

vi.mock('./api', () => ({
  api: { get: getMock, post: postMock },
}));

vi.mock('../i18n', () => ({
  default: {
    t: (key: string) => `перевод:${key}`,
    exists: (key: string) => key.startsWith('errors.'),
  },
}));

const VALID_RESULT = {
  caseId: 'case-1',
  trackId: 'I',
  title: 'Распознать счёт',
  passed: true,
  score: 92,
  reasoning: 'Ответ соответствует эталону.',
};

const VALID_RUN = {
  id: 'eval-1',
  promptId: 'prompt-1',
  versionId: 'ver-2',
  trackFilter: null,
  totalCases: 10,
  passedCases: 9,
  passRate: 90,
  avgScore: 88.5,
  status: 'passed',
  results: [VALID_RESULT],
  createdAt: '2026-11-19T10:00:00.000Z',
};

function apiError(body: unknown, status = 409): AxiosError {
  const response = {
    status,
    statusText: '',
    headers: {},
    config: {},
    data: body,
  } as unknown as AxiosResponse;

  return new AxiosError('запрос отклонён', undefined, undefined, undefined, response);
}

describe('Zod-контракт LLM Evals', () => {
  it('принимает результат кейса и отвергает неизвестный трек', () => {
    expect(promptEvalCaseResultSchema.parse(VALID_RESULT)).toEqual(VALID_RESULT);
    expect(
      promptEvalCaseResultSchema.safeParse({
        ...VALID_RESULT,
        trackId: 'M',
      }).success,
    ).toBe(false);
    expect(
      promptEvalCaseResultSchema.safeParse({
        ...VALID_RESULT,
        score: 101,
      }).success,
    ).toBe(false);
  });

  it('приводит вердикт судьи API к плоскому результату кейса', () => {
    const parsed = promptEvalCaseResultSchema.parse({
      caseId: 'case-2',
      trackId: 'A',
      deterministicPassed: true,
      toolCallsMatch: true,
      hitlMatch: false,
      verdict: {
        score: 74,
        passed: false,
        reasoning: 'Нарушена последовательность HITL.',
      },
    });

    expect(parsed).toEqual({
      caseId: 'case-2',
      trackId: 'A',
      title: 'case-2',
      passed: false,
      score: 74,
      reasoning: 'Нарушена последовательность HITL.',
    });
  });

  it('переводит passRate API из доли 0..1 в проценты', () => {
    const parsed = promptEvalRunSchema.parse({
      ...VALID_RUN,
      passRate: 0.9,
      results: [
        {
          caseId: 'case-3',
          trackId: 'B',
          verdict: { score: 60, passed: false, reasoning: 'Нет инструмента.' },
        },
      ],
    });

    expect(parsed.passRate).toBe(90);
    expect(parsed.results?.[0]?.reasoning).toBe('Нет инструмента.');
    expect(promptEvalRunSchema.parse({ ...VALID_RUN, passRate: 75 }).passRate).toBe(
      75,
    );
  });

  it('принимает прогон с результатами и без них', () => {
    const parsed = promptEvalRunSchema.parse(VALID_RUN);

    expect(parsed.status).toBe('passed');
    expect(parsed.results?.[0]?.passed).toBe(true);
    expect(
      promptEvalRunSchema.parse({
        ...VALID_RUN,
        trackFilter: 'A',
        results: undefined,
      }).results,
    ).toBeUndefined();
  });

  it('отвергает неверный статус и проценты вне диапазона', () => {
    expect(
      promptEvalRunSchema.safeParse({ ...VALID_RUN, status: 'done' }).success,
    ).toBe(false);
    expect(
      promptEvalRunSchema.safeParse({ ...VALID_RUN, passRate: 101 }).success,
    ).toBe(false);
    expect(
      promptEvalRunSchema.safeParse({ ...VALID_RUN, avgScore: -1 }).success,
    ).toBe(false);
  });

  it('принимает историю в массиве и в обёртке', () => {
    expect(promptEvalRunListSchema.parse([VALID_RUN])).toHaveLength(1);
    expect(promptEvalRunListSchema.parse({ items: [VALID_RUN] })).toHaveLength(1);
    expect(promptEvalRunListSchema.parse({ runs: [VALID_RUN] })).toHaveLength(1);
  });

  it('валидирует форму запуска и трек A–L', () => {
    expect(
      runPromptEvalSchema.parse({ versionId: 'ver-2', trackId: 'I' }),
    ).toEqual({ versionId: 'ver-2', trackId: 'I' });
    expect(runPromptEvalSchema.parse({ versionId: 'ver-2' })).toEqual({
      versionId: 'ver-2',
    });
    expect(
      runPromptEvalSchema.safeParse({ versionId: 'ver-2', trackId: 'M' }).success,
    ).toBe(false);
    expect(
      runPromptEvalSchema.safeParse({ versionId: '' }).success,
    ).toBe(false);
  });
});

describe('клиент LLM Evals', () => {
  beforeEach(() => {
    getMock.mockReset();
    postMock.mockReset();
  });

  it('загружает историю прогонов по id шаблона', async () => {
    getMock.mockResolvedValueOnce({ data: { items: [VALID_RUN] } });

    const result = await fetchPromptEvals('prompt/1');

    expect(getMock).toHaveBeenCalledWith('/prompts/prompt%2F1/evals');
    expect(result[0]?.avgScore).toBe(88.5);
  });

  it('запускает прогон с фильтром по треку и без него', async () => {
    postMock.mockResolvedValue({ data: VALID_RUN });

    await runPromptEval('prompt-1', { versionId: 'ver-2', trackId: 'I' });
    expect(postMock).toHaveBeenLastCalledWith(
      '/prompts/prompt-1/evals/run',
      { versionId: 'ver-2', trackId: 'I' },
    );

    await runPromptEval('prompt-1', { versionId: 'ver-2' });
    expect(postMock).toHaveBeenLastCalledWith(
      '/prompts/prompt-1/evals/run',
      { versionId: 'ver-2' },
    );
  });

  it('отвергает невалидный ответ API', async () => {
    getMock.mockResolvedValueOnce({ data: { items: [{ id: 'eval' }] } });

    await expect(fetchPromptEvals('prompt-1')).rejects.toThrow();
  });

  it('переводит errors.eval_gate_failed из machine-readable кода', () => {
    const error = apiError({
      statusCode: 409,
      error: 'Conflict',
      code: 'errors.eval_gate_failed',
      message: 'Не пройден Eval',
    });

    expect(getAdminErrorMessage(error, 'admin.experiments.errors.stop')).toBe(
      'перевод:errors.eval_gate_failed',
    );
  });

  it('переводит errors.* из текстового сообщения', () => {
    const error = apiError({ message: 'errors.eval_gate_failed' });

    expect(getAdminErrorMessage(error, 'admin.experiments.errors.stop')).toBe(
      'перевод:errors.eval_gate_failed',
    );
  });
});

import { describe, expect, it } from 'vitest';
import {
  evalCaseSchema,
  judgeVerdictSchema,
  parseEvalDataset,
  runEvalSchema,
} from './prompt-eval.schemas.js';

const validCase = {
  id: 'A-01',
  trackId: 'A',
  title: 'Проверка остатков',
  input: 'Проверь остатки SKU-1001',
  expectedTools: ['moysklad_check_stock'],
  requiresHitl: false,
  rubric: ['Вызван инструмент проверки остатков'],
};

describe('evalCaseSchema', () => {
  it('принимает валидный кейс и отвергает неверный трек', () => {
    expect(evalCaseSchema.safeParse(validCase).success).toBe(true);
    expect(
      evalCaseSchema.safeParse({ ...validCase, trackId: 'Z' }).success,
    ).toBe(false);
    expect(
      evalCaseSchema.safeParse({ ...validCase, requiresHitl: 'true' }).success,
    ).toBe(false);
  });

  it(' parseEvalDataset приводит рубрику required/forbidden к массиву', () => {
    const parsed = parseEvalDataset({
      trackId: 'A',
      cases: [
        {
          ...validCase,
          rubric: {
            required: ['Назван остаток'],
            forbidden: ['Списать без одобрения'],
          },
        },
      ],
    });

    expect(parsed).toHaveLength(1);
    expect(parsed[0]?.rubric).toEqual([
      'Назван остаток',
      'НЕ: Списать без одобрения',
    ]);
  });

  it('отклоняет датасет с невалидной структурой', () => {
    expect(() => parseEvalDataset({ trackId: 'A', cases: [] })).toThrow();
    expect(() =>
      parseEvalDataset({ trackId: 'A', cases: [{ ...validCase, rubric: {} }] }),
    ).toThrow();
  });
});

describe('judgeVerdictSchema', () => {
  it('принимает вердикт в границах 0..100 и отклоняет лишние поля', () => {
    expect(
      judgeVerdictSchema.safeParse({
        score: 87.5,
        passed: true,
        reasoning: 'Все пункты рубрики выполнены',
      }).success,
    ).toBe(true);
    expect(
      judgeVerdictSchema.safeParse({ score: 101, passed: true, reasoning: 'x' })
        .success,
    ).toBe(false);
    expect(
      judgeVerdictSchema.safeParse({
        score: 50,
        passed: false,
        reasoning: 'x',
        extra: true,
      }).success,
    ).toBe(false);
    expect(
      judgeVerdictSchema.safeParse({ score: 50, passed: false, reasoning: '' })
        .success,
    ).toBe(false);
  });

  it('runEvalSchema требует versionId и опциональный trackId', () => {
    expect(runEvalSchema.safeParse({}).success).toBe(false);
    expect(
      runEvalSchema.safeParse({ versionId: 'v2', trackId: 'L' }).success,
    ).toBe(true);
  });
});

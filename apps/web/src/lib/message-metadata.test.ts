import { describe, expect, it } from 'vitest';
import {
  assistantMessageMetadataSchema,
  isCacheHitMessage,
  parseAssistantMessageMetadata,
} from './message-metadata';

const ARTIFACT = {
  id: 'art-1',
  type: 'document',
  title: 'Договор',
  content: 'Текст',
};

const STEP = {
  stepIndex: 0,
  name: 'Поиск',
  durationMs: 100,
  status: 'completed',
};

describe('assistantMessageMetadataSchema (Sprint 37)', () => {
  it('принимает артефакты и шаги выполнения', () => {
    const parsed = assistantMessageMetadataSchema.parse({
      cacheHit: true,
      artifacts: [ARTIFACT],
      executionTrace: [STEP],
    });

    expect(parsed.artifacts?.[0]?.title).toBe('Договор');
    expect(parsed.executionTrace?.[0]?.stepIndex).toBe(0);
    expect(isCacheHitMessage({ metadata: parsed })).toBe(true);
  });

  it('остаётся совместимой со старыми метаданными', () => {
    const parsed = assistantMessageMetadataSchema.parse({ cacheHit: false });

    expect(parsed.artifacts).toBeUndefined();
    expect(parsed.executionTrace).toBeUndefined();
  });

  it('отклоняет невалидные артефакты и шаги', () => {
    expect(
      assistantMessageMetadataSchema.safeParse({ artifacts: [{ ...ARTIFACT, id: '' }] })
        .success,
    ).toBe(false);
    expect(
      assistantMessageMetadataSchema.safeParse({
        executionTrace: [{ ...STEP, status: 'unknown' }],
      }).success,
    ).toBe(false);
  });
});

describe('parseAssistantMessageMetadata', () => {
  it('возвращает только валидные метаданные', () => {
    expect(
      parseAssistantMessageMetadata({
        cacheHit: true,
        artifacts: [{ ...ARTIFACT, type: 'image' }],
      }),
    ).toEqual({});
    expect(parseAssistantMessageMetadata({ artifacts: [ARTIFACT] })).toEqual({
      artifacts: [ARTIFACT],
    });
    expect(parseAssistantMessageMetadata(null)).toEqual({});
  });
});

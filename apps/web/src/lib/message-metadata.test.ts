import { describe, expect, it } from 'vitest';
import {
  assistantMessageMetadataSchema,
  citationSchema,
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

describe('citationSchema (KB-38.2)', () => {
  const CITATION = {
    index: 1,
    chunkId: 'chunk-1',
    title: 'Регламент приёмки',
    snippet: 'Проверка номенклатуры',
    pageNumber: 4,
  };

  it('принимает сноску с номером страницы и без него', () => {
    expect(citationSchema.parse(CITATION)).toEqual(CITATION);
    expect(
      citationSchema.parse({
        index: CITATION.index,
        chunkId: CITATION.chunkId,
        title: CITATION.title,
        snippet: CITATION.snippet,
      }).pageNumber,
    ).toBeUndefined();
  });

  it('отклоняет сноску без обязательных полей', () => {
    expect(
      citationSchema.safeParse({
        index: CITATION.index,
        title: CITATION.title,
        snippet: CITATION.snippet,
      }).success,
    ).toBe(false);
    expect(citationSchema.safeParse({ index: '1' }).success).toBe(false);
  });

  it('входит в метаданные ответа и отбрасывается парсером при ошибке', () => {
    const parsed = assistantMessageMetadataSchema.parse({
      citations: [CITATION],
    });

    expect(parsed.citations?.[0]?.title).toBe('Регламент приёмки');
    expect(
      parseAssistantMessageMetadata({ citations: [{ ...CITATION, snippet: 3 }] }),
    ).toEqual({});
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

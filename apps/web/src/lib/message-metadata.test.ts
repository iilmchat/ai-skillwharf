import { describe, expect, it } from 'vitest';
import {
  assistantMessageMetadataSchema,
  isCacheHitMessage,
  parseAssistantMessageMetadata,
} from './message-metadata';

describe('assistantMessageMetadataSchema', () => {
  it('принимает cacheHit=true и false', () => {
    expect(assistantMessageMetadataSchema.parse({ cacheHit: true })).toEqual({
      cacheHit: true,
    });
    expect(assistantMessageMetadataSchema.parse({ cacheHit: false })).toEqual({
      cacheHit: false,
    });
  });

  it('совместим со старым ответом без метаданных', () => {
    expect(assistantMessageMetadataSchema.parse({})).toEqual({});
  });

  it('отвергает нелогическое значение cacheHit', () => {
    expect(
      assistantMessageMetadataSchema.safeParse({ cacheHit: 'true' }).success,
    ).toBe(false);
    expect(
      assistantMessageMetadataSchema.safeParse({ cacheHit: 1 }).success,
    ).toBe(false);
  });

  it('показывает бейдж только при cacheHit: true', () => {
    expect(isCacheHitMessage({ metadata: { cacheHit: true } })).toBe(true);
    expect(isCacheHitMessage({ metadata: { cacheHit: false } })).toBe(false);
    expect(isCacheHitMessage({})).toBe(false);
  });

  it('парсер игнорирует невалидные и лишние поля', () => {
    expect(parseAssistantMessageMetadata({ cacheHit: true, extra: 'x' })).toEqual({
      cacheHit: true,
    });
    expect(parseAssistantMessageMetadata({ cacheHit: 'true' })).toEqual({});
    expect(parseAssistantMessageMetadata(null)).toEqual({});
  });
});

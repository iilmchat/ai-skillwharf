import { describe, expect, it } from 'vitest';
import {
  DEFAULT_PROVIDER_TYPE,
  isNativeProviderType,
  normalizeProviderType,
} from './provider-type.js';

describe('normalizeProviderType', () => {
  it('приводит известные типы к каноническому виду', () => {
    expect(normalizeProviderType('yandexgpt')).toBe('YandexGPT');
    expect(normalizeProviderType('GIGACHAT')).toBe('GigaChat');
  });

  it('оставляет OpenAI-совместимые провайдеры как есть', () => {
    expect(normalizeProviderType('OpenAI')).toBe('OpenAI');
  });

  it('подставляет провайдера по умолчанию для пустых значений', () => {
    expect(normalizeProviderType('')).toBe(DEFAULT_PROVIDER_TYPE);
    expect(normalizeProviderType(undefined)).toBe(DEFAULT_PROVIDER_TYPE);
    expect(normalizeProviderType(null)).toBe(DEFAULT_PROVIDER_TYPE);
    expect(normalizeProviderType(42)).toBe(DEFAULT_PROVIDER_TYPE);
  });
});

describe('isNativeProviderType', () => {
  it('распознаёт YandexGPT и GigaChat', () => {
    expect(isNativeProviderType('YandexGPT')).toBe(true);
    expect(isNativeProviderType('gigachat')).toBe(true);
  });

  it('не считает нативными остальные провайдеры', () => {
    expect(isNativeProviderType('OpenAI')).toBe(false);
    expect(isNativeProviderType(undefined)).toBe(false);
  });
});

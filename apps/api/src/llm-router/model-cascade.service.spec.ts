import { describe, expect, it } from 'vitest';
import type { LlmRouteSelection } from './llm-router.service.js';
import {
  classifyQueryComplexity,
  ModelCascadeService,
} from './model-cascade.service.js';

const route: LlmRouteSelection = {
  id: 'route-1',
  name: 'main',
  modelName: 'flagship-model',
  providerType: 'openai',
  baseUrl: 'https://llm.example.com/v1',
  apiKeyEnvVar: null,
  taskType: 'chat',
  dailyCostLimit: null,
};

describe('classifyQueryComplexity (CASCADE-44.1)', () => {
  it('короткий запрос без инструментов — lite', () => {
    expect(classifyQueryComplexity('Привет, как дела?', false)).toBe('lite');
  });

  it('средний запрос и активные инструменты — standard', () => {
    expect(
      classifyQueryComplexity(
        'Подготовь подробное описание товара для каталога с указанием характеристик, материалов и сроков поставки, чтобы менеджер мог проверить данные перед публикацией на маркетплейсе',
        false,
      ),
    ).toBe('standard');
    expect(classifyQueryComplexity('Привет', true)).toBe('standard');
  });

  it('маркеры сложной работы и длинный промпт — flagship', () => {
    expect(classifyQueryComplexity('Проверь договор поставки', false)).toBe('flagship');
    expect(classifyQueryComplexity('Сделай сверку УПД', false)).toBe('flagship');
    expect(classifyQueryComplexity('а'.repeat(900), false)).toBe('flagship');
  });
});

describe('ModelCascadeService', () => {
  it('с выключенным каскадом возвращает исходные маршруты', () => {
    const service = new ModelCascadeService({});

    const result = service.apply([route], 'Привет', false);

    expect(result.modelTier).toBe('lite');
    expect(result.routes[0]?.modelName).toBe('flagship-model');
  });

  it('с включённым каскадом подставляет lite-модель', () => {
    const service = new ModelCascadeService({
      LLM_CASCADE_ENABLED: 'true',
      LLM_CASCADE_LITE_MODEL: 'lite-model',
    });

    const result = service.apply([route], 'Привет', false);

    expect(result.modelTier).toBe('lite');
    expect(result.routes[0]?.modelName).toBe('lite-model');
  });

  it('сложные запросы остаются на основной модели', () => {
    const service = new ModelCascadeService({
      LLM_CASCADE_ENABLED: 'true',
      LLM_CASCADE_LITE_MODEL: 'lite-model',
    });

    const result = service.apply([route], 'Проверь договор', false);

    expect(result.modelTier).toBe('flagship');
    expect(result.routes[0]?.modelName).toBe('flagship-model');
  });
});

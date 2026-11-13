import {
  buildGenAiUsageAttributes,
  tracingEndpoint,
} from './tracing.js';

describe('tracing', () => {
  it('включается только при заданном OTLP endpoint', () => {
    expect(tracingEndpoint({})).toBeUndefined();
    expect(
      tracingEndpoint({ OTEL_EXPORTER_OTLP_ENDPOINT: 'http://collector:4318' }),
    ).toBe('http://collector:4318');
    expect(
      tracingEndpoint({
        OTEL_EXPORTER_OTLP_ENDPOINT: 'http://collector:4318',
        OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: 'http://traces:4318/v1/traces',
      }),
    ).toBe('http://traces:4318/v1/traces');
  });

  it('формирует атрибуты gen_ai по AgentOps-спецификации', () => {
    const attributes = buildGenAiUsageAttributes({
      system: 'openai',
      model: 'gpt-4o',
      tenantId: 'user-1',
      agentId: 'office',
      skillId: 'skill-1',
      promptTokens: 100,
      completionTokens: 50,
      cost: 0.015,
    });

    expect(attributes).toMatchObject({
      'gen_ai.system': 'openai',
      'gen_ai.agent.id': 'office',
      'gen_ai.tenant.id': 'user-1',
      'gen_ai.skill.id': 'skill-1',
      'gen_ai.request.model': 'gpt-4o',
      'gen_ai.usage.cost': 0.015,
      'gen_ai.usage.input_tokens': 100,
      'gen_ai.usage.output_tokens': 50,
      'gen_ai.usage.total_tokens': 150,
      'gen_ai.usage_estimated': false,
    });
  });

  it('не добавляет skill.id, если навык не определён, и округляет стоимость', () => {
    const attributes = buildGenAiUsageAttributes({
      system: 'gigachat',
      model: 'GigaChat',
      tenantId: 'anonymous',
      agentId: 'unknown',
      promptTokens: 0,
      completionTokens: 3,
      cost: 0.000123456,
    });

    expect(attributes).not.toHaveProperty('gen_ai.skill.id');
    expect(attributes['gen_ai.usage.cost']).toBe(0.0001);
    expect(attributes['gen_ai.usage.total_tokens']).toBe(3);
  });
});

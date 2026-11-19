import { Test, type TestingModule } from '@nestjs/testing';
import { MetricsModule } from './metrics.module.js';
import { METRICS_ENV, MetricsService } from './metrics.service.js';

describe('MetricsService', () => {
  it('экспортирует стандартные и кастомные метрики в формате Prometheus', async () => {
    const service = new MetricsService();

    service.observeHttpRequest('GET', '/api/v1/health', 200);
    service.countLlmTokens('openai', 'gpt-4o', 10, 5);
    service.countLlmError('openai', 'gpt-4o', 'TypeError');
    service.countLlmCost('user-1', 'gpt-4o', 'office', 0.015);

    const { contentType, body } = await service.render();

    expect(contentType).toContain('text/plain');
    expect(body).toContain('process_cpu_seconds_total');
    expect(body).toMatch(
      /http_requests_total\{[^}]*method="GET"[^}]*route="\/api\/v1\/health"[^}]*status="200"[^}]*\} 1/,
    );
    expect(body).toMatch(
      /llm_tokens_total\{[^}]*provider="openai"[^}]*model="gpt-4o"[^}]*type="prompt"[^}]*\} 10/,
    );
    expect(body).toMatch(
      /llm_tokens_total\{[^}]*provider="openai"[^}]*model="gpt-4o"[^}]*type="completion"[^}]*\} 5/,
    );
    expect(body).toMatch(
      /llm_errors_total\{[^}]*provider="openai"[^}]*model="gpt-4o"[^}]*reason="TypeError"[^}]*\} 1/,
    );
    expect(body).toMatch(
      /llm_cost_total\{[^}]*tenant_id="user-1"[^}]*model="gpt-4o"[^}]*agent_id="office"[^}]*\} 0\.015/,
    );
  });

  it('KI-088: MetricsService разрешается DI через MetricsModule', async () => {
    const moduleRef: TestingModule = await Test.createTestingModule({
      imports: [MetricsModule],
    }).compile();

    const service = moduleRef.get(MetricsService);

    expect(service).toBeInstanceOf(MetricsService);
    expect(moduleRef.get(METRICS_ENV)).toBe(process.env);

    const { body } = await service.render();

    expect(body).toContain('process_cpu_seconds_total');
    await moduleRef.close();
  });

  it('KI-088: env можно переопределить через DI-токен', async () => {
    const env = { NODE_ENV: 'production', METRICS_HASH_TENANT_ID: 'true' };
    const moduleRef: TestingModule = await Test.createTestingModule({
      imports: [MetricsModule],
    })
      .overrideProvider(METRICS_ENV)
      .useValue(env)
      .compile();

    const service = moduleRef.get(MetricsService);

    service.countLlmCost('user-1', 'gpt-4o', 'office', 1);
    const { body } = await service.render();

    expect(body).toMatch(/tenant_id="t_[0-9a-f]{12}"/);
    await moduleRef.close();
  });
});

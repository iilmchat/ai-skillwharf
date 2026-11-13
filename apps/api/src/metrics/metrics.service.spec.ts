import { MetricsService } from './metrics.service.js';

describe('MetricsService', () => {
  it('экспортирует стандартные и кастомные метрики в формате Prometheus', async () => {
    const service = new MetricsService();

    service.observeHttpRequest('GET', '/api/v1/health', 200);
    service.countLlmTokens('openai', 'gpt-4o', 10, 5);
    service.countLlmError('openai', 'gpt-4o', 'TypeError');

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
  });
});

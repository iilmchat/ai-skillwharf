import { Injectable } from '@nestjs/common';
import {
  collectDefaultMetrics,
  Counter,
  Registry,
} from '@prometheus-io/client';

/**
 * Метрики Prometheus. Реестр собственный, чтобы в тестах и в приложении не
 * смешиваться с глобальным реестром пакета (повторная регистрация метрик при
 * нескольких инстансах сервиса бросает ошибку).
 */
@Injectable()
export class MetricsService {
  private readonly registry = new Registry();

  private readonly httpRequestsTotal = new Counter({
    name: 'http_requests_total',
    help: 'Total number of HTTP requests',
    labelNames: ['method', 'route', 'status'] as const,
    registers: [this.registry],
  });

  private readonly llmTokensTotal = new Counter({
    name: 'llm_tokens_total',
    help: 'Total number of LLM tokens consumed',
    labelNames: ['provider', 'model', 'type'] as const,
    registers: [this.registry],
  });

  private readonly llmErrorsTotal = new Counter({
    name: 'llm_errors_total',
    help: 'Total number of failed LLM calls',
    labelNames: ['provider', 'model', 'reason'] as const,
    registers: [this.registry],
  });

  constructor() {
    // process_*, nodejs_* — стандартные метрики клиента Prometheus.
    collectDefaultMetrics({ register: this.registry });
  }

  observeHttpRequest(method: string, route: string, status: number): void {
    this.httpRequestsTotal.inc({ method, route, status: String(status) });
  }

  countLlmTokens(
    provider: string,
    model: string,
    promptTokens: number,
    completionTokens: number,
  ): void {
    if (promptTokens > 0) {
      this.llmTokensTotal.inc(
        { provider, model, type: 'prompt' },
        promptTokens,
      );
    }

    if (completionTokens > 0) {
      this.llmTokensTotal.inc(
        { provider, model, type: 'completion' },
        completionTokens,
      );
    }
  }

  countLlmError(provider: string, model: string, reason: string): void {
    this.llmErrorsTotal.inc({ provider, model, reason });
  }

  async render(): Promise<{ contentType: string; body: string }> {
    return {
      contentType: this.registry.contentType,
      body: await this.registry.metrics(),
    };
  }
}

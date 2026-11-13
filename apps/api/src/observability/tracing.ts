import { trace, type Attributes } from '@opentelemetry/api';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { ExpressInstrumentation } from '@opentelemetry/instrumentation-express';
import { HttpInstrumentation } from '@opentelemetry/instrumentation-http';
import { NestInstrumentation } from '@opentelemetry/instrumentation-nestjs-core';
import { NodeSDK } from '@opentelemetry/sdk-node';

const tracer = trace.getTracer('skillwharf-api');

let sdk: NodeSDK | undefined;

/** OTLP endpoint: явный traces-endpoint важнее общего. */
export function tracingEndpoint(
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  const traces = env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT?.trim();
  const common = env.OTEL_EXPORTER_OTLP_ENDPOINT?.trim();

  return traces || common || undefined;
}

/**
 * Включает OTel SDK только при заданном OTLP endpoint. Без коллектора
 * приложение работает как раньше и не пытается экспортировать спаны.
 */
export function startTracing(): boolean {
  if (sdk) {
    return true;
  }

  const endpoint = tracingEndpoint();

  if (!endpoint) {
    console.log(
      'otel: tracing disabled (OTEL_EXPORTER_OTLP_ENDPOINT is not set)',
    );
    return false;
  }

  try {
    sdk = new NodeSDK({
      serviceName: process.env.OTEL_SERVICE_NAME?.trim() || 'skillwharf-api',
      traceExporter: new OTLPTraceExporter(),
      instrumentations: [
        new HttpInstrumentation(),
        new ExpressInstrumentation(),
        new NestInstrumentation(),
      ],
    });
    sdk.start();
    console.log(`otel: tracing enabled -> ${endpoint}`);
    return true;
  } catch (error) {
    sdk = undefined;
    console.error(
      `otel: не удалось запустить tracing: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    return false;
  }
}

export async function shutdownTracing(): Promise<void> {
  if (!sdk) {
    return;
  }

  try {
    await sdk.shutdown();
  } catch (error) {
    console.warn(
      `otel: ошибка shutdown: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  } finally {
    sdk = undefined;
  }
}

export interface GenAiUsageSpanInput {
  system: string;
  model: string;
  tenantId: string;
  agentId: string;
  skillId?: string;
  promptTokens: number;
  completionTokens: number;
  /** Стоимость в рублях. */
  cost: number;
  estimated?: boolean;
}

/** Атрибуты по AgentOps-Specification.md, раздел 2. */
export function buildGenAiUsageAttributes(
  input: GenAiUsageSpanInput,
): Attributes {
  const totalTokens =
    Math.max(0, input.promptTokens) + Math.max(0, input.completionTokens);

  const attributes: Attributes = {
    'gen_ai.system': input.system,
    'gen_ai.agent.id': input.agentId,
    'gen_ai.tenant.id': input.tenantId,
    'gen_ai.request.model': input.model,
    'gen_ai.usage.cost': Math.round(input.cost * 10000) / 10000,
    'gen_ai.usage.input_tokens': Math.max(0, input.promptTokens),
    'gen_ai.usage.output_tokens': Math.max(0, input.completionTokens),
    'gen_ai.usage.total_tokens': totalTokens,
    'gen_ai.usage_estimated': input.estimated ?? false,
  };

  if (input.skillId) {
    attributes['gen_ai.skill.id'] = input.skillId;
  }

  return attributes;
}

/**
 * Записывает завершённый спан использования LLM. Длительность запроса
 * измеряют HTTP/Nest-инструментации; этот спан фиксирует стоимость и
 * атрибуты GenAI для экспорта в OTLP-коллектор.
 */
export function recordGenAiUsageSpan(input: GenAiUsageSpanInput): void {
  const span = tracer.startSpan(`chat ${input.model}`, {
    attributes: buildGenAiUsageAttributes(input),
  });
  span.end();
}

export interface AgentRunSpanInput {
  agentId: string;
  tenantId: string;
  skillIds?: readonly string[];
}

export function recordAgentRunSpan(input: AgentRunSpanInput): void {
  const attributes: Attributes = {
    'gen_ai.agent.id': input.agentId,
    'gen_ai.tenant.id': input.tenantId,
  };

  const skillIds = input.skillIds?.filter((id) => id.length > 0) ?? [];
  if (skillIds.length > 0) {
    attributes['gen_ai.skill.id'] = skillIds.join(',');
  }

  const span = tracer.startSpan(`invoke_agent ${input.agentId}`, {
    attributes,
  });
  span.end();
}

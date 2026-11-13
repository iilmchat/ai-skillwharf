import { Injectable, Logger } from '@nestjs/common';
import type { GraphEvent } from './contracts.js';
import {
  errorEventSchema,
  graphEventSchema,
  resumeGraphRequestSchema,
  runGraphRequestSchema,
  type ResumeGraphRequest,
  type RunGraphRequest,
} from './contracts.js';
import { ApiException } from '../common/api-error.js';

/** Ошибка соединения с llm-worker. */
export class LlmWorkerUnavailableError extends ApiException {
  constructor(message: string) {
    super({
      statusCode: 502,
      error: 'Bad Gateway',
      code: 'errors.llm_unavailable',
      message,
    });
  }
}

interface WorkerConfig {
  baseUrl: string;
  token: string | null;
}

function readConfig(env: NodeJS.ProcessEnv = process.env): WorkerConfig {
  const rawUrl = env.LLM_WORKER_URL?.trim() ?? '';
  const token = env.INTERNAL_API_TOKEN?.trim() ?? '';

  return {
    baseUrl: rawUrl === '' ? 'http://llm-worker:4100' : rawUrl,
    token: token === '' ? null : token,
  };
}

/**
 * Клиент API → llm-worker.
 *
 * Транспорт — NDJSON поверх HTTP: API получает те же события, что раньше
 * приходили из custom-стрима LangGraph, и не зависит от `@langchain/*`.
 */
@Injectable()
export class LlmWorkerClient {
  private readonly logger = new Logger(LlmWorkerClient.name);
  private readonly config = readConfig();

  async *run(request: RunGraphRequest): AsyncGenerator<GraphEvent> {
    const body = runGraphRequestSchema.parse(request);

    yield* this.stream('/v1/graphs/run', body);
  }

  async *resume(request: ResumeGraphRequest): AsyncGenerator<GraphEvent> {
    const body = resumeGraphRequestSchema.parse(request);

    yield* this.stream('/v1/graphs/resume', body);
  }

  private async *stream(
    path: string,
    body: unknown,
  ): AsyncGenerator<GraphEvent> {
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      accept: 'application/x-ndjson',
    };

    if (this.config.token !== null) {
      headers['x-internal-token'] = this.config.token;
    }

    let response: Response;

    try {
      response = await fetch(`${this.config.baseUrl}${path}`, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(10 * 60 * 1000),
      });
    } catch (error) {
      this.logger.error(
        `llm-worker недоступен: ${error instanceof Error ? error.message : String(error)}`,
      );

      throw new LlmWorkerUnavailableError(
        'LLM-воркер недоступен, попробуйте позже',
      );
    }

    if (!response.ok || response.body === null) {
      const message = await readError(response);

      throw new LlmWorkerUnavailableError(message);
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();

      if (done) {
        break;
      }

      buffer += decoder.decode(value, { stream: true });

      let newlineIndex = buffer.indexOf('\n');

      while (newlineIndex >= 0) {
        const line = buffer.slice(0, newlineIndex).trim();
        buffer = buffer.slice(newlineIndex + 1);

        if (line !== '') {
          yield this.parseEvent(line);
        }

        newlineIndex = buffer.indexOf('\n');
      }
    }

    const tail = buffer.trim();

    if (tail !== '') {
      yield this.parseEvent(tail);
    }
  }

  private parseEvent(line: string): GraphEvent {
    let raw: unknown;

    try {
      raw = JSON.parse(line);
    } catch {
      throw new LlmWorkerUnavailableError(
        'LLM-воркер вернул некорректный ответ',
      );
    }

    const error = errorEventSchema.safeParse(raw);

    if (error.success) {
      throw new ApiException({
        statusCode: error.data.statusCode,
        error: statusText(error.data.statusCode),
        code: error.data.code ?? 'errors.llm_unavailable',
        message: error.data.message,
      });
    }

    const parsed = graphEventSchema.safeParse(raw);

    if (!parsed.success) {
      throw new LlmWorkerUnavailableError(
        'LLM-воркер вернул неизвестное событие',
      );
    }

    return parsed.data;
  }
}

async function readError(response: Response): Promise<string> {
  const raw: unknown = await response.json().catch(() => null);
  const record =
    raw !== null && typeof raw === 'object'
      ? (raw as Record<string, unknown>)
      : {};
  const message = record.message;

  return typeof message === 'string'
    ? message
    : `LLM-воркер вернул ${response.status}`;
}

function statusText(status: number): string {
  switch (status) {
    case 400:
      return 'Bad Request';
    case 401:
      return 'Unauthorized';
    case 403:
      return 'Forbidden';
    case 404:
      return 'Not Found';
    case 429:
      return 'Too Many Requests';
    case 502:
      return 'Bad Gateway';
    case 503:
      return 'Service Unavailable';
    default:
      return 'Internal Server Error';
  }
}

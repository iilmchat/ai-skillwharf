import { Logger } from '@nestjs/common';
import type { z } from 'zod';
import { readWorkerConfig } from './config.js';

/** Ошибка вызова внутреннего API. Сохраняет HTTP-статус и код для клиента. */
export class InternalApiError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: string | undefined,
    message: string,
  ) {
    super(message);
    this.name = 'InternalApiError';
  }
}

/**
 * HTTP-клиент worker → API. Все ответы валидируются Zod: внутренний контракт
 * такой же внешний, как и любой другой сетевой вызов.
 */
export class InternalApiClient {
  private readonly logger = new Logger(InternalApiClient.name);
  private readonly baseUrl: string | null;
  private readonly token: string | null;
  private readonly timeoutMs: number;

  constructor() {
    const config = readWorkerConfig();

    this.baseUrl = config.internalApiUrl;
    this.token = config.internalToken;
    this.timeoutMs = config.requestTimeoutMs;

    if (this.baseUrl === null) {
      this.logger.warn(
        'INTERNAL_API_URL не задан: инструменты, HITL и бюджет недоступны (echo-режим)',
      );
    }
  }

  isConfigured(): boolean {
    return this.baseUrl !== null;
  }

  async post<T>(
    path: string,
    body: unknown,
    schema: z.ZodType<T>,
  ): Promise<T> {
    if (this.baseUrl === null) {
      throw new InternalApiError(
        503,
        'errors.llm_worker_unavailable',
        'Внутренний API не сконфигурирован (INTERNAL_API_URL)',
      );
    }

    const headers: Record<string, string> = {
      'content-type': 'application/json',
    };

    if (this.token !== null) {
      headers['x-internal-token'] = this.token;
    }

    let response: Response;

    try {
      response = await fetch(`${this.baseUrl}${path}`, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (error) {
      throw new InternalApiError(
        502,
        'errors.llm_worker_unavailable',
        `Внутренний API недоступен: ${describe(error)}`,
      );
    }

    const raw: unknown = await response.json().catch(() => null);

    if (!response.ok) {
      const parsed = parseErrorBody(raw);

      throw new InternalApiError(
        response.status,
        parsed.code,
        parsed.message ?? `Внутренний API вернул ${response.status}`,
      );
    }

    const parsed = schema.safeParse(raw);

    if (!parsed.success) {
      throw new InternalApiError(
        502,
        'errors.llm_worker_unavailable',
        `Некорректный ответ внутреннего API ${path}: ${parsed.error.message}`,
      );
    }

    return parsed.data;
  }
}

function parseErrorBody(body: unknown): { code?: string; message?: string } {
  if (body === null || typeof body !== 'object') {
    return {};
  }

  const record = body as Record<string, unknown>;
  const code = typeof record.code === 'string' ? record.code : undefined;
  const message =
    typeof record.message === 'string' ? record.message : undefined;

  return {
    ...(code === undefined ? {} : { code }),
    ...(message === undefined ? {} : { message }),
  };
}

export function describe(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}

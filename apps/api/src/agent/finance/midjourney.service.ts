import { Injectable, Logger, Optional } from '@nestjs/common';
import { z } from 'zod';
import {
  providerNotConfiguredError,
  providerUnavailableError,
} from '../../common/api-error.js';
import {
  providerRequest,
  type ProviderRetryPolicy,
} from '../../integrations/provider-http.js';
import { MidjourneyConfig } from './midjourney.config.js';

/** Ответ отправки промпта: провайдеры называют id по-разному. */
export const midjourneySubmitSchema = z.record(z.string(), z.unknown());

/** Ответ статуса задачи. */
export const midjourneyTaskSchema = z.record(z.string(), z.unknown());

/** Результат генерации. */
export interface MidjourneyImage {
  readonly taskId: string;
  readonly imageUrl: string;
  readonly status: string;
}

/** Статусы, означающие «ещё работаем». */
const PENDING_STATUSES = new Set([
  'pending',
  'processing',
  'running',
  'queued',
  'submitted',
  'in_progress',
  'started',
]);

/** Статусы успеха. */
const SUCCESS_STATUSES = new Set([
  'completed',
  'complete',
  'done',
  'succeeded',
  'success',
  'finished',
]);

/** Статусы ошибки. */
const FAILED_STATUSES = new Set([
  'failed',
  'failure',
  'error',
  'canceled',
  'cancelled',
  'rejected',
]);

const TASK_ID_KEYS = [
  'taskId',
  'task_id',
  'jobId',
  'job_id',
  'id',
  'requestId',
  'request_id',
] as const;

const STATUS_KEYS = [
  'status',
  'state',
  'taskStatus',
  'task_status',
  'jobStatus',
  'job_status',
] as const;

const IMAGE_URL_KEYS = [
  'imageUrl',
  'image_url',
  'imageURL',
  'url',
  'resultUrl',
  'result_url',
  'outputUrl',
  'output_url',
] as const;

/**
 * Клиент Midjourney API с асинхронным поллингом.
 *
 * Отправка промпта → task id → поллинг до ready/failed. 429/5xx на каждом
 * HTTP-вызове повторяет `providerRequest` с экспоненциальным backoff.
 * Без `MIDJOURNEY_API_KEY` сетевых вызовов нет (503
 * `errors.provider_not_configured`).
 */
@Injectable()
export class MidjourneyService {
  private readonly logger = new Logger(MidjourneyService.name);
  private readonly config: MidjourneyConfig;
  private readonly retry: ProviderRetryPolicy | undefined;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly now: () => Date;

  constructor(
    @Optional() config?: MidjourneyConfig,
    @Optional() retry?: ProviderRetryPolicy,
    @Optional() sleep?: (ms: number) => Promise<void>,
    @Optional() now?: () => Date,
  ) {
    this.config = config ?? MidjourneyConfig.fromEnv();
    this.retry = retry;
    this.sleep =
      sleep ??
      ((ms: number) =>
        new Promise((resolve) => {
          setTimeout(resolve, ms);
        }));
    this.now = now ?? (() => new Date());
  }

  isConfigured(): boolean {
    return this.config.isConfigured();
  }

  /** Генерирует изображение и возвращает URL готовой картинки. */
  async generate(prompt: string): Promise<MidjourneyImage> {
    this.assertConfigured();

    const baseUrl = this.config.baseUrl ?? '';
    const trimmed = prompt.trim();

    if (trimmed === '') {
      throw providerUnavailableError('Midjourney: пустой промпт');
    }

    const taskId = await this.submit(baseUrl, trimmed);
    const deadline = this.now().getTime() + this.config.timeoutMs;
    let polls = 0;

    while (this.now().getTime() <= deadline) {
      polls += 1;
      const task = await this.fetchTask(taskId);
      const status = readString(task, STATUS_KEYS)?.toLowerCase() ?? '';
      const imageUrl = findImageUrl(task);

      if (imageUrl !== null && (status === '' || SUCCESS_STATUSES.has(status))) {
        this.logger.log(
          JSON.stringify({
            event: 'midjourney.completed',
            taskId,
            polls,
          }),
        );

        return { taskId, imageUrl, status: status === '' ? 'completed' : status };
      }

      if (FAILED_STATUSES.has(status)) {
        const reason =
          readString(task, [
            'error',
            'errorMessage',
            'error_message',
            'message',
            'failReason',
          ]) ?? 'провайдер вернул статус ошибки';

        throw providerUnavailableError(
          `Midjourney: задача ${taskId} завершилась ошибкой: ${reason}`,
        );
      }

      if (status !== '' && !PENDING_STATUSES.has(status) && imageUrl === null) {
        // Неизвестный статус без картинки — не зацикливаемся до дедлайна.
        throw providerUnavailableError(
          `Midjourney: неизвестный статус задачи ${taskId}: ${status}`,
        );
      }

      await this.sleep(this.config.pollIntervalMs);
    }

    throw providerUnavailableError(
      `Midjourney: задача ${taskId} не завершилась за ${this.config.timeoutMs} мс (поллингов: ${polls})`,
    );
  }

  /**
   * TTAPI `/midjourney/v1/imagine`: создать задачу.
   *
   * Аудит API (ноябрь 2026): официального Midjourney API нет, используется
   * только TTAPI; заголовок авторизации — `TT-API-KEY`, режим `fast`.
   * GoAPI/UseAPI и Discord-токены не используются.
   */
  private async submit(baseUrl: string, prompt: string): Promise<string> {
    const payload = await providerRequest({
      provider: 'midjourney',
      method: 'POST',
      url: `${baseUrl}${this.config.imaginePath}`,
      headers: {
        'TT-API-KEY': this.config.apiKey ?? '',
        'content-type': 'application/json',
      },
      data: { prompt, mode: 'fast' },
      schema: midjourneySubmitSchema,
      ...(this.retry === undefined ? {} : { retry: this.retry }),
      logger: this.logger,
    });
    const taskId = readString(payload, TASK_ID_KEYS);

    if (taskId === null) {
      throw providerUnavailableError(
        'Midjourney (TTAPI): ответ на /midjourney/v1/imagine не содержит jobId',
      );
    }

    return taskId;
  }

  /**
   * TTAPI `/midjourney/v1/fetch?jobId=...`: статус задачи.
   *
   * Поллинг до `completed`; URL изображения берётся из ответа (TTAPI
   * возвращает его в `imageUrl`/`data.imageUrl` или массиве изображений).
   */
  private async fetchTask(
    taskId: string,
  ): Promise<Record<string, unknown>> {
    return providerRequest({
      provider: 'midjourney',
      method: 'GET',
      url: `${this.config.baseUrl ?? ''}${this.config.taskPath.replace(
        '{id}',
        encodeURIComponent(taskId),
      )}`,
      headers: {
        'TT-API-KEY': this.config.apiKey ?? '',
      },
      schema: midjourneyTaskSchema,
      ...(this.retry === undefined ? {} : { retry: this.retry }),
      logger: this.logger,
    });
  }

  private assertConfigured(): void {
    if (!this.config.isConfigured()) {
      throw providerNotConfiguredError(
        'Midjourney (TTAPI) не настроен: задайте MIDJOURNEY_API_KEY',
      );
    }
  }
}

/** Строковое поле верхнего уровня или во вложенном `result`/`data`/`output`. */
function readString(
  record: Record<string, unknown>,
  keys: readonly string[],
): string | null {
  for (const key of keys) {
    const value = record[key];

    if (typeof value === 'string' && value.trim() !== '') {
      return value;
    }
  }

  for (const nestedKey of ['result', 'data', 'output', 'task']) {
    const nested = record[nestedKey];

    if (nested !== null && typeof nested === 'object' && !Array.isArray(nested)) {
      const found = readString(nested as Record<string, unknown>, keys);

      if (found !== null) {
        return found;
      }
    }
  }

  return null;
}

/**
 * URL картинки из ответа TTAPI.
 *
 * TTAPI возвращает его по-разному в зависимости от версии: `imageUrl`,
 * `data.imageUrl`, `images[]`/`output[]`. Обход ограничен глубиной, чтобы не
 * сканировать произвольный большой JSON.
 */
function findImageUrl(
  payload: Record<string, unknown>,
  depth = 0,
): string | null {
  const direct = readString(payload, IMAGE_URL_KEYS);

  if (direct !== null) {
    return direct;
  }

  if (depth > 3) {
    return null;
  }

  for (const key of ['output', 'images', 'imageUrls', 'results']) {
    const value = payload[key];

    if (!Array.isArray(value)) {
      continue;
    }

    for (const item of value) {
      if (typeof item === 'string' && item.startsWith('http')) {
        return item;
      }

      if (item !== null && typeof item === 'object') {
        const found = readString(
          item as Record<string, unknown>,
          IMAGE_URL_KEYS,
        );

        if (found !== null) {
          return found;
        }
      }
    }
  }

  for (const nestedKey of ['data', 'result', 'task', 'output']) {
    const nested = payload[nestedKey];

    if (nested !== null && typeof nested === 'object' && !Array.isArray(nested)) {
      const found = findImageUrl(
        nested as Record<string, unknown>,
        depth + 1,
      );

      if (found !== null) {
        return found;
      }
    }
  }

  return null;
}

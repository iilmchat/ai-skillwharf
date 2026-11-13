import { Injectable, Logger, Optional } from '@nestjs/common';
import axios, { type AxiosInstance } from 'axios';

/**
 * Размерность вектора в `MemoryChunk.embedding` (schema.prisma).
 * Модель эмбеддингов может отдать вектор другой длины — нормализуем его
 * до этой размерности (лишнее отбрасываем, недостающее добиваем нулями).
 */
export const MEMORY_EMBEDDING_DIMENSIONS = 1536;

/** Таймаут запроса к API эмбеддингов. */
export const EMBEDDINGS_TIMEOUT_MS = 30_000;

export interface EmbeddingsOptions {
  baseUrl?: string;
  apiKey?: string;
  model?: string;
  dimensions?: number;
  http?: AxiosInstance;
}

interface EmbeddingsResponse {
  data?: { embedding?: unknown }[];
}

/**
 * Клиент OpenAI-совместимого API эмбеддингов (`POST {baseUrl}/embeddings`).
 *
 * Работает с OpenAI (`text-embedding-3-small`), LM Studio и Ollama: достаточно
 * задать `EMBEDDINGS_BASE_URL` и `EMBEDDINGS_MODEL`. Если конфигурации нет,
 * `embed()` возвращает `null`, и долговременная память просто не используется.
 */
@Injectable()
export class EmbeddingsService {
  private readonly logger = new Logger(EmbeddingsService.name);
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly model: string;
  private readonly dimensions: number;
  private readonly http: AxiosInstance;

  constructor(@Optional() options: EmbeddingsOptions = {}) {
    this.baseUrl = (
      options.baseUrl ??
      process.env.EMBEDDINGS_BASE_URL ??
      process.env.LLM_BASE_URL ??
      ''
    ).trim();
    this.apiKey =
      options.apiKey ??
      process.env.EMBEDDINGS_API_KEY ??
      process.env.LLM_API_KEY ??
      '';
    this.model = (options.model ?? process.env.EMBEDDINGS_MODEL ?? '').trim();
    this.dimensions = options.dimensions ?? MEMORY_EMBEDDING_DIMENSIONS;
    this.http =
      options.http ?? axios.create({ timeout: EMBEDDINGS_TIMEOUT_MS });
  }

  /** Заданы ли URL и модель эмбеддингов. */
  isConfigured(): boolean {
    return this.baseUrl !== '' && this.model !== '';
  }

  /**
   * Считает эмбеддинг текста. Ошибка провайдера или отсутствие конфигурации
   * не ломают чат: возвращаем `null`, вызывающий код пропускает память.
   */
  async embed(text: string): Promise<number[] | null> {
    const input = text.trim();

    if (input === '' || !this.isConfigured()) {
      return null;
    }

    const url = `${this.baseUrl.replace(/\/+$/, '')}/embeddings`;

    try {
      const { data } = await this.http.post<EmbeddingsResponse>(
        url,
        { model: this.model, input },
        {
          headers:
            this.apiKey === ''
              ? {}
              : { Authorization: `Bearer ${this.apiKey}` },
        },
      );
      const embedding = data.data?.[0]?.embedding;

      if (!Array.isArray(embedding)) {
        this.logger.warn('API эмбеддингов вернул пустой вектор');

        return null;
      }

      return normalizeEmbedding(embedding, this.dimensions);
    } catch (error) {
      this.logger.warn(
        `Не удалось получить эмбеддинг: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );

      return null;
    }
  }
}

/**
 * Приводит вектор к размерности колонки `vector(N)`: лишние значения
 * отбрасываются, недостающие заполняются нулями. Для косинусного расстояния
 * добавление нулей не меняет порядок соседей, поэтому это безопасно.
 */
export function normalizeEmbedding(
  vector: readonly unknown[],
  dimensions = MEMORY_EMBEDDING_DIMENSIONS,
): number[] {
  const normalized = Array.from({ length: dimensions }, () => 0);
  const length = Math.min(dimensions, vector.length);

  for (let index = 0; index < length; index += 1) {
    const value = Number(vector[index]);

    normalized[index] = Number.isFinite(value) ? value : 0;
  }

  return normalized;
}

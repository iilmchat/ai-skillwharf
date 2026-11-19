import { Injectable, Logger, Optional } from '@nestjs/common';
import { Redis } from 'ioredis';
import { z } from 'zod';
import { MetricsService } from '../metrics/metrics.service.js';
import {
  EmbeddingsService,
  normalizeEmbedding,
} from '../memory/embeddings.service.js';

/**
 * Семантический кеш ответов LLM (Sprint 30 / CACHE-30.2).
 *
 * Изоляция строго по (userId, promptVersionId, model): данные разных
 * клиентов никогда не смешиваются. Запросы с инструментами не кешируются,
 * чтобы не отдать устаревшие остатки/сделки. При попадании ответ возвращается
 * без вызова внешней LLM и, следовательно, без списания в Ledger.
 */

export const DEFAULT_SEMANTIC_CACHE_TTL_SECONDS = 600;
export const DEFAULT_SEMANTIC_CACHE_THRESHOLD = 0.95;
export const SEMANTIC_CACHE_MAX_ENTRIES = 50;

export const semanticCacheConfigSchema = z.object({
  ttlSeconds: z.number().int().positive(),
  threshold: z.number().min(0).max(1),
});

const semanticCacheEntrySchema = z.object({
  id: z.string().min(1),
  query: z.string(),
  reply: z.string(),
  embedding: z.array(z.number()),
  createdAt: z.string(),
});

const semanticCacheListSchema = z.array(semanticCacheEntrySchema);

export type SemanticCacheEntry = z.infer<typeof semanticCacheEntrySchema>;

export interface SemanticCacheQuery {
  readonly userId: string;
  readonly promptVersionId: string;
  readonly model: string;
  readonly query: string;
  /** Любые tool_calls или включённые инструменты запрещают кеш. */
  readonly toolCalls?: readonly string[];
  readonly toolsEnabled?: boolean;
}

export type SemanticCacheResult =
  | { readonly hit: true; readonly reply: string; readonly score: number }
  | { readonly hit: false; readonly score?: number };

function readConfig(env: NodeJS.ProcessEnv = process.env) {
  const ttl = Number.parseInt(env.SEMANTIC_CACHE_TTL_SECONDS ?? '', 10);
  const threshold = Number.parseFloat(env.SEMANTIC_CACHE_THRESHOLD ?? '');

  return semanticCacheConfigSchema.parse({
    ttlSeconds:
      Number.isInteger(ttl) && ttl > 0 ? ttl : DEFAULT_SEMANTIC_CACHE_TTL_SECONDS,
    threshold:
      Number.isFinite(threshold) && threshold >= 0 && threshold <= 1
        ? threshold
        : DEFAULT_SEMANTIC_CACHE_THRESHOLD,
  });
}

/** Косинусное сходство; 0 для нулевых/невалидных векторов. */
export function cosineSimilarity(
  left: readonly number[],
  right: readonly number[],
): number {
  const length = Math.min(left.length, right.length);

  if (length === 0) {
    return 0;
  }

  let dot = 0;
  let normLeft = 0;
  let normRight = 0;

  for (let index = 0; index < length; index += 1) {
    const a = left[index] ?? 0;
    const b = right[index] ?? 0;
    dot += a * b;
    normLeft += a * a;
    normRight += b * b;
  }

  if (normLeft === 0 || normRight === 0) {
    return 0;
  }

  return dot / (Math.sqrt(normLeft) * Math.sqrt(normRight));
}

@Injectable()
export class SemanticCacheService {
  private readonly logger = new Logger(SemanticCacheService.name);
  private readonly config: ReturnType<typeof readConfig>;
  private readonly redis: Redis | null;
  private readonly memory = new Map<string, SemanticCacheEntry[]>();
  private redisDisabled = false;

  constructor(
    private readonly embeddings: EmbeddingsService,
    private readonly metrics: MetricsService,
    @Optional() redisUrl?: string,
    @Optional() env: NodeJS.ProcessEnv = process.env,
  ) {
    this.config = readConfig(env);
    const url = (redisUrl ?? process.env.REDIS_URL ?? '').trim();

    if (url === '') {
      this.redis = null;
      return;
    }

    this.redis = new Redis(url, {
      lazyConnect: true,
      connectTimeout: 1_500,
      maxRetriesPerRequest: 1,
      retryStrategy: () => null,
    });
    this.redis.on('error', (error: Error) => {
      if (!this.redisDisabled) {
        this.logger.warn(`Redis_semantic_cache: ${error.message}`);
      }
      this.redisDisabled = true;
    });
  }

  /** Порог сходства, с которым работает кеш (для диагностики/тестов). */
  get threshold(): number {
    return this.config.threshold;
  }

  /** Ключ изоляции: userId и версия промпта и модель — обязательные части. */
  static scopeKey(query: SemanticCacheQuery): string {
    const parsed = z
      .object({
        userId: z.string().min(1),
        promptVersionId: z.string().min(1),
        model: z.string().min(1),
      })
      .parse({
        userId: query.userId,
        promptVersionId: query.promptVersionId,
        model: query.model,
      });

    return [
      'semantic-cache',
      parsed.userId,
      parsed.promptVersionId,
      parsed.model,
    ].join(':');
  }

  /** Инструменты/ERP-данные не кешируются во избежание устаревших ответов. */
  isCacheable(query: SemanticCacheQuery): boolean {
    return (
      !query.toolsEnabled &&
      (query.toolCalls === undefined || query.toolCalls.length === 0) &&
      query.query.trim() !== ''
    );
  }

  async lookup(query: SemanticCacheQuery): Promise<SemanticCacheResult> {
    if (!this.isCacheable(query)) {
      this.metrics.countSemanticCacheResult(query.model, false);
      return { hit: false };
    }

    const embedding = await this.embeddings.embed(query.query);

    if (embedding === null) {
      this.metrics.countSemanticCacheResult(query.model, false);
      return { hit: false };
    }

    const entries = await this.readScope(SemanticCacheService.scopeKey(query));
    let best: { entry: SemanticCacheEntry; score: number } | null = null;

    for (const entry of entries) {
      // Дополнительная проверка: даже при повреждённом ключе чужие данные не отдаём.
      if (entry.id.split(':')[0] !== query.userId) {
        continue;
      }

      const score = cosineSimilarity(
        normalizeEmbedding(embedding),
        entry.embedding,
      );

      if (score >= this.config.threshold && (best === null || score > best.score)) {
        best = { entry, score };
      }
    }

    this.metrics.countSemanticCacheResult(query.model, best !== null);

    return best === null
      ? { hit: false }
      : { hit: true, reply: best.entry.reply, score: best.score };
  }

  async store(query: SemanticCacheQuery, reply: string): Promise<void> {
    if (!this.isCacheable(query) || reply.trim() === '') {
      return;
    }

    const embedding = await this.embeddings.embed(query.query);

    if (embedding === null) {
      return;
    }

    const scope = SemanticCacheService.scopeKey(query);
    const entries = await this.readScope(scope);
    const entry: SemanticCacheEntry = semanticCacheEntrySchema.parse({
      // Префикс userId позволяет дополнительно проверить владельца записи.
      id: `${query.userId}:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`,
      query: query.query,
      reply,
      embedding: normalizeEmbedding(embedding),
      createdAt: new Date().toISOString(),
    });

    const next = [...entries, entry].slice(-SEMANTIC_CACHE_MAX_ENTRIES);
    this.memory.set(scope, next);

    try {
      if (this.redis !== null && !this.redisDisabled) {
        await this.redis.set(
          scope,
          JSON.stringify(next),
          'EX',
          this.config.ttlSeconds,
        );
      }
    } catch (error) {
      this.redisDisabled = true;
      this.logger.warn(`Не удалось записать semantic cache в Redis: ${String(error)}`);
    }
  }

  private async readScope(scope: string): Promise<SemanticCacheEntry[]> {
    if (this.redis !== null && !this.redisDisabled) {
      try {
        const raw = await this.redis.get(scope);

        if (raw !== null) {
          const parsed = semanticCacheListSchema.safeParse(
            JSON.parse(raw) as unknown,
          );

          if (parsed.success) {
            this.memory.set(scope, parsed.data);
            return parsed.data;
          }
        }
      } catch (error) {
        this.redisDisabled = true;
        this.logger.warn(`Не удалось прочитать semantic cache из Redis: ${String(error)}`);
      }
    }

    return this.memory.get(scope) ?? [];
  }
}

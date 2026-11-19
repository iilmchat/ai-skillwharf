import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service.js';
import { z } from 'zod';

/**
 * Абстракция хранилища векторов (INFRA-28.3 / ADR 0002).
 *
 * `pgvector` — дефолт: эмбеддинг лежит рядом с MemoryChunk в PostgreSQL.
 * `QdrantVectorStore` — опция при `VECTOR_STORE_PROVIDER=qdrant`: стандартный
 * HTTP API Qdrant через `fetch`, без новых зависимостей.
 */

export const VECTOR_MEMORY_STORE = 'VECTOR_MEMORY_STORE';

export interface VectorMemoryRecord {
  readonly id: string;
  readonly userId: string;
  readonly content: string;
  readonly embedding: readonly number[];
  readonly source?: string | null;
  readonly kind?: string;
}

/** Литерал pgvector для raw-запросов. */
function toVectorLiteral(vector: readonly number[]): string {
  return `[${vector.join(',')}]`;
}

export interface IVectorMemoryStore {
  readonly provider: 'pgvector' | 'qdrant';
  upsert(record: VectorMemoryRecord): Promise<void>;
  search(
    userId: string,
    embedding: readonly number[],
    limit: number,
  ): Promise<readonly string[]>;
  deleteAll(userId: string): Promise<number>;
}

const qdrantConfigSchema = z.object({
  url: z.url().refine(
    (value) => value.startsWith('http://') || value.startsWith('https://'),
    { message: 'QDRANT_URL должен использовать http/https' },
  ),
  collection: z.string().min(1).max(128),
  dimensions: z.number().int().positive().max(4096),
  timeoutMs: z.number().int().positive(),
});

export interface QdrantVectorStoreOptions {
  readonly url: string;
  readonly collection?: string;
  readonly dimensions?: number;
  readonly timeoutMs?: number;
  /** DI точки сетевого вызова; в тестах подставляется mock. */
  readonly fetch?: typeof fetch;
}

const qdrantSearchResponseSchema = z.object({
  result: z.object({
    points: z.array(
      z.object({
        payload: z
          .object({ content: z.string() })
          .passthrough()
          .optional(),
      }),
    ),
  }),
});

/** Хранилище pgvector: исходная реализация из MemoryService. */
@Injectable()
export class PgVectorMemoryStore implements IVectorMemoryStore {
  readonly provider = 'pgvector' as const;

  constructor(private readonly prisma: PrismaService) {}

  async upsert(record: VectorMemoryRecord): Promise<void> {
    await this.prisma.$executeRaw`
      UPDATE "MemoryChunk"
      SET "embedding" = ${toVectorLiteral(record.embedding)}::vector
      WHERE "id" = ${record.id}
    `;
  }

  async search(
    userId: string,
    embedding: readonly number[],
    limit: number,
  ): Promise<readonly string[]> {
    const rows = await this.prisma.$queryRaw<{ content: string }[]>`
      SELECT "content"
      FROM "MemoryChunk"
      WHERE "userId" = ${userId} AND "embedding" IS NOT NULL
      ORDER BY "embedding" <=> ${toVectorLiteral(embedding)}::vector
      LIMIT ${limit}
    `;

    return rows.map((row) => row.content);
  }

  async deleteAll(userId: string): Promise<number> {
    const { count } = await this.prisma.memoryChunk.deleteMany({
      where: { userId },
    });

    return count;
  }
}

/**
 * Адаптер Qdrant: каждая запись — point с uuid из MemoryChunk.id и payload
 * `{ userId, content, source, kind }`. Поиск фильтруется по userId на уровне
 * Qdrant, поэтому память разных пользователей не смешивается.
 */
@Injectable()
export class QdrantVectorStore implements IVectorMemoryStore {
  readonly provider = 'qdrant' as const;
  private readonly config: z.infer<typeof qdrantConfigSchema>;
  private readonly fetchFn: typeof fetch;
  private readonly logger = new Logger(QdrantVectorStore.name);
  private collectionReady: Promise<void> | null = null;

  constructor(options: QdrantVectorStoreOptions) {
    this.config = qdrantConfigSchema.parse({
      url: options.url,
      collection: options.collection ?? 'skillwharf_memory',
      dimensions: options.dimensions ?? 1536,
      timeoutMs: options.timeoutMs ?? 10_000,
    });
    this.fetchFn = options.fetch ?? fetch;
  }

  async upsert(record: VectorMemoryRecord): Promise<void> {
    await this.ensureCollection();
    await this.request(
      'PUT',
      `/collections/${this.config.collection}/points?wait=true`,
      {
        points: [
          {
            id: record.id,
            vector: [...record.embedding],
            payload: {
              userId: record.userId,
              content: record.content,
              source: record.source ?? null,
              kind: record.kind ?? 'fact',
            },
          },
        ],
      },
    );
  }

  async search(
    userId: string,
    embedding: readonly number[],
    limit: number,
  ): Promise<readonly string[]> {
    await this.ensureCollection();
    const raw = await this.request(
      'POST',
      `/collections/${this.config.collection}/points/search`,
      {
        vector: [...embedding],
        filter: {
          must: [{ key: 'userId', match: { value: userId } }],
        },
        limit: Math.max(1, Math.min(limit, 10)),
        with_payload: true,
      },
    );
    const parsed = qdrantSearchResponseSchema.safeParse(raw);

    if (!parsed.success) {
      throw new Error('Qdrant: некорректный ответ поиска');
    }

    return parsed.data.result.points
      .map((point) => point.payload?.content)
      .filter((content): content is string => content !== undefined);
  }

  async deleteAll(userId: string): Promise<number> {
    await this.request(
      'POST',
      `/collections/${this.config.collection}/points/delete?wait=true`,
      {
        filter: { must: [{ key: 'userId', match: { value: userId } }] },
      },
    );

    return 0; // Qdrant не возвращает число удалённых точек.
  }

  /** Создаёт коллекцию один раз; 409 означает, что она уже есть. */
  private ensureCollection(): Promise<void> {
    if (this.collectionReady === null) {
      this.collectionReady = this.request(
        'PUT',
        `/collections/${this.config.collection}`,
        {
          vectors: {
            size: this.config.dimensions,
            distance: 'Cosine',
          },
        },
      )
        .then(() => undefined)
        .catch((error: unknown) => {
          if (error instanceof QdrantConflictError) {
            return;
          }
          this.collectionReady = null;
          throw error;
        });
    }

    return this.collectionReady;
  }

  private async request(
    method: 'PUT' | 'POST',
    path: string,
    body: unknown,
  ): Promise<unknown> {
    const url = new URL(path, `${this.config.url.replace(/\/$/, '')}/`);
    let response: Response;

    try {
      response = await this.fetchFn(url.toString(), {
        method,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(this.config.timeoutMs),
      });
    } catch (error) {
      this.logger.warn(`Qdrant недоступен: ${String(error)}`);
      throw error;
    }

    if (response.status === 409) {
      throw new QdrantConflictError();
    }

    if (!response.ok) {
      throw new Error(`Qdrant HTTP ${response.status} для ${path}`);
    }

    const raw: unknown = await response.json().catch(() => null);

    return raw;
  }
}

class QdrantConflictError extends Error {
  constructor() {
    super('Qdrant: конфликт (уже существует)');
    this.name = 'QdrantConflictError';
  }
}

/** Фабрика провайдера по env (DI в MemoryModule). */
export function createVectorMemoryStore(
  prisma: PrismaService,
  env: NodeJS.ProcessEnv = process.env,
): IVectorMemoryStore {
  const provider = z
    .enum(['pgvector', 'qdrant'])
    .parse((env.VECTOR_STORE_PROVIDER ?? 'pgvector').trim().toLowerCase() || 'pgvector');

  if (provider === 'pgvector') {
    return new PgVectorMemoryStore(prisma);
  }

  const url = (env.QDRANT_URL ?? '').trim();

  if (url === '') {
    throw new Error(
      'VECTOR_STORE_PROVIDER=qdrant требует QDRANT_URL (например, http://qdrant:6333)',
    );
  }

  const dimensions = Number.parseInt(env.MEMORY_EMBEDDING_DIMENSIONS ?? '1536', 10);

  return new QdrantVectorStore({
    url,
    ...(env.QDRANT_COLLECTION?.trim()
      ? { collection: env.QDRANT_COLLECTION.trim() }
      : {}),
    ...(Number.isInteger(dimensions) && dimensions > 0
      ? { dimensions }
      : {}),
  });
}

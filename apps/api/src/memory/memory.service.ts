import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service.js';
import { EmbeddingsService } from './embeddings.service.js';

/** Сколько похожих фрагментов памяти добавляем в промпт. */
export const MEMORY_TOP_K = 3;

/** Максимальная длина одного фрагмента памяти (защита от раздувания промпта). */
export const MEMORY_CHUNK_MAX_CHARS = 2_000;

/**
 * Долговременная память агента поверх pgvector.
 *
 * Новые сообщения диалога сохраняются как `MemoryChunk` с эмбеддингом, а
 * перед вызовом LLM для последнего сообщения пользователя находятся top-K
 * ближайших по косинусу фрагментов и подмешиваются в системный промпт.
 */
@Injectable()
export class MemoryService {
  private readonly logger = new Logger(MemoryService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly embeddings: EmbeddingsService,
  ) {}

  /**
   * Сохраняет сообщение как фрагмент памяти. Без настроенного API
   * эмбеддингов или при ошибке БД просто пропускает запись: память не
   * должна ломать основной диалог.
   */
  async remember(userId: string, content: string): Promise<void> {
    const trimmed = content.trim();

    if (trimmed === '' || !this.embeddings.isConfigured()) {
      return;
    }

    const embedding = await this.embeddings.embed(trimmed);

    if (embedding === null) {
      return;
    }

    try {
      const chunk = await this.prisma.memoryChunk.create({
        data: {
          userId,
          content: trimmed.slice(0, MEMORY_CHUNK_MAX_CHARS),
        },
        select: { id: true },
      });

      // `embedding` — Unsupported в Prisma, поэтому пишем его raw-запросом.
      await this.prisma.$executeRaw`
        UPDATE "MemoryChunk"
        SET "embedding" = ${toVectorLiteral(embedding)}::vector
        WHERE "id" = ${chunk.id}
      `;
    } catch (error) {
      this.logger.warn(
        `Не удалось сохранить фрагмент памяти: ${describe(error)}`,
      );
    }
  }

  /**
   * Top-K ближайших по косинусу фрагментов памяти пользователя.
   * Возвращает тексты в порядке убывания похожести.
   */
  async search(
    userId: string,
    query: string,
    limit = MEMORY_TOP_K,
  ): Promise<string[]> {
    const embedding = await this.embeddings.embed(query);

    if (embedding === null) {
      return [];
    }

    const safeLimit = Math.max(1, Math.min(limit, 10));

    try {
      const rows = await this.prisma.$queryRaw<{ content: string }[]>`
        SELECT "content"
        FROM "MemoryChunk"
        WHERE "userId" = ${userId} AND "embedding" IS NOT NULL
        ORDER BY "embedding" <=> ${toVectorLiteral(embedding)}::vector
        LIMIT ${safeLimit}
      `;

      return rows.map((row) => row.content);
    } catch (error) {
      this.logger.warn(`Не удалось найти фрагменты памяти: ${describe(error)}`);

      return [];
    }
  }

  /**
   * Готовый блок «Долговременная память» для системного промпта.
   * Пустая строка означает, что памяти по запросу нет.
   */
  async buildContext(userId: string, query: string): Promise<string> {
    const chunks = await this.search(userId, query);

    return formatMemoryChunks(chunks);
  }
}

/**
 * Собирает блок памяти: убирает пустые и повторяющиеся фрагменты,
 * нумерует строки. Пустой массив превращается в пустую строку.
 */
export function formatMemoryChunks(chunks: readonly string[]): string {
  const unique = [...new Set(chunks.map((chunk) => chunk.trim()))].filter(
    (chunk) => chunk !== '',
  );

  return unique.map((chunk, index) => `${index + 1}. ${chunk}`).join('\n');
}

/** Литерал pgvector: `[0.1,0.2,...]` (значения передаются параметром). */
export function toVectorLiteral(vector: readonly number[]): string {
  return `[${vector.join(',')}]`;
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

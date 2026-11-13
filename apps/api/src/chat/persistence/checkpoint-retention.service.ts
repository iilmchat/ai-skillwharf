import {
  Injectable,
  Logger,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service.js';
import { readPositiveEnvNumber } from './persistence-env.js';

/** Срок хранения checkpoint'ов завершённых тредов по умолчанию: 30 дней. */
export const DEFAULT_CHECKPOINT_RETENTION_DAYS = 30;

/** Интервал очистки по умолчанию: раз в 6 часов. */
export const DEFAULT_RETENTION_CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;

/** Сколько завершённых диалогов просматриваем за один тик. */
export const STALE_CONVERSATIONS_BATCH_SIZE = 200;

/** Сколько orphan-тредов просматриваем за один тик. */
export const ORPHAN_THREADS_BATCH_SIZE = 200;

const MS_PER_DAY = 24 * 60 * 60 * 1000;

const logger = new Logger('CheckpointRetentionService');

/** Зависимости тика — узкий срез Prisma, чтобы тесты подставляли двойники. */
export interface CheckpointRetentionDeps {
  prisma: Pick<
    PrismaService,
    'conversation' | 'pendingApproval' | 'graphCheckpoint' | 'graphCheckpointWrite'
  >;
}

/** Итог одного тика очистки. */
export interface CheckpointRetentionResult {
  threads: number;
  checkpoints: number;
  writes: number;
}

/** Срок хранения `CHECKPOINT_RETENTION_DAYS` (дни). */
export function resolveCheckpointRetentionDays(
  env: NodeJS.ProcessEnv = process.env,
): number {
  return readPositiveEnvNumber(
    env.CHECKPOINT_RETENTION_DAYS,
    DEFAULT_CHECKPOINT_RETENTION_DAYS,
  );
}

/** Интервал очистки `CHECKPOINT_RETENTION_CHECK_INTERVAL_MS` (мс). */
export function resolveRetentionCheckIntervalMs(
  env: NodeJS.ProcessEnv = process.env,
): number {
  return readPositiveEnvNumber(
    env.CHECKPOINT_RETENTION_CHECK_INTERVAL_MS,
    DEFAULT_RETENTION_CHECK_INTERVAL_MS,
  );
}

/**
 * Удаляет checkpoint'ы тредов, которые больше не нужны (KI-034).
 *
 * Кандидаты:
 * 1) завершённые диалоги — `Conversation.updatedAt < now - retention days` и
 *    без активного `PendingApproval` (status `pending`): если пользователь ещё
 *    не решил, состояние графа нужно для resume;
 * 2) orphan-треды — `threadId` из `GraphCheckpoint`, для которых нет
 *    `Conversation` (диалог удалён, а состояние осталось).
 *
 * Активные диалоги (updatedAt >= cutoff) и треды с pending approval не
 * трогаются. Удаляются сначала `GraphCheckpointWrite`, затем
 * `GraphCheckpoint`; итог пишется JSON-логом `checkpoint.retention_cleaned`.
 */
export async function cleanupStaleCheckpoints(
  deps: CheckpointRetentionDeps,
  now: Date,
): Promise<CheckpointRetentionResult> {
  const retentionDays = resolveCheckpointRetentionDays();
  const cutoff = new Date(now.getTime() - retentionDays * MS_PER_DAY);
  const threadIds = new Set<string>();

  // 1. Завершённые диалоги без активного ожидания одобрения.
  const staleConversations = await deps.prisma.conversation.findMany({
    where: { updatedAt: { lt: cutoff } },
    orderBy: { updatedAt: 'asc' },
    take: STALE_CONVERSATIONS_BATCH_SIZE,
    select: { id: true },
  });
  const staleIds = staleConversations.map((row) => row.id);

  if (staleIds.length > 0) {
    const pending = await deps.prisma.pendingApproval.findMany({
      where: { conversationId: { in: staleIds }, status: 'pending' },
      select: { conversationId: true },
    });
    const busyConversationIds = new Set(
      pending.map((row) => row.conversationId),
    );

    for (const conversationId of staleIds) {
      if (!busyConversationIds.has(conversationId)) {
        threadIds.add(conversationId);
      }
    }
  }

  // 2. Orphan-треды: checkpoint'ы есть, диалога уже нет.
  const checkpointThreads = await deps.prisma.graphCheckpoint.findMany({
    distinct: ['threadId'],
    select: { threadId: true },
    take: ORPHAN_THREADS_BATCH_SIZE,
  });
  const orphanCandidates = checkpointThreads
    .map((row) => row.threadId)
    .filter((threadId) => !threadIds.has(threadId));

  if (orphanCandidates.length > 0) {
    const existingConversations = await deps.prisma.conversation.findMany({
      where: { id: { in: orphanCandidates } },
      select: { id: true },
    });
    const existingIds = new Set(
      existingConversations.map((row) => row.id),
    );

    for (const threadId of orphanCandidates) {
      if (!existingIds.has(threadId)) {
        threadIds.add(threadId);
      }
    }
  }

  if (threadIds.size === 0) {
    return { threads: 0, checkpoints: 0, writes: 0 };
  }

  const ids = [...threadIds];
  const [writes, checkpoints] = await Promise.all([
    deps.prisma.graphCheckpointWrite.deleteMany({
      where: { threadId: { in: ids } },
    }),
    deps.prisma.graphCheckpoint.deleteMany({
      where: { threadId: { in: ids } },
    }),
  ]);
  const result: CheckpointRetentionResult = {
    threads: ids.length,
    checkpoints: checkpoints.count,
    writes: writes.count,
  };

  logger.log(
    JSON.stringify({
      event: 'checkpoint.retention_cleaned',
      threads: result.threads,
      checkpoints: result.checkpoints,
      writes: result.writes,
    }),
  );

  return result;
}

/**
 * Фоновый job retention checkpoint'ов.
 *
 * Первый тик — сразу при старте, далее раз в
 * `CHECKPOINT_RETENTION_CHECK_INTERVAL_MS` (по умолчанию 6 часов). Таймер
 * `unref`-нут, ошибки тика не роняют API.
 */
@Injectable()
export class CheckpointRetentionService
  implements OnModuleInit, OnModuleDestroy
{
  private readonly logger = new Logger(CheckpointRetentionService.name);
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly prisma: PrismaService) {}

  onModuleInit(): void {
    if ((process.env.REDIS_URL?.trim() ?? '') !== '') {
      this.logger.log(
        'Retention: тик очистки выполняет BullMQ (REDIS_URL задан)',
      );

      return;
    }

    const intervalMs = resolveRetentionCheckIntervalMs();

    void this.tick();
    this.timer = setInterval(() => {
      void this.tick();
    }, intervalMs);
    this.timer.unref?.();
    this.logger.log(
      `Retention: job очистки checkpoint'ов запущен (интервал ${intervalMs} мс)`,
    );
  }

  onModuleDestroy(): void {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** Один тик; ошибка БД логируется и не пробрасывается наружу. */
  async tick(now: Date = new Date()): Promise<CheckpointRetentionResult> {
    try {
      return await cleanupStaleCheckpoints({ prisma: this.prisma }, now);
    } catch (error) {
      this.logger.error(
        `Retention: не удалось очистить checkpoint'ы: ${describe(error)}`,
      );

      return { threads: 0, checkpoints: 0, writes: 0 };
    }
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

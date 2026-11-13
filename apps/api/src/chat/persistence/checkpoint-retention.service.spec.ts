import { Logger } from '@nestjs/common';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PrismaService } from '../../prisma/prisma.service.js';
import { createFakeCheckpointPrisma } from '../../../test/checkpointer/fake-checkpoint-store.js';
import type { FakePendingApprovalRecord } from '../../../test/checkpointer/fake-checkpoint-store.js';
import {
  CheckpointRetentionService,
  DEFAULT_CHECKPOINT_RETENTION_DAYS,
  DEFAULT_RETENTION_CHECK_INTERVAL_MS,
  cleanupStaleCheckpoints,
  resolveCheckpointRetentionDays,
  resolveRetentionCheckIntervalMs,
  type CheckpointRetentionDeps,
} from './checkpoint-retention.service.js';

const USER_ID = '22222222-2222-2222-2222-222222222222';
const CONVERSATION_ID = 'conversation-old';
const ACTIVE_CONVERSATION_ID = 'conversation-active';
const PENDING_CONVERSATION_ID = 'conversation-pending';
const ORPHAN_THREAD_ID = 'thread-orphan';

const NOW = new Date('2026-11-13T12:00:00.000Z');
const DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_CUTOFF = new Date(
  NOW.getTime() - DEFAULT_CHECKPOINT_RETENTION_DAYS * DAY_MS,
);

/** Глушит JSON-логи сервиса в тестах, где они не проверяются. */
function silenceServiceLogs(): void {
  vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
}

afterEach(() => {
  vi.restoreAllMocks();
});

const store = () => createFakeCheckpointPrisma();

function createSetup() {
  const fake = store();
  const conversationFindMany = vi.fn();
  const prisma = {
    ...fake.prisma,
    conversation: { findMany: conversationFindMany },
  } as unknown as CheckpointRetentionDeps['prisma'];

  return {
    deps: { prisma } satisfies CheckpointRetentionDeps,
    fake,
    conversationFindMany,
  };
}

async function seedThread(
  fake: ReturnType<typeof store>,
  threadId: string,
): Promise<void> {
  await fake.prisma.graphCheckpoint.create({
    data: {
      threadId,
      checkpointNs: '',
      checkpointId: `cp-${threadId}`,
      payload: new Uint8Array([1]),
      metadata: new Uint8Array([2]),
    },
  });
  await fake.prisma.graphCheckpointWrite.create({
    data: {
      threadId,
      checkpointNs: '',
      checkpointId: `cp-${threadId}`,
      taskId: 'task-1',
      idx: 0,
      channel: 'messages',
      value: new Uint8Array([3]),
    },
  });
}

describe('resolveCheckpointRetentionDays', () => {
  it('по умолчанию — 30 дней', () => {
    expect(resolveCheckpointRetentionDays({})).toBe(
      DEFAULT_CHECKPOINT_RETENTION_DAYS,
    );
  });

  it('читает CHECKPOINT_RETENTION_DAYS и игнорирует мусор', () => {
    expect(
      resolveCheckpointRetentionDays({ CHECKPOINT_RETENTION_DAYS: '7' }),
    ).toBe(7);
    expect(
      resolveCheckpointRetentionDays({ CHECKPOINT_RETENTION_DAYS: 'abc' }),
    ).toBe(DEFAULT_CHECKPOINT_RETENTION_DAYS);
    expect(
      resolveCheckpointRetentionDays({ CHECKPOINT_RETENTION_DAYS: '0' }),
    ).toBe(DEFAULT_CHECKPOINT_RETENTION_DAYS);
  });
});

describe('resolveRetentionCheckIntervalMs', () => {
  it('по умолчанию — 6 часов', () => {
    expect(resolveRetentionCheckIntervalMs({})).toBe(
      DEFAULT_RETENTION_CHECK_INTERVAL_MS,
    );
  });

  it('читает CHECKPOINT_RETENTION_CHECK_INTERVAL_MS', () => {
    expect(
      resolveRetentionCheckIntervalMs({
        CHECKPOINT_RETENTION_CHECK_INTERVAL_MS: '1000',
      }),
    ).toBe(1_000);
  });
});

describe('cleanupStaleCheckpoints', () => {
  it('удаляет checkpoint и writes старого завершённого диалога', async () => {
    const logSpy = vi.spyOn(Logger.prototype, 'log').mockImplementation(() => {
      // JSON-лог проверяем через шпион, вывод не засоряем.
    });
    const { deps, fake, conversationFindMany } = createSetup();
    await seedThread(fake, CONVERSATION_ID);
    conversationFindMany.mockResolvedValueOnce([{ id: CONVERSATION_ID }]);

    const result = await cleanupStaleCheckpoints(deps, NOW);

    expect(result).toEqual({ threads: 1, checkpoints: 1, writes: 1 });
    expect(fake.state.graphCheckpoints).toHaveLength(0);
    expect(fake.state.graphCheckpointWrites).toHaveLength(0);
    expect(conversationFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { updatedAt: { lt: DEFAULT_CUTOFF } },
        take: 200,
      }),
    );

    const logged = logSpy.mock.calls
      .map(([message]) => String(message))
      .find((message) => message.includes('checkpoint.retention_cleaned'));

    expect(logged).toBeDefined();
    expect(JSON.parse(logged ?? '{}')).toEqual({
      event: 'checkpoint.retention_cleaned',
      threads: 1,
      checkpoints: 1,
      writes: 1,
    });

    logSpy.mockRestore();
  });

  it('не трогает checkpoint активного диалога', async () => {
    const { deps, fake, conversationFindMany } = createSetup();
    await seedThread(fake, ACTIVE_CONVERSATION_ID);
    conversationFindMany
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ id: ACTIVE_CONVERSATION_ID }]);

    const result = await cleanupStaleCheckpoints(deps, NOW);

    expect(result).toEqual({ threads: 0, checkpoints: 0, writes: 0 });
    expect(fake.state.graphCheckpoints).toHaveLength(1);
    expect(fake.state.graphCheckpointWrites).toHaveLength(1);
  });

  it('не трогает тред с активным pending approval', async () => {
    const { deps, fake, conversationFindMany } = createSetup();
    await seedThread(fake, PENDING_CONVERSATION_ID);
    // fake-store ещё не знает про expiresAt (schema обновлена Lead'ом,
    // фикстура вне моих путей) — дополняем тип локально.
    const pendingData: Partial<FakePendingApprovalRecord> & {
      expiresAt: Date;
    } = {
      conversationId: PENDING_CONVERSATION_ID,
      userId: USER_ID,
      reason: 'approval',
      tools: ['sandbox'],
      holds: [],
      status: 'pending',
      expiresAt: new Date(NOW.getTime() + DAY_MS),
    };
    await fake.prisma.pendingApproval.create({ data: pendingData });
    conversationFindMany
      .mockResolvedValueOnce([{ id: PENDING_CONVERSATION_ID }])
      .mockResolvedValueOnce([{ id: PENDING_CONVERSATION_ID }]);

    const result = await cleanupStaleCheckpoints(deps, NOW);

    expect(result).toEqual({ threads: 0, checkpoints: 0, writes: 0 });
    expect(fake.state.graphCheckpoints).toHaveLength(1);
  });

  it('удаляет orphan-тред без Conversation', async () => {
    silenceServiceLogs();
    const { deps, fake, conversationFindMany } = createSetup();
    await seedThread(fake, ORPHAN_THREAD_ID);
    conversationFindMany
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([]);

    const result = await cleanupStaleCheckpoints(deps, NOW);

    expect(result).toEqual({ threads: 1, checkpoints: 1, writes: 1 });
    expect(fake.state.graphCheckpoints).toHaveLength(0);
    expect(fake.state.graphCheckpointWrites).toHaveLength(0);
  });

  it('ничего не делает, если удалять нечего', async () => {
    const logSpy = vi.spyOn(Logger.prototype, 'log').mockImplementation(() => {
      // Лог retention не должен появиться.
    });
    const { deps, conversationFindMany } = createSetup();
    conversationFindMany.mockResolvedValue([]);

    const result = await cleanupStaleCheckpoints(deps, NOW);

    expect(result).toEqual({ threads: 0, checkpoints: 0, writes: 0 });
    expect(
      logSpy.mock.calls.some(([message]) =>
        String(message).includes('checkpoint.retention_cleaned'),
      ),
    ).toBe(false);

    logSpy.mockRestore();
  });

  it('считает cutoff из CHECKPOINT_RETENTION_DAYS', async () => {
    const originalDays = process.env.CHECKPOINT_RETENTION_DAYS;
    process.env.CHECKPOINT_RETENTION_DAYS = '7';
    const { deps, conversationFindMany } = createSetup();
    conversationFindMany.mockResolvedValue([]);

    try {
      await cleanupStaleCheckpoints(deps, NOW);

      expect(conversationFindMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            updatedAt: { lt: new Date(NOW.getTime() - 7 * DAY_MS) },
          },
        }),
      );
    } finally {
      if (originalDays === undefined) {
        delete process.env.CHECKPOINT_RETENTION_DAYS;
      } else {
        process.env.CHECKPOINT_RETENTION_DAYS = originalDays;
      }
    }
  });
});

describe('CheckpointRetentionService', () => {
  it('запускает первый тик сразу и периодически тикает по интервалу', () => {
    silenceServiceLogs();
    vi.useFakeTimers();
    const originalInterval =
      process.env.CHECKPOINT_RETENTION_CHECK_INTERVAL_MS;
    process.env.CHECKPOINT_RETENTION_CHECK_INTERVAL_MS = '1000';

    try {
      const { deps } = createSetup();
      const service = new CheckpointRetentionService(
        deps.prisma as unknown as PrismaService,
      );
      const tickSpy = vi
        .spyOn(service, 'tick')
        .mockResolvedValue({ threads: 0, checkpoints: 0, writes: 0 });

      service.onModuleInit();
      expect(tickSpy).toHaveBeenCalledTimes(1);

      vi.advanceTimersByTime(1_000);
      expect(tickSpy).toHaveBeenCalledTimes(2);

      service.onModuleDestroy();
      vi.advanceTimersByTime(5_000);
      expect(tickSpy).toHaveBeenCalledTimes(2);
    } finally {
      if (originalInterval === undefined) {
        delete process.env.CHECKPOINT_RETENTION_CHECK_INTERVAL_MS;
      } else {
        process.env.CHECKPOINT_RETENTION_CHECK_INTERVAL_MS = originalInterval;
      }

      vi.useRealTimers();
    }
  });

  it('tick не пробрасывает ошибку БД и логирует её', async () => {
    const errorSpy = vi
      .spyOn(Logger.prototype, 'error')
      .mockImplementation(() => {
        // Ожидаемая ошибка тика.
      });
    const brokenPrisma = {
      conversation: {
        findMany: vi.fn().mockRejectedValue(new Error('db down')),
      },
      pendingApproval: { findMany: vi.fn() },
      graphCheckpoint: { findMany: vi.fn(), deleteMany: vi.fn() },
      graphCheckpointWrite: { deleteMany: vi.fn() },
    } as unknown as PrismaService;
    const service = new CheckpointRetentionService(brokenPrisma);

    await expect(service.tick(NOW)).resolves.toEqual({
      threads: 0,
      checkpoints: 0,
      writes: 0,
    });
    expect(errorSpy).toHaveBeenCalled();

    errorSpy.mockRestore();
  });
});

import { Logger } from '@nestjs/common';
import type { CheckpointStoreService } from '../../agent/checkpoint-store.service.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { BillingService } from '../../billing/billing.service.js';
import type { PrismaService } from '../../prisma/prisma.service.js';
import { createFakeCheckpointPrisma } from '../../../test/checkpointer/fake-checkpoint-store.js';
import type { FakePendingApprovalRecord } from '../../../test/checkpointer/fake-checkpoint-store.js';
import {
  DEFAULT_EXPIRY_CHECK_INTERVAL_MS,
  ExpiredApprovalsService,
  expireOverdueApprovals,
  resolveExpiryCheckIntervalMs,
  type ExpiredApprovalsDeps,
} from './expired-approvals.service.js';
import {
  PendingApprovalService,
  type PendingApprovalHold,
} from './pending-approval.service.js';

const USER_ID = '22222222-2222-2222-2222-222222222222';
const CONVERSATION_ID = 'conversation-expired';
const SECOND_CONVERSATION_ID = 'conversation-expired-2';

/** Глушит JSON-логи сервиса в тестах, где они не проверяются. */
function silenceServiceLogs(): void {
  vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
}

afterEach(() => {
  vi.restoreAllMocks();
});

const NOW = new Date('2026-11-13T12:00:00.000Z');
const PAST = new Date(NOW.getTime() - 60_000);
const FUTURE = new Date(NOW.getTime() + 60_000);

const HOLD: PendingApprovalHold = {
  callId: 'call-1',
  toolName: 'sandbox',
  entryId: 'entry-1',
};
const SECOND_HOLD: PendingApprovalHold = {
  callId: 'call-2',
  toolName: 'publish',
  entryId: 'entry-2',
};

function createSetup() {
  const store = createFakeCheckpointPrisma();
  const pendingApprovals = new PendingApprovalService(
    store.prisma as unknown as PrismaService,
  );
  const cancelHold = vi.fn(
    async (_entryId: string): Promise<void> => undefined,
  );
  const deleteThread = vi.fn(
    async (_threadId: string): Promise<void> => undefined,
  );
  const deps: ExpiredApprovalsDeps = {
    prisma: store.prisma as unknown as ExpiredApprovalsDeps['prisma'],
    pendingApprovals:
      pendingApprovals as unknown as ExpiredApprovalsDeps['pendingApprovals'],
    checkpointer: { deleteThread } as unknown as ExpiredApprovalsDeps['checkpointer'],
    billing: { cancelHold } as unknown as ExpiredApprovalsDeps['billing'],
  };

  return { deps, store, pendingApprovals, cancelHold, deleteThread };
}

interface SeedOverdueOptions {
  conversationId?: string;
  reason?: 'approval' | 'payment';
  holds?: PendingApprovalHold[];
  expiresAt?: Date;
}

async function seedOverdue(
  store: ReturnType<typeof createFakeCheckpointPrisma>,
  options: SeedOverdueOptions = {},
): Promise<void> {
  // fake-store ещё не знает про expiresAt (schema обновлена Lead'ом, фикстура
  // вне моих путей) — дополняем тип локально, значение пишется как есть.
  const data: Partial<FakePendingApprovalRecord> & { expiresAt: Date } = {
    conversationId: options.conversationId ?? CONVERSATION_ID,
    userId: USER_ID,
    reason: options.reason ?? 'payment',
    tools: ['sandbox'],
    holds: options.holds ?? [HOLD],
    status: 'pending',
    expiresAt: options.expiresAt ?? PAST,
  };

  await store.prisma.pendingApproval.create({ data });
}

describe('resolveExpiryCheckIntervalMs', () => {
  it('по умолчанию — 5 минут', () => {
    expect(resolveExpiryCheckIntervalMs({})).toBe(
      DEFAULT_EXPIRY_CHECK_INTERVAL_MS,
    );
  });

  it('читает HITL_EXPIRY_CHECK_INTERVAL_MS и игнорирует мусор', () => {
    expect(
      resolveExpiryCheckIntervalMs({ HITL_EXPIRY_CHECK_INTERVAL_MS: '1000' }),
    ).toBe(1_000);
    expect(
      resolveExpiryCheckIntervalMs({ HITL_EXPIRY_CHECK_INTERVAL_MS: 'abc' }),
    ).toBe(DEFAULT_EXPIRY_CHECK_INTERVAL_MS);
    expect(
      resolveExpiryCheckIntervalMs({ HITL_EXPIRY_CHECK_INTERVAL_MS: '-5' }),
    ).toBe(DEFAULT_EXPIRY_CHECK_INTERVAL_MS);
  });
});

describe('expireOverdueApprovals', () => {
  it('отменяет holds, чистит checkpoint, ставит expired и пишет JSON-лог', async () => {
    const logSpy = vi.spyOn(Logger.prototype, 'log').mockImplementation(() => {
      // JSON-лог проверяем через шпион, вывод не засоряем.
    });
    const { deps, store, pendingApprovals, cancelHold, deleteThread } =
      createSetup();
    await seedOverdue(store);

    const result = await expireOverdueApprovals(deps, NOW);

    expect(result).toEqual({ expired: 1, holdsCancelled: 1 });
    expect(cancelHold).toHaveBeenCalledWith(HOLD.entryId);
    expect(deleteThread).toHaveBeenCalledWith(CONVERSATION_ID);

    const [row] = store.state.pendingApprovals;
    expect(row?.status).toBe('expired');
    expect(row?.resolvedAt).toBeInstanceOf(Date);
    expect(await pendingApprovals.findPending(CONVERSATION_ID)).toBeNull();
    await expect(pendingApprovals.listPending(USER_ID)).resolves.toEqual([]);

    const logged = logSpy.mock.calls
      .map(([message]) => String(message))
      .find((message) => message.includes('hitl.approval_expired'));

    expect(logged).toBeDefined();
    expect(JSON.parse(logged ?? '{}')).toMatchObject({
      event: 'hitl.approval_expired',
      conversationId: CONVERSATION_ID,
      userId: USER_ID,
      reason: 'payment',
      holds: 1,
    });

    logSpy.mockRestore();
  });

  it('не трогает ожидания с будущим дедлайном', async () => {
    const { deps, store, cancelHold, deleteThread } = createSetup();
    await seedOverdue(store, { expiresAt: FUTURE });

    const result = await expireOverdueApprovals(deps, NOW);

    expect(result).toEqual({ expired: 0, holdsCancelled: 0 });
    expect(cancelHold).not.toHaveBeenCalled();
    expect(deleteThread).not.toHaveBeenCalled();
    expect(store.state.pendingApprovals[0]?.status).toBe('pending');
  });

  it('повторный тик — no-op', async () => {
    silenceServiceLogs();
    const { deps, store, cancelHold, pendingApprovals } = createSetup();
    await seedOverdue(store);

    await expect(expireOverdueApprovals(deps, NOW)).resolves.toEqual({
      expired: 1,
      holdsCancelled: 1,
    });
    await expect(expireOverdueApprovals(deps, NOW)).resolves.toEqual({
      expired: 0,
      holdsCancelled: 0,
    });

    expect(cancelHold).toHaveBeenCalledTimes(1);
    await expect(pendingApprovals.listPending(USER_ID)).resolves.toEqual([]);
  });

  it('ошибка cancelHold не мешает остальным hold\'ам и закрытию ожидания', async () => {
    silenceServiceLogs();
    const warnSpy = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => {
      // Ожидаемое предупреждение.
    });
    const { deps, store, cancelHold } = createSetup();
    cancelHold.mockRejectedValueOnce(new Error('ledger down'));
    await seedOverdue(store, { holds: [HOLD, SECOND_HOLD] });

    const result = await expireOverdueApprovals(deps, NOW);

    expect(cancelHold).toHaveBeenCalledTimes(2);
    expect(result).toEqual({ expired: 1, holdsCancelled: 1 });
    expect(store.state.pendingApprovals[0]?.status).toBe('expired');
    expect(warnSpy).toHaveBeenCalled();

    warnSpy.mockRestore();
  });

  it('ошибка обработки одного ожидания не останавливает остальные', async () => {
    silenceServiceLogs();
    const warnSpy = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => {
      // Ожидаемое предупреждение.
    });
    const { deps, store, cancelHold, deleteThread } = createSetup();
    cancelHold.mockImplementation(async (entryId: string) => {
      if (entryId === HOLD.entryId) {
        throw new Error('ledger down');
      }

      return undefined;
    });
    await seedOverdue(store, { conversationId: CONVERSATION_ID, holds: [HOLD] });
    await seedOverdue(store, {
      conversationId: SECOND_CONVERSATION_ID,
      holds: [SECOND_HOLD],
    });

    const result = await expireOverdueApprovals(deps, NOW);

    expect(result.expired).toBe(2);
    expect(deleteThread).toHaveBeenCalledTimes(2);
    expect(
      store.state.pendingApprovals.map((row) => row.status),
    ).toEqual(['expired', 'expired']);

    warnSpy.mockRestore();
  });

  it('ошибка deleteThread не мешает закрыть ожидание', async () => {
    silenceServiceLogs();
    const warnSpy = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => {
      // Ожидаемое предупреждение.
    });
    const { deps, store, deleteThread } = createSetup();
    deleteThread.mockRejectedValueOnce(new Error('db down'));
    await seedOverdue(store);

    const result = await expireOverdueApprovals(deps, NOW);

    expect(result.expired).toBe(1);
    expect(store.state.pendingApprovals[0]?.status).toBe('expired');

    warnSpy.mockRestore();
  });

  it('битая JSON-колонка holds не мешает закрыть ожидание', async () => {
    silenceServiceLogs();
    const warnSpy = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => {
      // Ожидаемое предупреждение.
    });
    const { deps, store, cancelHold } = createSetup();
    await seedOverdue(store);
    const [row] = store.state.pendingApprovals;

    if (row !== undefined) {
      row.holds = 'not-an-array';
    }

    const result = await expireOverdueApprovals(deps, NOW);

    expect(cancelHold).not.toHaveBeenCalled();
    expect(result).toEqual({ expired: 1, holdsCancelled: 0 });
    expect(store.state.pendingApprovals[0]?.status).toBe('expired');

    warnSpy.mockRestore();
  });
});

describe('ExpiredApprovalsService', () => {
  it('запускает первый тик сразу и периодически тикает по интервалу', () => {
    silenceServiceLogs();
    vi.useFakeTimers();
    const originalInterval = process.env.HITL_EXPIRY_CHECK_INTERVAL_MS;
    process.env.HITL_EXPIRY_CHECK_INTERVAL_MS = '1000';

    try {
      const { deps } = createSetup();
      const service = new ExpiredApprovalsService(
        deps.prisma as unknown as PrismaService,
        deps.checkpointer as unknown as CheckpointStoreService,
        deps.billing as unknown as BillingService,
        deps.pendingApprovals as unknown as PendingApprovalService,
      );
      const tickSpy = vi
        .spyOn(service, 'tick')
        .mockResolvedValue({ expired: 0, holdsCancelled: 0 });

      service.onModuleInit();
      expect(tickSpy).toHaveBeenCalledTimes(1);

      vi.advanceTimersByTime(1_000);
      expect(tickSpy).toHaveBeenCalledTimes(2);

      service.onModuleDestroy();
      vi.advanceTimersByTime(5_000);
      expect(tickSpy).toHaveBeenCalledTimes(2);
    } finally {
      if (originalInterval === undefined) {
        delete process.env.HITL_EXPIRY_CHECK_INTERVAL_MS;
      } else {
        process.env.HITL_EXPIRY_CHECK_INTERVAL_MS = originalInterval;
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
    const { deps } = createSetup();
    const brokenPrisma = {
      pendingApproval: {
        findMany: vi.fn().mockRejectedValue(new Error('db down')),
      },
    } as unknown as ExpiredApprovalsDeps['prisma'];
    const service = new ExpiredApprovalsService(
      brokenPrisma as unknown as PrismaService,
      deps.checkpointer as unknown as CheckpointStoreService,
      deps.billing as unknown as BillingService,
      deps.pendingApprovals as unknown as PendingApprovalService,
    );

    await expect(service.tick(NOW)).resolves.toEqual({
      expired: 0,
      holdsCancelled: 0,
    });
    expect(errorSpy).toHaveBeenCalled();

    errorSpy.mockRestore();
  });
});

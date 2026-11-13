import { Logger } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
import type { PrismaService } from '../../prisma/prisma.service.js';
import {
  createFakeCheckpointPrisma,
  type FakePendingApprovalRecord,
} from '../../../test/checkpointer/fake-checkpoint-store.js';
import {
  DEFAULT_APPROVAL_TTL_HOURS,
  PendingApprovalService,
  computeApprovalExpiresAt,
  resolveApprovalTtlMs,
  type PendingApprovalHold,
} from './pending-approval.service.js';

/**
 * Фикстура fake-store ещё не знает про `PendingApproval.expiresAt`
 * (schema обновлена Lead'ом, файл фикстуры — вне моих путей). Дополняем тип
 * локально: в БД-модели поле есть, fake хранит его как обычное свойство.
 */
type ExpirablePendingApproval = FakePendingApprovalRecord & {
  expiresAt: Date | null;
};

function setExpiresAt(
  row: FakePendingApprovalRecord,
  expiresAt: Date | null,
): void {
  (row as ExpirablePendingApproval).expiresAt = expiresAt;
}


const USER_ID = '22222222-2222-2222-2222-222222222222';
const OTHER_USER_ID = '33333333-3333-3333-3333-333333333333';
const CONVERSATION_ID = 'conversation-1';
const OTHER_CONVERSATION_ID = 'conversation-2';

const HOUR_MS = 60 * 60 * 1000;

const HOLD: PendingApprovalHold = {
  callId: 'call-1',
  toolName: 'sandbox',
  entryId: 'entry-1',
};

const TTL_ENV_KEY = 'HITL_APPROVAL_TTL_HOURS';

function createService() {
  const store = createFakeCheckpointPrisma();
  const service = new PendingApprovalService(
    store.prisma as unknown as PrismaService,
  );

  return { service, store };
}

/** Подменяет env на время теста и гарантированно восстанавливает. */
async function withApprovalTtl<T>(
  raw: string | undefined,
  run: () => Promise<T> | T,
): Promise<T> {
  const original = process.env[TTL_ENV_KEY];

  if (raw === undefined) {
    delete process.env[TTL_ENV_KEY];
  } else {
    process.env[TTL_ENV_KEY] = raw;
  }

  try {
    return await run();
  } finally {
    if (original === undefined) {
      delete process.env[TTL_ENV_KEY];
    } else {
      process.env[TTL_ENV_KEY] = original;
    }
  }
}

function upsertInput(conversationId = CONVERSATION_ID) {
  return {
    conversationId,
    userId: USER_ID,
    reason: 'approval' as const,
    tools: ['sandbox'],
    holds: [HOLD],
  };
}

describe('approval TTL', () => {
  it('по умолчанию — 24 часа', () => {
    expect(resolveApprovalTtlMs({})).toBe(
      DEFAULT_APPROVAL_TTL_HOURS * HOUR_MS,
    );
  });

  it('читает положительный HITL_APPROVAL_TTL_HOURS', () => {
    expect(resolveApprovalTtlMs({ HITL_APPROVAL_TTL_HOURS: '2' })).toBe(
      2 * HOUR_MS,
    );
    expect(resolveApprovalTtlMs({ HITL_APPROVAL_TTL_HOURS: '0.5' })).toBe(
      HOUR_MS / 2,
    );
  });

  it('невалидное или неположительное значение → 24 часа', () => {
    for (const raw of ['', '  ', 'abc', '0', '-1', 'Infinity']) {
      expect(resolveApprovalTtlMs({ HITL_APPROVAL_TTL_HOURS: raw })).toBe(
        DEFAULT_APPROVAL_TTL_HOURS * HOUR_MS,
      );
    }
  });

  it('computeApprovalExpiresAt прибавляет TTL к now', () => {
    const now = new Date('2026-11-13T10:00:00.000Z');

    expect(computeApprovalExpiresAt(now, 2 * HOUR_MS).toISOString()).toBe(
      '2026-11-13T12:00:00.000Z',
    );
  });
});

describe('PendingApprovalService.upsertPending', () => {
  it('создаёт pending-запись с tools, holds и expiresAt', async () => {
    const { service, store } = createService();
    const before = Date.now();

    const record = await withApprovalTtl(undefined, () =>
      service.upsertPending(upsertInput()),
    );
    const after = Date.now();
    const expiresAt = record.expiresAt?.getTime() ?? 0;

    expect(record.conversationId).toBe(CONVERSATION_ID);
    expect(record.userId).toBe(USER_ID);
    expect(record.reason).toBe('approval');
    expect(record.tools).toEqual(['sandbox']);
    expect(record.holds).toEqual([HOLD]);
    expect(record.status).toBe('pending');
    expect(record.resolvedAt).toBeNull();
    expect(expiresAt).toBeGreaterThanOrEqual(
      before + DEFAULT_APPROVAL_TTL_HOURS * HOUR_MS,
    );
    expect(expiresAt).toBeLessThanOrEqual(
      after + DEFAULT_APPROVAL_TTL_HOURS * HOUR_MS,
    );
    expect(store.state.pendingApprovals).toHaveLength(1);
  });

  it('учитывает HITL_APPROVAL_TTL_HOURS', async () => {
    const { service } = createService();

    await withApprovalTtl('2', async () => {
      const before = Date.now();
      const record = await service.upsertPending(upsertInput());
      const delta = (record.expiresAt?.getTime() ?? 0) - before;

      expect(delta).toBeGreaterThanOrEqual(2 * HOUR_MS - 1_000);
      expect(delta).toBeLessThanOrEqual(2 * HOUR_MS + 5_000);
    });
  });

  it('обновляет существующую запись диалога, а не создаёт новую', async () => {
    const { service, store } = createService();
    const created = await service.upsertPending(upsertInput());

    const updated = await service.upsertPending({
      ...upsertInput(),
      reason: 'payment',
      tools: ['publish', 'sandbox'],
      holds: [],
    });

    expect(store.state.pendingApprovals).toHaveLength(1);
    expect(updated.id).toBe(created.id);
    expect(updated.reason).toBe('payment');
    expect(updated.tools).toEqual(['publish', 'sandbox']);
    expect(updated.holds).toEqual([]);
    expect(updated.resolvedAt).toBeNull();
    expect(updated.status).toBe('pending');
  });

  it('сбрасывает прежнее решение и обновляет expiresAt при повторном ожидании', async () => {
    const { service, store } = createService();
    await service.upsertPending(upsertInput());
    await expect(
      service.resolvePending(CONVERSATION_ID, 'approved'),
    ).resolves.toBe(1);

    const [row] = store.state.pendingApprovals;

    if (row !== undefined) {
      // Старый дедлайн в прошлом: upsert обязан пересчитать его заново.
      setExpiresAt(row, new Date(Date.now() - HOUR_MS));
    }

    const revived = await service.upsertPending(upsertInput());

    expect(revived.status).toBe('pending');
    expect(revived.resolvedAt).toBeNull();
    expect(revived.expiresAt?.getTime() ?? 0).toBeGreaterThan(Date.now());
  });
});

describe('PendingApprovalService.findPending', () => {
  it('находит ожидающее действие диалога', async () => {
    const { service } = createService();
    await service.upsertPending(upsertInput());

    const pending = await service.findPending(CONVERSATION_ID);

    expect(pending?.reason).toBe('approval');
    expect(pending?.holds).toEqual([HOLD]);
    expect(pending?.expiresAt).toBeInstanceOf(Date);
  });

  it('возвращает null после решения и для чужого диалога', async () => {
    const { service } = createService();
    await service.upsertPending(upsertInput());
    await service.resolvePending(CONVERSATION_ID, 'rejected');

    await expect(service.findPending(CONVERSATION_ID)).resolves.toBeNull();
    await expect(service.findPending('unknown')).resolves.toBeNull();
  });

  it('не отдаёт просроченное ожидание до тика job\'а', async () => {
    const { service, store } = createService();
    await service.upsertPending(upsertInput());

    const [row] = store.state.pendingApprovals;

    if (row !== undefined) {
      setExpiresAt(row, new Date(Date.now() - 1_000));
    }

    await expect(service.findPending(CONVERSATION_ID)).resolves.toBeNull();
  });

  it('запись без TTL (старые строки) считается активной', async () => {
    const { service, store } = createService();
    await service.upsertPending(upsertInput());

    const [row] = store.state.pendingApprovals;

    if (row !== undefined) {
      setExpiresAt(row, null);
    }

    await expect(service.findPending(CONVERSATION_ID)).resolves.not.toBeNull();
  });

  it('не падает на битой JSON-колонке', async () => {
    const warnSpy = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => {
      // Ожидаемое предупреждение: не засоряем вывод теста.
    });
    const { service, store } = createService();
    const brokenRow: ExpirablePendingApproval = {
      id: 'broken',
      conversationId: CONVERSATION_ID,
      userId: USER_ID,
      reason: 'approval',
      tools: { broken: true },
      holds: 'not-an-array',
      status: 'pending',
      createdAt: new Date(),
      resolvedAt: null,
      expiresAt: null,
    };
    store.state.pendingApprovals.push(brokenRow);

    await expect(service.findPending(CONVERSATION_ID)).resolves.toBeNull();
    expect(warnSpy).toHaveBeenCalled();

    warnSpy.mockRestore();
  });
});

describe('PendingApprovalService.listPending', () => {
  it('отдаёт ожидающие записи пользователя от новых к старым', async () => {
    const { service, store } = createService();
    await service.upsertPending(upsertInput());
    await service.upsertPending(upsertInput(OTHER_CONVERSATION_ID));
    await service.upsertPending({
      ...upsertInput('conversation-3'),
      userId: OTHER_USER_ID,
    });

    // Явные метки времени, чтобы порядок не зависел от скорости теста.
    const [older, newer] = store.state.pendingApprovals;
    if (older !== undefined && newer !== undefined) {
      older.createdAt = new Date('2026-11-13T10:00:00.000Z');
      newer.createdAt = new Date('2026-11-13T11:00:00.000Z');
    }

    const pending = await service.listPending(USER_ID);

    expect(pending.map((record) => record.conversationId)).toEqual([
      OTHER_CONVERSATION_ID,
      CONVERSATION_ID,
    ]);
  });

  it('не отдаёт просроченные и закрытые ожидания', async () => {
    const { service, store } = createService();
    await service.upsertPending(upsertInput());
    await service.upsertPending(upsertInput(OTHER_CONVERSATION_ID));
    await service.upsertPending(upsertInput('conversation-3'));

    const expiredRow = store.state.pendingApprovals.find(
      (row) => row.conversationId === CONVERSATION_ID,
    );

    if (expiredRow !== undefined) {
      setExpiresAt(expiredRow, new Date(Date.now() - 1_000));
    }

    await service.resolvePending(OTHER_CONVERSATION_ID, 'rejected');

    const pending = await service.listPending(USER_ID);

    expect(pending.map((record) => record.conversationId)).toEqual([
      'conversation-3',
    ]);
  });

  it('пропускает записи с битыми JSON-колонками', async () => {
    const warnSpy = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => {
      // Ожидаемое предупреждение: не засоряем вывод теста.
    });
    const { service, store } = createService();
    await service.upsertPending(upsertInput());
    const brokenRow: ExpirablePendingApproval = {
      id: 'broken',
      conversationId: OTHER_CONVERSATION_ID,
      userId: USER_ID,
      reason: 'approval',
      tools: 'not an array',
      holds: [],
      status: 'pending',
      createdAt: new Date(),
      resolvedAt: null,
      expiresAt: null,
    };
    store.state.pendingApprovals.push(brokenRow);

    const pending = await service.listPending(USER_ID);

    expect(pending.map((record) => record.conversationId)).toEqual([
      CONVERSATION_ID,
    ]);
    expect(warnSpy).toHaveBeenCalled();

    warnSpy.mockRestore();
  });

  it('не отдаёт закрытые ожидания', async () => {
    const { service } = createService();
    await service.upsertPending(upsertInput());
    await service.resolvePending(CONVERSATION_ID, 'approved');

    await expect(service.listPending(USER_ID)).resolves.toEqual([]);
  });
});

describe('PendingApprovalService.resolvePending', () => {
  it('закрывает только pending-запись и ставит resolvedAt', async () => {
    const { service, store } = createService();
    await service.upsertPending(upsertInput());

    await expect(
      service.resolvePending(CONVERSATION_ID, 'approved'),
    ).resolves.toBe(1);

    const [row] = store.state.pendingApprovals;
    expect(row?.status).toBe('approved');
    expect(row?.resolvedAt).toBeInstanceOf(Date);
  });

  it('принимает статус expired для просроченного ожидания', async () => {
    const { service, store } = createService();
    await service.upsertPending(upsertInput());

    await expect(
      service.resolvePending(CONVERSATION_ID, 'expired'),
    ).resolves.toBe(1);

    const [row] = store.state.pendingApprovals;
    expect(row?.status).toBe('expired');
    expect(row?.resolvedAt).toBeInstanceOf(Date);
    await expect(service.findPending(CONVERSATION_ID)).resolves.toBeNull();
  });

  it('идемпотентен: повторное решение не меняет уже закрытую запись', async () => {
    const { service } = createService();
    await service.upsertPending(upsertInput());

    await expect(
      service.resolvePending(CONVERSATION_ID, 'approved'),
    ).resolves.toBe(1);
    await expect(
      service.resolvePending(CONVERSATION_ID, 'rejected'),
    ).resolves.toBe(0);
    await expect(
      service.resolvePending(CONVERSATION_ID, 'expired'),
    ).resolves.toBe(0);
    await expect(
      service.resolvePending('unknown', 'approved'),
    ).resolves.toBe(0);
  });
});

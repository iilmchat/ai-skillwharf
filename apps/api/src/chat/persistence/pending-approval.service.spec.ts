import { Logger } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
import type { PrismaService } from '../../prisma/prisma.service.js';
import { createFakeCheckpointPrisma } from '../../../test/checkpointer/fake-checkpoint-store.js';
import {
  PendingApprovalService,
  type PendingApprovalHold,
} from './pending-approval.service.js';

const USER_ID = '22222222-2222-2222-2222-222222222222';
const OTHER_USER_ID = '33333333-3333-3333-3333-333333333333';
const CONVERSATION_ID = 'conversation-1';
const OTHER_CONVERSATION_ID = 'conversation-2';

const HOLD: PendingApprovalHold = {
  callId: 'call-1',
  toolName: 'sandbox',
  entryId: 'entry-1',
};

function createService() {
  const store = createFakeCheckpointPrisma();
  const service = new PendingApprovalService(
    store.prisma as unknown as PrismaService,
  );

  return { service, store };
}

describe('PendingApprovalService.upsertPending', () => {
  it('создаёт pending-запись с tools и holds', async () => {
    const { service, store } = createService();

    const record = await service.upsertPending({
      conversationId: CONVERSATION_ID,
      userId: USER_ID,
      reason: 'payment',
      tools: ['sandbox'],
      holds: [HOLD],
    });

    expect(record.conversationId).toBe(CONVERSATION_ID);
    expect(record.userId).toBe(USER_ID);
    expect(record.reason).toBe('payment');
    expect(record.tools).toEqual(['sandbox']);
    expect(record.holds).toEqual([HOLD]);
    expect(record.status).toBe('pending');
    expect(record.resolvedAt).toBeNull();
    expect(store.state.pendingApprovals).toHaveLength(1);
  });

  it('обновляет существующую запись диалога, а не создаёт новую', async () => {
    const { service, store } = createService();
    const created = await service.upsertPending({
      conversationId: CONVERSATION_ID,
      userId: USER_ID,
      reason: 'payment',
      tools: ['sandbox'],
      holds: [HOLD],
    });

    const updated = await service.upsertPending({
      conversationId: CONVERSATION_ID,
      userId: USER_ID,
      reason: 'approval',
      tools: ['publish', 'sandbox'],
      holds: [],
    });

    expect(store.state.pendingApprovals).toHaveLength(1);
    expect(updated.id).toBe(created.id);
    expect(updated.reason).toBe('approval');
    expect(updated.tools).toEqual(['publish', 'sandbox']);
    expect(updated.holds).toEqual([]);
    expect(updated.resolvedAt).toBeNull();
  });

  it('сбрасывает прежнее решение при повторном ожидании', async () => {
    const { service } = createService();
    await service.upsertPending({
      conversationId: CONVERSATION_ID,
      userId: USER_ID,
      reason: 'approval',
      tools: ['sandbox'],
      holds: [],
    });
    await expect(
      service.resolvePending(CONVERSATION_ID, 'approved'),
    ).resolves.toBe(1);

    const revived = await service.upsertPending({
      conversationId: CONVERSATION_ID,
      userId: USER_ID,
      reason: 'approval',
      tools: ['sandbox'],
      holds: [HOLD],
    });

    expect(revived.status).toBe('pending');
    expect(revived.resolvedAt).toBeNull();
  });
});

describe('PendingApprovalService.findPending', () => {
  it('находит ожидающее действие диалога', async () => {
    const { service } = createService();
    await service.upsertPending({
      conversationId: CONVERSATION_ID,
      userId: USER_ID,
      reason: 'approval',
      tools: ['sandbox'],
      holds: [HOLD],
    });

    const pending = await service.findPending(CONVERSATION_ID);

    expect(pending?.reason).toBe('approval');
    expect(pending?.holds).toEqual([HOLD]);
  });

  it('возвращает null после решения и для чужого диалога', async () => {
    const { service } = createService();
    await service.upsertPending({
      conversationId: CONVERSATION_ID,
      userId: USER_ID,
      reason: 'approval',
      tools: [],
      holds: [],
    });
    await service.resolvePending(CONVERSATION_ID, 'rejected');

    await expect(service.findPending(CONVERSATION_ID)).resolves.toBeNull();
    await expect(service.findPending('unknown')).resolves.toBeNull();
  });

  it('не падает на битой JSON-колонке', async () => {
    const warnSpy = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => {
      // Ожидаемое предупреждение: не засоряем вывод теста.
    });
    const { service, store } = createService();
    store.state.pendingApprovals.push({
      id: 'broken',
      conversationId: CONVERSATION_ID,
      userId: USER_ID,
      reason: 'approval',
      tools: { broken: true },
      holds: 'not-an-array',
      status: 'pending',
      createdAt: new Date(),
      resolvedAt: null,
    });

    await expect(service.findPending(CONVERSATION_ID)).resolves.toBeNull();
    expect(warnSpy).toHaveBeenCalled();

    warnSpy.mockRestore();
  });
});

describe('PendingApprovalService.listPending', () => {
  it('отдаёт ожидающие записи пользователя от новых к старым', async () => {
    const { service, store } = createService();
    await service.upsertPending({
      conversationId: CONVERSATION_ID,
      userId: USER_ID,
      reason: 'approval',
      tools: ['sandbox'],
      holds: [],
    });
    await service.upsertPending({
      conversationId: OTHER_CONVERSATION_ID,
      userId: USER_ID,
      reason: 'payment',
      tools: ['sandbox'],
      holds: [HOLD],
    });
    await service.upsertPending({
      conversationId: 'conversation-3',
      userId: OTHER_USER_ID,
      reason: 'approval',
      tools: [],
      holds: [],
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

  it('пропускает записи с битыми JSON-колонками', async () => {
    const warnSpy = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => {
      // Ожидаемое предупреждение: не засоряем вывод теста.
    });
    const { service, store } = createService();
    await service.upsertPending({
      conversationId: CONVERSATION_ID,
      userId: USER_ID,
      reason: 'approval',
      tools: ['sandbox'],
      holds: [],
    });
    store.state.pendingApprovals.push({
      id: 'broken',
      conversationId: OTHER_CONVERSATION_ID,
      userId: USER_ID,
      reason: 'approval',
      tools: 'not an array',
      holds: [],
      status: 'pending',
      createdAt: new Date(),
      resolvedAt: null,
    });

    const pending = await service.listPending(USER_ID);

    expect(pending.map((record) => record.conversationId)).toEqual([
      CONVERSATION_ID,
    ]);
    expect(warnSpy).toHaveBeenCalled();

    warnSpy.mockRestore();
  });

  it('не отдаёт закрытые ожидания', async () => {
    const { service } = createService();
    await service.upsertPending({
      conversationId: CONVERSATION_ID,
      userId: USER_ID,
      reason: 'approval',
      tools: [],
      holds: [],
    });
    await service.resolvePending(CONVERSATION_ID, 'approved');

    await expect(service.listPending(USER_ID)).resolves.toEqual([]);
  });
});

describe('PendingApprovalService.resolvePending', () => {
  it('закрывает только pending-запись и ставит resolvedAt', async () => {
    const { service, store } = createService();
    await service.upsertPending({
      conversationId: CONVERSATION_ID,
      userId: USER_ID,
      reason: 'payment',
      tools: ['sandbox'],
      holds: [HOLD],
    });

    await expect(
      service.resolvePending(CONVERSATION_ID, 'approved'),
    ).resolves.toBe(1);

    const [row] = store.state.pendingApprovals;
    expect(row?.status).toBe('approved');
    expect(row?.resolvedAt).toBeInstanceOf(Date);
  });

  it('идемпотентен: повторное решение не меняет уже закрытую запись', async () => {
    const { service } = createService();
    await service.upsertPending({
      conversationId: CONVERSATION_ID,
      userId: USER_ID,
      reason: 'approval',
      tools: [],
      holds: [],
    });

    await expect(
      service.resolvePending(CONVERSATION_ID, 'approved'),
    ).resolves.toBe(1);
    await expect(
      service.resolvePending(CONVERSATION_ID, 'rejected'),
    ).resolves.toBe(0);
    await expect(
      service.resolvePending('unknown', 'approved'),
    ).resolves.toBe(0);
  });
});

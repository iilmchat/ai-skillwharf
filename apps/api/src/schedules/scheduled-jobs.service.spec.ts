import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import type { ChatService } from '../chat/chat.service.js';
import type { CorpChannelsService } from '../channels/corp-channels.service.js';
import type { TelegramChannelsService } from '../channels/telegram-channels.service.js';
import type { TelegramService } from '../integrations/telegram/telegram.service.js';
import type { PrismaService } from '../prisma/prisma.service.js';
import type { WorkspacesService } from '../workspaces/workspaces.service.js';
import { ScheduledJobsService } from './scheduled-jobs.service.js';
import type { ISchedulerLock } from './scheduler-lock.js';

const WORKSPACE_ID = randomUUID();
const JOB_ID = randomUUID();
const USER_ID = 'user-1';

function jobRow(overrides: Record<string, unknown> = {}) {
  return {
    id: JOB_ID,
    workspaceId: WORKSPACE_ID,
    userId: USER_ID,
    name: 'Утренняя сводка',
    cronExpression: '*/15 * * * *',
    timezone: 'UTC',
    prompt: 'Сделай сводку остатков',
    deliveryChannelType: 'telegram',
    deliveryChannelId: 'channel-1',
    deliveryChatId: '100',
    isActive: true,
    nextRunAt: new Date('2026-11-20T05:00:00Z'),
    lastRunAt: null,
    lastRunStatus: null,
    lastRunSummary: null,
    createdAt: new Date('2026-11-19T10:00:00Z'),
    updatedAt: new Date('2026-11-19T10:00:00Z'),
    ...overrides,
  };
}

function createHarness(
  options: {
    locked?: boolean;
    reply?: string;
    throwOnChat?: boolean;
  } = {},
) {
  const rows = new Map<string, Record<string, unknown>>();
  const row = jobRow();
  rows.set(JOB_ID, row);
  const prisma = {
    scheduledAgentJob: {
      findMany: vi.fn(async ({ where }: { where?: { isActive?: boolean } } = {}) =>
        [...rows.values()].filter((item) =>
          where?.isActive === undefined ? true : item.isActive === where.isActive,
        ),
      ),
      findUnique: vi.fn(async ({ where }: { where: { id: string } }) =>
        rows.get(where.id) ?? null,
      ),
      findFirst: vi.fn(
        async ({ where }: { where: { id: string; workspaceId: string } }) =>
          rows.get(where.id)?.workspaceId === where.workspaceId
            ? (rows.get(where.id) ?? null)
            : null,
      ),
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        const created = jobRow({
          id: randomUUID(),
          ...data,
          nextRunAt: data.nextRunAt ?? new Date('2026-11-20T05:15:00Z'),
        });

        rows.set(created.id as string, created);

        return created;
      }),
      update: vi.fn(async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
        const current = rows.get(where.id) ?? {};

        rows.set(where.id, { ...current, ...data });

        return { ...current, ...data };
      }),
      delete: vi.fn(async ({ where }: { where: { id: string } }) => {
        rows.delete(where.id);
      }),
    },
    conversation: {
      create: vi.fn(async () => ({ id: randomUUID() })),
    },
  };
  const chat = {
    handleMessage: vi.fn(async () => {
      if (options.throwOnChat === true) {
        throw new Error('llm unavailable');
      }

      return { conversationId: 'c1', reply: options.reply ?? 'Сводка готова' };
    }),
  };
  const workspaces = {
    resolveActive: vi.fn(async () => ({ workspaceId: WORKSPACE_ID })),
    assertRole: vi.fn(async () => undefined),
    payingRoles: vi.fn(() => new Set(['owner', 'admin', 'operator'])),
  };
  const telegramChannelRow = {
    id: 'channel-1',
    isActive: true,
    allowedChatIds: ['100'],
  };
  const telegramChannels = {
    findForWebhook: vi.fn(async () => telegramChannelRow),
    decryptToken: vi.fn(() => 'tg-token'),
  };
  const telegram = { sendText: vi.fn(async () => ({ messageId: 1, chatId: '100' })) };
  const corpChannels = {
    findForWebhook: vi.fn(async () => null),
    decryptToken: vi.fn(() => 'corp-token'),
    adapters: { get: vi.fn() },
  };
  const lock: ISchedulerLock = {
    ownerToken: 'test',
    acquire: vi.fn(async () => options.locked !== false),
    release: vi.fn(async () => undefined),
  };
  const service = new ScheduledJobsService(
    prisma as unknown as PrismaService,
    chat as unknown as ChatService,
    workspaces as unknown as WorkspacesService,
    telegramChannels as unknown as TelegramChannelsService,
    corpChannels as unknown as CorpChannelsService,
    telegram as unknown as TelegramService,
    { SCHEDULER_POLL_MS: '0' },
    lock,
  );

  return {
    service,
    prisma,
    chat,
    workspaces,
    telegram,
    telegramChannels,
    lock,
    rows,
  };
}

describe('ScheduledJobsService (CRON-43.1/43.2)', () => {
  it('тик без блокировки пропускает обработку', async () => {
    const { service, prisma } = createHarness({ locked: false });

    await expect(service.tick()).resolves.toEqual({ processed: 0 });
    expect(prisma.scheduledAgentJob.findMany).not.toHaveBeenCalled();
  });

  it('тик с блокировкой запускает задачу и снимает лок', async () => {
    const { service, lock, chat } = createHarness();

    await expect(
      service.tick(new Date('2026-11-20T05:10:00Z')),
    ).resolves.toEqual({ processed: 1 });
    expect(chat.handleMessage).toHaveBeenCalledWith(
      USER_ID,
      expect.any(String),
      'Сделай сводку остатков',
    );
    expect(lock.release).toHaveBeenCalled();
  });

  it('executeJob сохраняет статус/выжимку и доставляет в Telegram', async () => {
    const { service, telegram, rows } = createHarness({ reply: 'Отчёт готов' });

    const result = await service.executeJob(JOB_ID);

    expect(result).toMatchObject({ jobId: JOB_ID, status: 'completed' });
    expect(result.summary).toBe('Отчёт готов');
    expect(telegram.sendText).toHaveBeenCalledWith(
      '100',
      'Отчёт готов',
      expect.objectContaining({ botToken: 'tg-token' }),
    );
    expect(rows.get(JOB_ID)).toMatchObject({
      lastRunStatus: 'completed',
      lastRunSummary: 'Отчёт готов',
    });
  });

  it('при ошибке агента задача помечается failed и не доставляется', async () => {
    const { service, telegram, rows } = createHarness({ throwOnChat: true });

    const result = await service.executeJob(JOB_ID);

    expect(result.status).toBe('failed');
    expect(telegram.sendText).not.toHaveBeenCalled();
    expect(rows.get(JOB_ID)?.lastRunStatus).toBe('failed');
  });

  it('создание валидирует cron и вычисляет nextRunAt', async () => {
    const { service } = createHarness();

    const created = await service.create(USER_ID, WORKSPACE_ID, {
      name: 'Утренняя сводка по остаткам',
      cronExpression: '30 8 * * 1-5',
      prompt: 'Проверь остатки и подготовь сводку',
    });

    expect(created.nextRunAt).toBeTruthy();
    expect(created.deliveryChannelType).toBe('none');
    await expect(
      service.create(USER_ID, WORKSPACE_ID, {
        name: 'Плохое расписание',
        cronExpression: 'bad cron',
        prompt: 'Сводка',
      }),
    ).rejects.toThrow();
  });

  it('run-now запускает задачу вне расписания', async () => {
    const { service, chat } = createHarness();

    await expect(
      service.runNow(USER_ID, WORKSPACE_ID, JOB_ID),
    ).resolves.toMatchObject({ status: 'completed' });
    expect(chat.handleMessage).toHaveBeenCalledTimes(1);
  });

  it('viewer не может создавать расписания', async () => {
    const { service, workspaces } = createHarness();
    workspaces.assertRole.mockImplementation(async () => {
      throw new Error('insufficient role');
    });

    await expect(
      service.create(USER_ID, WORKSPACE_ID, {
        name: 'Сводка',
        cronExpression: '* * * * *',
        prompt: 'Сводка остатков',
      }),
    ).rejects.toThrow();
  });
});

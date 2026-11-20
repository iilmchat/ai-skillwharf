import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ZodError } from 'zod';
import {
  createScheduledJobSchema,
  cronExpressionSchema,
  createWorkspaceSchedule,
  deleteWorkspaceSchedule,
  deliveryChannelTypeSchema,
  fetchWorkspaceSchedules,
  getCronPresetId,
  getSchedulesErrorKind,
  runScheduleNow,
  scheduledJobSchema,
  updateWorkspaceSchedule,
} from './schedules';

const { getMock, postMock, patchMock, deleteMock } = vi.hoisted(() => ({
  getMock: vi.fn(),
  postMock: vi.fn(),
  patchMock: vi.fn(),
  deleteMock: vi.fn(),
}));

vi.mock('./api', () => ({
  api: {
    get: getMock,
    post: postMock,
    patch: patchMock,
    delete: deleteMock,
  },
}));

const JOB = {
  id: 'job-1',
  workspaceId: 'ws-1',
  name: 'Утренняя сводка',
  cronExpression: '30 8 * * 1-5',
  timezone: 'Europe/Moscow',
  prompt: 'Собери сводку остатков и сделок',
  deliveryChannelType: 'telegram',
  deliveryChannelId: 'ch-1',
  deliveryChatId: null,
  isActive: true,
  nextRunAt: '2026-11-21T08:30:00.000Z',
  lastRunAt: '2026-11-20T08:30:00.000Z',
  lastRunStatus: 'completed',
  lastRunSummary: 'Остатки в норме',
  lastRunDurationMs: 1200,
  createdAt: '2026-11-01T10:00:00.000Z',
};

const FORM = {
  name: 'Утренняя сводка',
  cronExpression: '30 8 * * 1-5',
  timezone: 'Europe/Moscow',
  prompt: 'Собери сводку остатков и сделок',
  deliveryChannelType: 'telegram',
  deliveryChannelId: 'ch-1',
} as const;

describe('deliveryChannelTypeSchema', () => {
  it('принимает три канала доставки', () => {
    expect(deliveryChannelTypeSchema.parse('none')).toBe('none');
    expect(deliveryChannelTypeSchema.parse('telegram')).toBe('telegram');
    expect(deliveryChannelTypeSchema.parse('corporate')).toBe('corporate');
    expect(deliveryChannelTypeSchema.safeParse('email').success).toBe(false);
  });
});

describe('cronExpressionSchema', () => {
  it('принимает 5 полей с диапазонами, списками и шагами', () => {
    expect(cronExpressionSchema.parse('30 8 * * 1-5')).toBe('30 8 * * 1-5');
    expect(cronExpressionSchema.parse('*/15 9-18 * * 1,3,5')).toBe(
      '*/15 9-18 * * 1,3,5',
    );
    expect(cronExpressionSchema.parse('0 0 1 1 *')).toBe('0 0 1 1 *');
  });

  it('отклоняет неверное число полей и символы', () => {
    expect(cronExpressionSchema.safeParse('30 8 * *').success).toBe(false);
    expect(cronExpressionSchema.safeParse('30 8 * * * *').success).toBe(false);
    expect(cronExpressionSchema.safeParse('abc 8 * * *').success).toBe(false);
    expect(cronExpressionSchema.safeParse('').success).toBe(false);
  });

  it('распознаёт пресеты расписаний', () => {
    expect(getCronPresetId('30 8 * * 1-5')).toBe('weekdays_morning');
    expect(getCronPresetId('0 * * * *')).toBe('hourly');
    expect(getCronPresetId('0 9 * * 1')).toBe('monday_morning');
    expect(getCronPresetId('5 4 * * 0')).toBeNull();
  });
});

describe('scheduledJobSchema', () => {
  it('принимает задачу с историей выполнений', () => {
    expect(scheduledJobSchema.parse(JOB)).toEqual(JOB);
  });

  it('допускает отсутствие истории и канала доставки', () => {
    const parsed = scheduledJobSchema.parse({
      ...JOB,
      deliveryChannelId: null,
      lastRunAt: null,
      lastRunStatus: null,
      lastRunSummary: null,
      lastRunDurationMs: undefined,
    });

    expect(parsed.lastRunAt).toBeNull();
    expect(parsed.deliveryChannelId).toBeNull();
  });

  it('отклоняет невалидный статус и таймзону', () => {
    expect(
      scheduledJobSchema.safeParse({ ...JOB, lastRunStatus: 'running' })
        .success,
    ).toBe(false);
    expect(scheduledJobSchema.safeParse({ ...JOB, timezone: '' }).success).toBe(
      false,
    );
  });
});

describe('createScheduledJobSchema', () => {
  it('заполняет таймзону по умолчанию', () => {
    expect(
      createScheduledJobSchema.parse({
        name: FORM.name,
        cronExpression: FORM.cronExpression,
        prompt: FORM.prompt,
        deliveryChannelType: FORM.deliveryChannelType,
        deliveryChannelId: FORM.deliveryChannelId,
      }).timezone,
    ).toBe('Europe/Moscow');
  });

  it('требует канал для telegram и Chat ID для corporate', () => {
    expect(
      createScheduledJobSchema.safeParse({ ...FORM, deliveryChannelId: null })
        .success,
    ).toBe(false);
    expect(
      createScheduledJobSchema.safeParse({
        ...FORM,
        deliveryChannelType: 'corporate',
      }).success,
    ).toBe(false);
    expect(
      createScheduledJobSchema.parse({
        ...FORM,
        deliveryChannelType: 'corporate',
        deliveryChannelId: 'corp-1',
        deliveryChatId: '-100500',
      }).deliveryChatId,
    ).toBe('-100500');
  });

  it('не требует канал для none и проверяет длину имени', () => {
    expect(
      createScheduledJobSchema.safeParse({
        ...FORM,
        deliveryChannelType: 'none',
        deliveryChannelId: undefined,
      }).success,
    ).toBe(true);
    expect(createScheduledJobSchema.safeParse({ ...FORM, name: 'x' }).success).toBe(
      false,
    );
  });
});

describe('API-клиент расписаний', () => {
  beforeEach(() => {
    getMock.mockReset();
    postMock.mockReset();
    patchMock.mockReset();
    deleteMock.mockReset();
  });

  const BASE = '/workspaces/ws-1/schedules';

  it('читает список задач из массива и обёртки', async () => {
    getMock.mockResolvedValueOnce({ data: [JOB] });
    await expect(fetchWorkspaceSchedules('ws-1')).resolves.toEqual([JOB]);
    expect(getMock).toHaveBeenCalledWith(BASE);

    getMock.mockResolvedValueOnce({ data: { jobs: [JOB] } });
    await expect(fetchWorkspaceSchedules('ws-1')).resolves.toEqual([JOB]);
  });

  it('отбрасывает невалидный ответ', async () => {
    getMock.mockResolvedValueOnce({ data: [{ ...JOB, id: '' }] });

    await expect(fetchWorkspaceSchedules('ws-1')).rejects.toBeInstanceOf(
      ZodError,
    );
  });

  it('создаёт задачу валидированным запросом', async () => {
    postMock.mockResolvedValueOnce({ data: JOB });

    await expect(createWorkspaceSchedule('ws-1', FORM)).resolves.toEqual(JOB);
    expect(postMock).toHaveBeenCalledWith(BASE, {
      ...FORM,
      timezone: 'Europe/Moscow',
    });
  });

  it('обновляет активность и удаляет задачу', async () => {
    patchMock.mockResolvedValueOnce({ data: { ...JOB, isActive: false } });
    deleteMock.mockResolvedValueOnce({ data: { id: 'job-1' } });

    await updateWorkspaceSchedule('ws-1', 'job/1', { isActive: false });
    expect(patchMock).toHaveBeenCalledWith(`${BASE}/job%2F1`, {
      isActive: false,
    });

    await expect(deleteWorkspaceSchedule('ws-1', 'job-1')).resolves.toBeUndefined();
    expect(deleteMock).toHaveBeenCalledWith(`${BASE}/job-1`);
  });

  it('запускает задачу сейчас', async () => {
    postMock.mockResolvedValueOnce({
      data: { runId: 'run-1', status: 'queued' },
    });

    await expect(runScheduleNow('ws-1', 'job-1')).resolves.toMatchObject({
      runId: 'run-1',
    });
    expect(postMock).toHaveBeenCalledWith(`${BASE}/job-1/run-now`);
  });

  it('не отправляет невалидную форму и определяет ошибки', async () => {
    await expect(
      createWorkspaceSchedule('ws-1', { ...FORM, cronExpression: '* * *' }),
    ).rejects.toBeInstanceOf(ZodError);
    expect(postMock).not.toHaveBeenCalled();
    expect(getSchedulesErrorKind(new ZodError([]))).toBe('invalid');
    expect(
      getSchedulesErrorKind({
        isAxiosError: true,
        response: { status: 404 },
      }),
    ).toBe('unavailable');
  });
});

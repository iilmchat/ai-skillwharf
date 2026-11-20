import { isAxiosError } from 'axios';
import { z } from 'zod';
import { api } from './api';

/**
 * Контракт планировщика автономных задач (Sprint 43, CRON-43.3).
 *
 * Все ответы проверяются Zod: UI не показывает вымышленные расписания, если
 * backend изменил формат. Cron — классические 5 полей (минута, час, день
 * месяца, месяц, день недели).
 */
export const SCHEDULES_ENDPOINT = '/schedules';

export const deliveryChannelTypeSchema = z.enum([
  'none',
  'telegram',
  'corporate',
]);

export type DeliveryChannelType = z.infer<typeof deliveryChannelTypeSchema>;

/** Одно поле 5-полевого cron: `*`, число, диапазон, список и шаг. */
const CRON_FIELD = /^(\*|\d+|\d+-\d+)(?:\/\d+)?(?:,(\*|\d+|\d+-\d+)(?:\/\d+)?)*$/;

export const cronExpressionSchema = z.string().trim().refine(
  (value) => {
    const parts = value.split(/\s+/);

    return parts.length === 5 && parts.every((part) => CRON_FIELD.test(part));
  },
  { message: 'ожидается cron из 5 полей' },
);

export const scheduledJobSchema = z.object({
  id: z.string().min(1),
  workspaceId: z.string().min(1),
  name: z.string().min(1),
  cronExpression: z.string().min(1),
  timezone: z.string().min(1),
  prompt: z.string(),
  deliveryChannelType: deliveryChannelTypeSchema,
  deliveryChannelId: z.string().nullable().optional(),
  deliveryChatId: z.string().nullable().optional(),
  isActive: z.boolean(),
  nextRunAt: z.string(),
  lastRunAt: z.string().nullable().optional(),
  lastRunStatus: z.enum(['completed', 'failed']).nullable().optional(),
  lastRunSummary: z.string().nullable().optional(),
  /** Длительность последнего запуска, если API её присылает. */
  lastRunDurationMs: z.number().nonnegative().optional(),
  createdAt: z.string(),
});

export type ScheduledJob = z.infer<typeof scheduledJobSchema>;

export const scheduledJobListSchema = z
  .union([
    z.array(scheduledJobSchema),
    z.object({ items: z.array(scheduledJobSchema) }),
    z.object({ jobs: z.array(scheduledJobSchema) }),
    z.object({ schedules: z.array(scheduledJobSchema) }),
  ])
  .transform((value) =>
    Array.isArray(value)
      ? value
      : 'items' in value
        ? value.items
        : 'jobs' in value
          ? value.jobs
          : value.schedules,
  );

export const CRON_PRESETS = {
  weekdays_morning: { cronExpression: '30 8 * * 1-5', timezone: 'Europe/Moscow' },
  hourly: { cronExpression: '0 * * * *', timezone: 'Europe/Moscow' },
  monday_morning: { cronExpression: '0 9 * * 1', timezone: 'Europe/Moscow' },
} as const;

export type CronPresetId = keyof typeof CRON_PRESETS;

/** Возвращает id пресета для точного совпадения cron — для подписи в списке. */
export function getCronPresetId(expression: string): CronPresetId | null {
  const found = (
    Object.keys(CRON_PRESETS) as readonly CronPresetId[]
  ).find((id) => CRON_PRESETS[id].cronExpression === expression.trim());

  return found ?? null;
}

const createScheduledJobBaseSchema = z.object({
  name: z.string().trim().min(2).max(120),
  cronExpression: cronExpressionSchema,
  timezone: z.string().trim().min(1).max(64).optional(),
  prompt: z.string().trim().min(10).max(4_000),
  deliveryChannelType: deliveryChannelTypeSchema,
  deliveryChannelId: z.string().nullable().optional(),
  deliveryChatId: z.string().trim().max(128).nullable().optional(),
});

export const createScheduledJobSchema =
  createScheduledJobBaseSchema.superRefine((value, context) => {
    if (
      value.deliveryChannelType !== 'none' &&
      (value.deliveryChannelId === undefined ||
        value.deliveryChannelId === null ||
        value.deliveryChannelId === '')
    ) {
      context.addIssue({
        code: 'custom',
        path: ['deliveryChannelId'],
        message: 'нужен канал доставки',
      });
    }

    if (
      value.deliveryChannelType === 'corporate' &&
      (value.deliveryChatId === undefined ||
        value.deliveryChatId === null ||
        value.deliveryChatId === '')
    ) {
      context.addIssue({
        code: 'custom',
        path: ['deliveryChatId'],
        message: 'нужен Chat ID',
      });
    }
  })
  .transform((value) => ({
    ...value,
    timezone: value.timezone ?? 'Europe/Moscow',
  }));

export const updateScheduledJobSchema =
  createScheduledJobBaseSchema.partial().extend({
    isActive: z.boolean().optional(),
  });

export type CreateScheduledJobInput = z.input<
  typeof createScheduledJobSchema
>;
export type UpdateScheduledJobInput = z.infer<
  typeof updateScheduledJobSchema
>;

/** Ответ `run-now`: API может вернуть задачу или сводку запуска. */
export const runNowResponseSchema = z
  .object({
    id: z.string().optional(),
    runId: z.string().optional(),
    status: z.string().optional(),
  })
  .passthrough();

export type RunNowResponse = z.infer<typeof runNowResponseSchema>;

export const schedulesQueryKey = (workspaceId: string) =>
  ['schedules', workspaceId] as const;

function schedulesUrl(workspaceId: string): string {
  return `/workspaces/${encodeURIComponent(workspaceId)}${SCHEDULES_ENDPOINT}`;
}

function jobUrl(workspaceId: string, jobId: string): string {
  return `${schedulesUrl(workspaceId)}/${encodeURIComponent(jobId)}`;
}

export async function fetchWorkspaceSchedules(
  workspaceId: string,
): Promise<ScheduledJob[]> {
  const { data } = await api.get<unknown>(schedulesUrl(workspaceId));

  return scheduledJobListSchema.parse(data);
}

export async function createWorkspaceSchedule(
  workspaceId: string,
  payload: CreateScheduledJobInput,
): Promise<ScheduledJob> {
  const request = createScheduledJobSchema.parse(payload);
  const { data } = await api.post<unknown>(schedulesUrl(workspaceId), request);

  return scheduledJobSchema.parse(data);
}

export async function updateWorkspaceSchedule(
  workspaceId: string,
  jobId: string,
  payload: UpdateScheduledJobInput,
): Promise<ScheduledJob> {
  const request = updateScheduledJobSchema.parse(payload);
  const { data } = await api.patch<unknown>(jobUrl(workspaceId, jobId), request);

  return scheduledJobSchema.parse(data);
}

export async function deleteWorkspaceSchedule(
  workspaceId: string,
  jobId: string,
): Promise<void> {
  await api.delete(jobUrl(workspaceId, jobId));
}

export async function runScheduleNow(
  workspaceId: string,
  jobId: string,
): Promise<RunNowResponse> {
  const { data } = await api.post<unknown>(
    `${jobUrl(workspaceId, jobId)}/run-now`,
  );

  return runNowResponseSchema.parse(data);
}

export type SchedulesErrorKind =
  | 'network'
  | 'unavailable'
  | 'invalid'
  | 'forbidden'
  | 'unknown';

export function getSchedulesErrorKind(error: unknown): SchedulesErrorKind {
  if (error instanceof z.ZodError) {
    return 'invalid';
  }

  if (isAxiosError(error)) {
    if (error.response === undefined) {
      return 'network';
    }

    if (error.response.status === 403) {
      return 'forbidden';
    }

    if (error.response.status === 404 || error.response.status === 501) {
      return 'unavailable';
    }
  }

  return 'unknown';
}

import { z } from 'zod';
import { cronExpressionSchema } from './cron.js';

export const deliveryChannelTypeSchema = z.enum([
  'none',
  'telegram',
  'corporate',
]);
export type DeliveryChannelType = z.infer<typeof deliveryChannelTypeSchema>;

const timezoneSchema = z
  .string()
  .trim()
  .min(1)
  .max(64)
  .refine((value) => {
    try {
      new Intl.DateTimeFormat('en-US', { timeZone: value });

      return true;
    } catch {
      return false;
    }
  }, 'неизвестный часовой пояс IANA');

/** POST /workspaces/:workspaceId/schedules. */
export const createScheduledJobSchema = z
  .object({
    name: z.string().trim().min(2).max(120),
    cronExpression: cronExpressionSchema,
    timezone: timezoneSchema.default('Europe/Moscow'),
    prompt: z.string().trim().min(5).max(8_000),
    deliveryChannelType: deliveryChannelTypeSchema.default('none'),
    deliveryChannelId: z.string().trim().min(1).max(128).optional(),
    deliveryChatId: z.string().trim().min(1).max(128).optional(),
  })
  .strict()
  .refine(
    (value) =>
      value.deliveryChannelType === 'none' ||
      value.deliveryChannelId !== undefined,
    {
      message: 'deliveryChannelId обязателен при доставке в канал',
      path: ['deliveryChannelId'],
    },
  );
export type CreateScheduledJobInput = z.infer<
  typeof createScheduledJobSchema
>;

/** PATCH /workspaces/:workspaceId/schedules/:jobId. */
export const updateScheduledJobSchema = z
  .object({
    name: z.string().trim().min(2).max(120).optional(),
    cronExpression: cronExpressionSchema.optional(),
    timezone: timezoneSchema.optional(),
    prompt: z.string().trim().min(5).max(8_000).optional(),
    deliveryChannelType: deliveryChannelTypeSchema.optional(),
    deliveryChannelId: z.string().trim().min(1).max(128).nullish(),
    deliveryChatId: z.string().trim().min(1).max(128).nullish(),
    isActive: z.boolean().optional(),
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0, {
    message: 'укажите хотя бы одно поле',
  });
export type UpdateScheduledJobInput = z.infer<
  typeof updateScheduledJobSchema
>;

export const scheduledJobViewSchema = z.object({
  id: z.string(),
  workspaceId: z.string(),
  userId: z.string(),
  name: z.string(),
  cronExpression: z.string(),
  timezone: z.string(),
  prompt: z.string(),
  deliveryChannelType: deliveryChannelTypeSchema,
  deliveryChannelId: z.string().nullable(),
  deliveryChatId: z.string().nullable(),
  isActive: z.boolean(),
  nextRunAt: z.string(),
  lastRunAt: z.string().nullable(),
  lastRunStatus: z.enum(['completed', 'failed']).nullable(),
  lastRunSummary: z.string().nullable(),
  createdAt: z.string(),
});
export type ScheduledJobView = z.infer<typeof scheduledJobViewSchema>;

export const jobRunResultSchema = z.object({
  jobId: z.string(),
  status: z.enum(['completed', 'failed']),
  summary: z.string(),
  nextRunAt: z.string(),
});
export type JobRunResult = z.infer<typeof jobRunResultSchema>;

import {
  Injectable,
  Logger,
  NotFoundException,
  OnModuleDestroy,
  Optional,
} from '@nestjs/common';
import type { ScheduledAgentJob } from '@prisma/client';
import { policyBlockedError } from '../common/api-error.js';
import { ChatService } from '../chat/chat.service.js';
import { CorpChannelsService } from '../channels/corp-channels.service.js';
import { TelegramChannelsService } from '../channels/telegram-channels.service.js';
import { TelegramService } from '../integrations/telegram/telegram.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { WorkspacesService } from '../workspaces/workspaces.service.js';
import { computeNextCronRun } from './cron.js';
import {
  createScheduledJobSchema,
  jobRunResultSchema,
  scheduledJobViewSchema,
  updateScheduledJobSchema,
  type JobRunResult,
  type ScheduledJobView,
} from './schedule.schemas.js';
import {
  createSchedulerLock,
  type ISchedulerLock,
} from './scheduler-lock.js';

export const DEFAULT_SCHEDULER_POLL_MS = 30_000;
const SUMMARY_LIMIT = 500;
const MEMBER_ROLES = new Set(['owner', 'admin', 'operator', 'viewer']);

function pollIntervalMs(env: NodeJS.ProcessEnv): number {
  const raw = Number.parseInt(env.SCHEDULER_POLL_MS ?? '', 10);

  return Number.isInteger(raw) && raw >= 0 ? raw : DEFAULT_SCHEDULER_POLL_MS;
}

/**
 * Планировщик автономных задач агентов (CRON-43.1/43.2).
 * Тик защищён распределённой блокировкой Redis для HA-кластера.
 */
@Injectable()
export class ScheduledJobsService implements OnModuleDestroy {
  private readonly logger = new Logger(ScheduledJobsService.name);
  private readonly timer: NodeJS.Timeout | null = null;
  private readonly lock: ISchedulerLock;

  constructor(
    private readonly prisma: PrismaService,
    private readonly chat: ChatService,
    private readonly workspaces: WorkspacesService,
    @Optional() private readonly telegramChannels?: TelegramChannelsService,
    @Optional() private readonly corpChannels?: CorpChannelsService,
    @Optional() private readonly telegram?: TelegramService,
    @Optional() env: NodeJS.ProcessEnv = process.env,
    @Optional() lock?: ISchedulerLock,
  ) {
    this.lock = lock ?? createSchedulerLock(env);
    const interval = pollIntervalMs(env);

    if (interval > 0) {
      this.timer = setInterval(() => {
        void this.tick().catch((error: unknown) => {
          this.logger.warn(`ошибка тикера планировщика: ${String(error)}`);
        });
      }, interval);
      this.timer.unref();
    }
  }

  onModuleDestroy(): void {
    if (this.timer !== null) {
      clearInterval(this.timer);
    }
  }

  /** Один тик: только реплика, захватившая блокировку, обрабатывает задачи. */
  async tick(now: Date = new Date()): Promise<{ processed: number }> {
    const acquired = await this.lock.acquire();

    if (!acquired) {
      return { processed: 0 };
    }

    try {
      const due = await this.prisma.scheduledAgentJob.findMany({
        where: { isActive: true, nextRunAt: { lte: now } },
        orderBy: { nextRunAt: 'asc' },
        take: 50,
      });

      for (const job of due) {
        try {
          await this.executeJob(job.id);
        } catch (error) {
          this.logger.warn(
            `задача ${job.id} завершилась ошибкой: ${String(error)}`,
          );
        }
      }

      return { processed: due.length };
    } finally {
      await this.lock.release().catch((error: unknown) => {
        this.logger.warn(`не удалось снять блокировку: ${String(error)}`);
      });
    }
  }

  async list(
    userId: string,
    workspaceId: string,
  ): Promise<ScheduledJobView[]> {
    await this.assertRole(userId, workspaceId, MEMBER_ROLES);
    const rows = await this.prisma.scheduledAgentJob.findMany({
      where: { workspaceId },
      orderBy: { createdAt: 'desc' },
    });

    return rows.map((row) => this.toView(row));
  }

  async create(
    userId: string,
    workspaceId: string,
    raw: unknown,
  ): Promise<ScheduledJobView> {
    await this.assertRole(userId, workspaceId, this.workspaces.payingRoles());
    const input = createScheduledJobSchema.parse(raw);
    const now = new Date();
    const row = await this.prisma.scheduledAgentJob.create({
      data: {
        workspaceId,
        userId,
        name: input.name,
        cronExpression: input.cronExpression,
        timezone: input.timezone,
        prompt: input.prompt,
        deliveryChannelType: input.deliveryChannelType,
        deliveryChannelId: input.deliveryChannelId ?? null,
        deliveryChatId: input.deliveryChatId ?? null,
        nextRunAt: computeNextCronRun(
          input.cronExpression,
          input.timezone,
          now,
        ),
      },
    });

    return this.toView(row);
  }

  async update(
    userId: string,
    workspaceId: string,
    jobId: string,
    raw: unknown,
  ): Promise<ScheduledJobView> {
    await this.assertRole(userId, workspaceId, this.workspaces.payingRoles());
    const input = updateScheduledJobSchema.parse(raw);
    const current = await this.findInWorkspace(workspaceId, jobId);
    const cronChanged =
      input.cronExpression !== undefined || input.timezone !== undefined;
    const row = await this.prisma.scheduledAgentJob.update({
      where: { id: jobId },
      data: {
        ...input,
        deliveryChannelId:
          input.deliveryChannelId === undefined
            ? undefined
            : input.deliveryChannelId,
        deliveryChatId:
          input.deliveryChatId === undefined ? undefined : input.deliveryChatId,
        ...(cronChanged
          ? {
              nextRunAt: computeNextCronRun(
                input.cronExpression ?? current.cronExpression,
                input.timezone ?? current.timezone,
                new Date(),
              ),
            }
          : {}),
      },
    });

    return this.toView(row);
  }

  async remove(
    userId: string,
    workspaceId: string,
    jobId: string,
  ): Promise<{ id: string }> {
    await this.assertRole(userId, workspaceId, this.workspaces.payingRoles());
    await this.findInWorkspace(workspaceId, jobId);
    await this.prisma.scheduledAgentJob.delete({ where: { id: jobId } });

    return { id: jobId };
  }

  /** Внеочередной запуск с проверкой доступа к воркспейсу. */
  async runNow(
    userId: string,
    workspaceId: string,
    jobId: string,
  ): Promise<JobRunResult> {
    await this.assertRole(userId, workspaceId, this.workspaces.payingRoles());
    await this.findInWorkspace(workspaceId, jobId);

    return this.executeJob(jobId);
  }

  /** Запускает задачу и сохраняет результат; доставка — best effort. */
  async executeJob(jobId: string): Promise<JobRunResult> {
    const job = await this.prisma.scheduledAgentJob.findUnique({
      where: { id: jobId },
    });

    if (job === null) {
      throw new NotFoundException('Расписание не найдено');
    }

    let status: 'completed' | 'failed' = 'completed';
    let summary = '';

    try {
      const conversation = await this.prisma.conversation.create({
        data: { userId: job.userId, title: job.name },
        select: { id: true },
      });
      const reply = await this.chat.handleMessage(
        job.userId,
        conversation.id,
        job.prompt,
      );

      summary = reply.reply.trim().slice(0, SUMMARY_LIMIT);
    } catch (error) {
      status = 'failed';
      summary = (error instanceof Error ? error.message : String(error)).slice(
        0,
        SUMMARY_LIMIT,
      );
    }

    const now = new Date();
    const nextRunAt = computeNextCronRun(
      job.cronExpression,
      job.timezone,
      now,
    );
    await this.prisma.scheduledAgentJob.update({
      where: { id: jobId },
      data: {
        lastRunAt: now,
        lastRunStatus: status,
        lastRunSummary: summary,
        nextRunAt,
      },
    });

    if (status === 'completed' && job.deliveryChannelType !== 'none') {
      await this.deliver(job, summary).catch((error: unknown) => {
        this.logger.warn(`доставка результата не удалась: ${String(error)}`);
      });
    }

    return jobRunResultSchema.parse({
      jobId,
      status,
      summary,
      nextRunAt: nextRunAt.toISOString(),
    });
  }

  private async deliver(job: ScheduledAgentJob, text: string): Promise<void> {
    const chatId = job.deliveryChatId ?? '';

    if (job.deliveryChannelType === 'telegram') {
      if (
        this.telegramChannels === undefined ||
        this.telegram === undefined ||
        job.deliveryChannelId === null
      ) {
        return;
      }

      const channel = await this.telegramChannels.findForWebhook(
        job.deliveryChannelId,
      );

      if (channel === null || !channel.isActive) {
        return;
      }

      const target = chatId === '' ? channel.allowedChatIds[0] : chatId;

      if (target === undefined) {
        return;
      }

      await this.telegram.sendText(target, text, {
        botToken: this.telegramChannels.decryptToken(channel),
      });

      return;
    }

    if (this.corpChannels === undefined || job.deliveryChannelId === null) {
      return;
    }

    const channel = await this.corpChannels.findForWebhook(
      job.deliveryChannelId,
    );

    if (channel === null || !channel.isActive) {
      return;
    }

    const target = chatId === '' ? channel.allowedChatIds[0] : chatId;

    if (target === undefined) {
      return;
    }

    await this.corpChannels.adapters.get(channel.provider).sendTextMessage({
      baseUrl: channel.apiBaseUrl,
      token: this.corpChannels.decryptToken(channel),
      chatId: target,
      text,
    });
  }

  private async assertRole(
    userId: string,
    workspaceId: string,
    allowed: ReadonlySet<string>,
  ): Promise<void> {
    const active = await this.workspaces.resolveActive(userId, workspaceId);

    if (active === null) {
      throw policyBlockedError('Нет доступа к воркспейсу');
    }

    await this.workspaces.assertRole(
      userId,
      allowed as Parameters<WorkspacesService['assertRole']>[1],
      workspaceId,
    );
  }

  private async findInWorkspace(
    workspaceId: string,
    jobId: string,
  ): Promise<ScheduledAgentJob> {
    const row = await this.prisma.scheduledAgentJob.findFirst({
      where: { id: jobId, workspaceId },
    });

    if (row === null) {
      throw new NotFoundException('Расписание не найдено');
    }

    return row;
  }

  private toView(row: ScheduledAgentJob): ScheduledJobView {
    return scheduledJobViewSchema.parse({
      id: row.id,
      workspaceId: row.workspaceId,
      userId: row.userId,
      name: row.name,
      cronExpression: row.cronExpression,
      timezone: row.timezone,
      prompt: row.prompt,
      deliveryChannelType: row.deliveryChannelType,
      deliveryChannelId: row.deliveryChannelId,
      deliveryChatId: row.deliveryChatId,
      isActive: row.isActive,
      nextRunAt: row.nextRunAt.toISOString(),
      lastRunAt: row.lastRunAt?.toISOString() ?? null,
      lastRunStatus: row.lastRunStatus === null ? null : row.lastRunStatus,
      lastRunSummary: row.lastRunSummary,
      createdAt: row.createdAt.toISOString(),
    });
  }
}

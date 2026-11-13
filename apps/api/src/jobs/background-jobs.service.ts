import {
  Injectable,
  Logger,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import { Queue, Worker, type Job } from 'bullmq';
import { Redis } from 'ioredis';
import { CheckpointRetentionService } from '../chat/persistence/checkpoint-retention.service.js';
import {
  ExpiredApprovalsService,
  resolveExpiryCheckIntervalMs,
} from '../chat/persistence/expired-approvals.service.js';
import { resolveRetentionCheckIntervalMs } from '../chat/persistence/checkpoint-retention.service.js';

export const MAINTENANCE_QUEUE = 'agent-maintenance';
export const NOTIFICATION_QUEUE = 'agent-notifications';

export type MaintenanceJobName = 'hitl-expiry' | 'checkpoint-retention';

export interface ApprovalNotification {
  conversationId: string;
  userId: string;
  reason: 'approval' | 'payment';
  tools: string[];
}

/**
 * BullMQ-очереди фоновых задач API.
 *
 * HITL TTL и retention выполняются повторяющимися job'ами; уведомления об
 * ожидающем подтверждении — обычные job'ы с ретраями. Без `REDIS_URL`
 * сервисы остаются на прежних setInterval-таймерах (dev/тесты).
 */
@Injectable()
export class BackgroundJobsService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(BackgroundJobsService.name);
  private queue: Queue | null = null;
  private notifications: Queue | null = null;
  private worker: Worker | null = null;
  private notificationsWorker: Worker | null = null;
  private redis: Redis | null = null;

  constructor(
    private readonly expiredApprovals: ExpiredApprovalsService,
    private readonly retention: CheckpointRetentionService,
  ) {}

  isEnabled(): boolean {
    return this.queue !== null;
  }

  onModuleInit(): void {
    const redisUrl = process.env.REDIS_URL?.trim() ?? '';

    if (redisUrl === '') {
      this.logger.log(
        'REDIS_URL не задан: BullMQ выключен, работают setInterval-таймеры',
      );

      return;
    }

    this.redis = new Redis(redisUrl, {
      maxRetriesPerRequest: null,
      lazyConnect: false,
    });

    this.queue = new Queue(MAINTENANCE_QUEUE, { connection: this.redis });
    this.notifications = new Queue(NOTIFICATION_QUEUE, {
      connection: this.redis,
    });
    this.worker = new Worker(
      MAINTENANCE_QUEUE,
      async (job: Job) => this.processMaintenance(job),
      { connection: this.redis },
    );
    this.notificationsWorker = new Worker(
      NOTIFICATION_QUEUE,
      async (job: Job) => this.processNotification(job),
      { connection: this.redis },
    );

    this.worker.on('failed', (job, error) => {
      this.logger.error(
        `Job ${job?.name ?? 'unknown'} упал: ${error.message}`,
      );
    });
    this.notificationsWorker.on('failed', (job, error) => {
      this.logger.error(
        `Notification job ${job?.name ?? 'unknown'} упал: ${error.message}`,
      );
    });

    const expiryEvery = resolveExpiryCheckIntervalMs();
    const retentionEvery = resolveRetentionCheckIntervalMs();

    void this.schedule('hitl-expiry', expiryEvery).catch((error: unknown) => {
      this.logger.error(`Не удалось запланировать hitl-expiry: ${describe(error)}`);
    });
    void this.schedule('checkpoint-retention', retentionEvery).catch(
      (error: unknown) => {
        this.logger.error(
          `Не удалось запланировать checkpoint-retention: ${describe(error)}`,
        );
      },
    );

    this.logger.log(
      `BullMQ запущен: hitl-expiry ${expiryEvery} мс, retention ${retentionEvery} мс`,
    );
  }

  async onModuleDestroy(): Promise<void> {
    await this.worker?.close();
    await this.notificationsWorker?.close();
    await this.queue?.close();
    await this.notifications?.close();
    await this.redis?.quit();
  }

  /** Уведомление о новом ожидании одобрения (канал пока лог). */
  async notifyApprovalPending(payload: ApprovalNotification): Promise<void> {
    if (this.notifications === null) {
      this.logger.log(
        JSON.stringify({
          event: 'hitl.notification_pending',
          ...payload,
        }),
      );

      return;
    }

    await this.notifications.add('approval-pending', payload, {
      attempts: 3,
      backoff: { type: 'exponential', delay: 5_000 },
      removeOnComplete: 100,
      removeOnFail: 1_000,
    });
  }

  private async schedule(name: MaintenanceJobName, every: number): Promise<void> {
    if (this.queue === null) {
      return;
    }

    // Job Scheduler — единственный владелец расписания в Redis. Повторный
    // `upsertJobScheduler` из другой реплики обновляет тот же ключ, поэтому
    // тик выполняет один воркер (Redis-lock). Первую итерацию BullMQ
    // планирует на текущий момент сам, поэтому отдельный bootstrap-job не
    // нужен: он дал бы второй тик на старте и по job'у на каждую реплику.
    await this.queue.upsertJobScheduler(name, { every }, { name, data: {} });
  }

  private async processMaintenance(job: Job): Promise<unknown> {
    switch (job.name) {
      case 'hitl-expiry':
        return this.expiredApprovals.tick();
      case 'checkpoint-retention':
        return this.retention.tick();
      default:
        this.logger.warn(`Неизвестный maintenance job: ${job.name}`);

        return null;
    }
  }

  private processNotification(job: Job): unknown {
    this.logger.log(
      JSON.stringify({
        event: 'hitl.approval_notification',
        ...(job.data as Record<string, unknown>),
      }),
    );

    return null;
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

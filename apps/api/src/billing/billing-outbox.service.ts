import {
  Injectable,
  Logger,
  OnModuleDestroy,
  Optional,
} from '@nestjs/common';
import type { BillingOutbox } from '@prisma/client';
import { z } from 'zod';
import { PrismaService } from '../prisma/prisma.service.js';
import { YooKassaProvider } from './providers/yookassa.provider.js';

/** Пayload выплаты автору: всё внешнее валидируется Zod. */
export const outboxPayloadSchema = z.object({
  payoutAccountId: z.string().min(1).max(256),
  amountRub: z.coerce.number().positive(),
  skillName: z.string().min(1).max(256),
  description: z.string().max(128).optional(),
});

export type OutboxPayload = z.infer<typeof outboxPayloadSchema>;

export interface OutboxStats {
  readonly pending: number;
  readonly sent: number;
  readonly failedDead: number;
}

export const DEFAULT_OUTBOX_POLL_MS = 15_000;
export const OUTBOX_BACKOFF_BASE_MS = 30_000;

function pollIntervalMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = Number.parseInt(env.BILLING_OUTBOX_POLL_MS ?? '', 10);

  return Number.isInteger(raw) && raw >= 0 ? raw : DEFAULT_OUTBOX_POLL_MS;
}

/**
 * Transactional Outbox (Sprint 33 / OUTBOX-33.1, KI-087).
 *
 * Задача на выплату создаётся в транзакции списания; воркер доставляет её
 * внешнему провайдеру с идемпотентным ключом и экспоненциальным backoff.
 */
@Injectable()
export class BillingOutboxService implements OnModuleDestroy {
  private readonly logger = new Logger(BillingOutboxService.name);
  private readonly timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly yookassa: YooKassaProvider,
    @Optional() env: NodeJS.ProcessEnv = process.env,
  ) {
    const interval = pollIntervalMs(env);

    if (interval > 0) {
      this.timer = setInterval(() => {
        void this.processPendingBatch().catch((error: unknown) => {
          this.logger.warn(`outbox tick: ${String(error)}`);
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

  /** Статистика и последние записи Outbox для админ-эндпоинта. */
  async stats(): Promise<OutboxStats> {
    const [pending, sent, failedDead] = await Promise.all([
      this.prisma.billingOutbox.count({ where: { status: 'pending' } }),
      this.prisma.billingOutbox.count({ where: { status: 'sent' } }),
      this.prisma.billingOutbox.count({ where: { status: 'failed_dead' } }),
    ]);

    return { pending, sent, failedDead };
  }

  async recent(limit = 20): Promise<readonly BillingOutbox[]> {
    return this.prisma.billingOutbox.findMany({
      orderBy: { createdAt: 'desc' },
      take: Math.max(1, Math.min(limit, 100)),
    });
  }

  async retryDeadLetter(id: string): Promise<BillingOutbox> {
    const row = await this.prisma.billingOutbox.findUnique({ where: { id } });

    if (row === null || row.status !== 'failed_dead') {
      throw new Error(`Outbox-задача ${id} не находится в failed_dead`);
    }

    return this.prisma.billingOutbox.update({
      where: { id },
      data: {
        status: 'pending',
        attempts: 0,
        nextRetryAt: new Date(),
        lastError: null,
      },
    });
  }

  /**
   * Атомарно берёт созревшие задачи, отправляет перевод и обновляет статус.
   * Ошибка одной задачи не останавливает остальные.
   */
  async processPendingBatch(limit = 20): Promise<{
    processed: number;
    sent: number;
    retried: number;
    dead: number;
  }> {
    const rows = await this.prisma.billingOutbox.findMany({
      where: { status: 'pending', nextRetryAt: { lte: new Date() } },
      orderBy: { nextRetryAt: 'asc' },
      take: Math.max(1, Math.min(limit, 100)),
    });
    const result = { processed: 0, sent: 0, retried: 0, dead: 0 };

    for (const row of rows) {
      const claimed = await this.prisma.billingOutbox.updateMany({
        where: { id: row.id, status: 'pending' },
        data: { status: 'processing' },
      });

      if (claimed.count === 0) {
        continue;
      }

      result.processed += 1;

      try {
        const payload = outboxPayloadSchema.parse(
          JSON.parse(JSON.stringify(row.payloadJson)) as unknown,
        );
        await this.yookassa.createTransfer(
          payload.payoutAccountId,
          payload.amountRub,
          row.idempotencyKey,
          payload.description ?? payload.skillName,
        );
        await this.prisma.billingOutbox.update({
          where: { id: row.id },
          data: { status: 'sent', sentAt: new Date(), lastError: null },
        });
        result.sent += 1;
      } catch (error) {
        const attempts = row.attempts + 1;
        const dead = attempts >= row.maxAttempts;
        const nextRetryAt = new Date(
          Date.now() + backoffMs(attempts),
        );

        await this.prisma.billingOutbox.update({
          where: { id: row.id },
          data: {
            status: dead ? 'failed_dead' : 'pending',
            attempts,
            nextRetryAt,
            lastError: error instanceof Error ? error.message : String(error),
          },
        });

        if (dead) {
          result.dead += 1;
        } else {
          result.retried += 1;
        }
      }
    }

    return result;
  }
}

/** Exponential backoff: `2^attempts * 30s`. */
export function backoffMs(attempts: number): number {
  const exponent = Math.max(0, Math.min(attempts, 10));

  return OUTBOX_BACKOFF_BASE_MS * 2 ** exponent;
}

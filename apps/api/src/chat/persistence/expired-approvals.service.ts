import {
  Injectable,
  Logger,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import { BillingService } from '../../billing/billing.service.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import { CheckpointStoreService } from '../../agent/checkpoint-store.service.js';
import {
  PendingApprovalHoldsSchema,
  PendingApprovalService,
  type PendingApprovalHold,
} from './pending-approval.service.js';
import { readPositiveEnvNumber } from './persistence-env.js';

/** Интервал проверки просроченных HITL-ожиданий по умолчанию: 5 минут. */
export const DEFAULT_EXPIRY_CHECK_INTERVAL_MS = 5 * 60 * 1000;

/** Сколько просроченных записей обрабатываем за один тик. */
export const EXPIRED_APPROVALS_BATCH_SIZE = 100;

const logger = new Logger('ExpiredApprovalsService');

/** Зависимости тика — узкие интерфейсы, чтобы тесты подставляли двойники. */
export interface ExpiredApprovalsDeps {
  prisma: Pick<PrismaService, 'pendingApproval'>;
  pendingApprovals: Pick<PendingApprovalService, 'resolvePending'>;
  checkpointer: Pick<CheckpointStoreService, 'deleteThread'>;
  billing: Pick<BillingService, 'cancelHold'>;
}

/** Итог одного тика: сколько ожиданий закрыто и hold'ов отменено. */
export interface ExpiredApprovalsResult {
  expired: number;
  holdsCancelled: number;
}

/** Интервал опроса `HITL_EXPIRY_CHECK_INTERVAL_MS` (мс). */
export function resolveExpiryCheckIntervalMs(
  env: NodeJS.ProcessEnv = process.env,
): number {
  return readPositiveEnvNumber(
    env.HITL_EXPIRY_CHECK_INTERVAL_MS,
    DEFAULT_EXPIRY_CHECK_INTERVAL_MS,
  );
}

/**
 * Закрывает просроченные HITL-ожидания (KI-033).
 *
 * Для каждой записи со статусом `pending` и `expiresAt < now`:
 * 1) отменяет зарезервированные escrow-hold'ы (best-effort: ошибка одного
 *    hold'а не мешает остальным и не мешает закрыть ожидание);
 * 2) удаляет checkpoint'ы треда — граф уже не возобновить, состояние не нужно;
 * 3) переводит запись в статус `expired`;
 * 4) пишет JSON-лог `hitl.approval_expired`.
 *
 * Граф не возобновляется. Ошибка обработки одной записи логируется и не
 * останавливает остальные.
 */
export async function expireOverdueApprovals(
  deps: ExpiredApprovalsDeps,
  now: Date,
): Promise<ExpiredApprovalsResult> {
  const overdue = await deps.prisma.pendingApproval.findMany({
    where: { status: 'pending', expiresAt: { lt: now } },
    take: EXPIRED_APPROVALS_BATCH_SIZE,
  });

  let expired = 0;
  let holdsCancelled = 0;

  for (const row of overdue) {
    const holds = parseHolds(row.holds);

    for (const hold of holds) {
      try {
        await deps.billing.cancelHold(hold.entryId);
        holdsCancelled += 1;
      } catch (error) {
        logger.warn(
          `HITL: не удалось отменить hold ${hold.entryId} (диалог ${row.conversationId}): ${describe(error)}`,
        );
      }
    }

    try {
      await deps.checkpointer.deleteThread(row.conversationId);
    } catch (error) {
      logger.warn(
        `HITL: не удалось удалить checkpoint'ы треда ${row.conversationId}: ${describe(error)}`,
      );
    }

    try {
      const count = await deps.pendingApprovals.resolvePending(
        row.conversationId,
        'expired',
      );

      if (count === 0) {
        // Запись уже закрыта параллельным тиком/решением — не дублируем лог.
        continue;
      }

      expired += 1;
      logger.log(
        JSON.stringify({
          event: 'hitl.approval_expired',
          conversationId: row.conversationId,
          userId: row.userId,
          reason: row.reason,
          holds: holds.length,
        }),
      );
    } catch (error) {
      logger.error(
        `HITL: не удалось закрыть просроченное ожидание ${row.conversationId}: ${describe(error)}`,
      );
    }
  }

  return { expired, holdsCancelled };
}

/** JSON-колонка `holds`: битое значение не мешает закрыть ожидание. */
function parseHolds(value: unknown): PendingApprovalHold[] {
  const parsed = PendingApprovalHoldsSchema.safeParse(value);

  if (!parsed.success) {
    logger.warn(
      `HITL: битая JSON-колонка holds, hold'ы не отменяются: ${parsed.error.message}`,
    );

    return [];
  }

  return parsed.data;
}

/**
 * Фоновый job истечения HITL-ожиданий.
 *
 * Первый тик — сразу при старте API (просроченные ожидания не должны зависеть
 * от рестарта), далее раз в `HITL_EXPIRY_CHECK_INTERVAL_MS` (по умолчанию
 * 5 минут). Таймер `unref`-нут, ошибки тика не роняют API.
 */
@Injectable()
export class ExpiredApprovalsService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(ExpiredApprovalsService.name);
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly checkpointer: CheckpointStoreService,
    private readonly billing: BillingService,
    private readonly pendingApprovals: PendingApprovalService,
  ) {}

  onModuleInit(): void {
    if ((process.env.REDIS_URL?.trim() ?? '') !== '') {
      this.logger.log(
        'HITL: тик истечения выполняет BullMQ (REDIS_URL задан)',
      );

      return;
    }

    const intervalMs = resolveExpiryCheckIntervalMs();

    void this.tick();
    this.timer = setInterval(() => {
      void this.tick();
    }, intervalMs);
    this.timer.unref?.();
    this.logger.log(
      `HITL: job истечения ожиданий запущен (интервал ${intervalMs} мс)`,
    );
  }

  onModuleDestroy(): void {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** Один тик; ошибка БД логируется и не пробрасывается наружу. */
  async tick(now: Date = new Date()): Promise<ExpiredApprovalsResult> {
    try {
      return await expireOverdueApprovals(
        {
          prisma: this.prisma,
          pendingApprovals: this.pendingApprovals,
          checkpointer: this.checkpointer,
          billing: this.billing,
        },
        now,
      );
    } catch (error) {
      this.logger.error(`HITL: ошибка проверки TTL: ${describe(error)}`);

      return { expired: 0, holdsCancelled: 0 };
    }
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

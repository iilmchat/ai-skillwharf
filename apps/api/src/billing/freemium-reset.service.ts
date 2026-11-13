import {
  Injectable,
  Logger,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service.js';

/** Интервал автосброса Freemium-лимитов по умолчанию: раз в сутки. */
export const FREEMIUM_RESET_DEFAULT_INTERVAL_MS = 24 * 60 * 60 * 1000;

const logger = new Logger('FreemiumReset');

/** Начало текущего календарного месяца в UTC (первое число, 00:00:00.000). */
export function startOfUtcMonth(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
}

/**
 * Сбрасывает счётчики бесплатных вызовов, которые не обновлялись в текущем
 * календарном месяце (UTC). Записи текущего месяца не трогаются, поэтому
 * повторный тик идемпотентен. Возвращает количество сброшенных счётчиков.
 */
export async function resetFreemiumLimits(
  prisma: PrismaService,
  now: Date,
): Promise<number> {
  const { count } = await prisma.skillUsage.updateMany({
    where: { lastResetAt: { lt: startOfUtcMonth(now) } },
    data: { callsCount: 0, lastResetAt: now },
  });

  logger.log(
    `Freemium: сброшено счётчиков — ${count}, отметка ${now.toISOString()}`,
  );

  return count;
}

/**
 * Периодический сброс Freemium-лимитов (ROADMAP Sprint 7).
 *
 * Месячный лимит бесплатных вызовов должен начинаться заново каждый
 * календарный месяц, без внешнего планировщика. Тик запускается сразу при
 * старте (рестарт не должен «съедать» месяц) и далее раз в
 * `FREEMIUM_RESET_INTERVAL_MS` (по умолчанию — сутки). Таймер `unref`-нут,
 * чтобы не держать процесс при завершении, а ошибки тика не роняют API.
 */
@Injectable()
export class FreemiumResetService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(FreemiumResetService.name);
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly prisma: PrismaService) {}

  onModuleInit(): void {
    const intervalMs = resolveIntervalMs(
      process.env.FREEMIUM_RESET_INTERVAL_MS,
    );

    // Первый тик сразу: пропущенный месяц не должен зависеть от рестартов.
    void this.tick();
    this.timer = setInterval(() => {
      void this.tick();
    }, intervalMs);
    this.timer.unref?.();
    this.logger.log(
      `Freemium: автосброс лимитов запущен (интервал ${intervalMs} мс)`,
    );
  }

  onModuleDestroy(): void {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** Один тик сброса; ошибка БД логируется, но не пробрасывается наружу. */
  async tick(now: Date = new Date()): Promise<number> {
    try {
      return await resetFreemiumLimits(this.prisma, now);
    } catch (error) {
      this.logger.error(
        `Freemium: не удалось сбросить лимиты: ${describe(error)}`,
      );

      return 0;
    }
  }
}

function resolveIntervalMs(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === '') {
    return FREEMIUM_RESET_DEFAULT_INTERVAL_MS;
  }

  const parsed = Number(raw);

  return Number.isFinite(parsed) && parsed > 0
    ? parsed
    : FREEMIUM_RESET_DEFAULT_INTERVAL_MS;
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

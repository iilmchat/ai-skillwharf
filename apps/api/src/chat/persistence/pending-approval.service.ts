import { Injectable, Logger } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { z } from 'zod';
import { PrismaService } from '../../prisma/prisma.service.js';
import { readPositiveEnvNumber } from './persistence-env.js';

/** TTL ожидания решения по умолчанию: сутки. */
export const DEFAULT_APPROVAL_TTL_HOURS = 24;

const MS_PER_HOUR = 60 * 60 * 1000;

/** Причины ожидания пользовательского решения. */
export const PENDING_APPROVAL_REASONS = ['approval', 'payment'] as const;

/** Статусы записи: `pending` — ждёт решения, остальные — итог. */
export const PENDING_APPROVAL_STATUSES = [
  'pending',
  'approved',
  'rejected',
  'expired',
] as const;

export type PendingApprovalReason = (typeof PENDING_APPROVAL_REASONS)[number];
export type PendingApprovalStatus = (typeof PENDING_APPROVAL_STATUSES)[number];
/** Итоговый статус: `pending` в resolve передать нельзя. */
export type PendingApprovalResolution = Exclude<
  PendingApprovalStatus,
  'pending'
>;

/** Зарезервированные под действие деньги (Pay-per-Outcome hold). */
export interface PendingApprovalHold {
  callId: string;
  toolName: string;
  entryId: string;
}

/** Разобранная запись ожидающего одобрения действия. */
export interface PendingApprovalRecord {
  id: string;
  conversationId: string;
  userId: string;
  reason: PendingApprovalReason;
  tools: string[];
  holds: PendingApprovalHold[];
  status: PendingApprovalStatus;
  createdAt: Date;
  resolvedAt: Date | null;
  /** Дедлайн решения; `null` — запись без TTL (старые строки). */
  expiresAt: Date | null;
}

/** Вход `upsertPending`: данные действия, ждущего решения. */
export interface UpsertPendingApprovalInput {
  conversationId: string;
  userId: string;
  reason: PendingApprovalReason;
  /** Инструменты, для которых нужно подтверждение. */
  tools: readonly string[];
  /** Escrow-hold'ы, зарезервированные до подтверждения. */
  holds: readonly PendingApprovalHold[];
}

/** `tools` — JSON-колонка со списком имён инструментов. */
export const PendingApprovalToolsSchema = z.array(z.string());

/** `holds` — JSON-колонка с зарезервированными escrow-hold'ами. */
export const PendingApprovalHoldSchema: z.ZodType<PendingApprovalHold> = z.object(
  {
    callId: z.string(),
    toolName: z.string(),
    entryId: z.string(),
  },
);
export const PendingApprovalHoldsSchema = z.array(PendingApprovalHoldSchema);

export const PendingApprovalReasonSchema = z.enum(PENDING_APPROVAL_REASONS);
export const PendingApprovalStatusSchema = z.enum(PENDING_APPROVAL_STATUSES);

/**
 * Zod-схема строки БД. Валидирует и JSON-колонки: битые (или не тех типов)
 * значения не роняют чтение, а отбрасываются с предупреждением в лог.
 */
export const PendingApprovalRecordSchema: z.ZodType<PendingApprovalRecord> =
  z.object({
    id: z.string(),
    conversationId: z.string(),
    userId: z.string(),
    reason: PendingApprovalReasonSchema,
    tools: PendingApprovalToolsSchema,
    holds: PendingApprovalHoldsSchema,
    status: PendingApprovalStatusSchema,
    createdAt: z.date(),
    resolvedAt: z.date().nullable(),
    expiresAt: z.date().nullable(),
  });

/**
 * TTL подтверждения (KI-033) из `HITL_APPROVAL_TTL_HOURS`, в миллисекундах.
 * Пустое/невалидное/неположительное значение → сутки.
 */
export function resolveApprovalTtlMs(
  env: NodeJS.ProcessEnv = process.env,
): number {
  return (
    readPositiveEnvNumber(env.HITL_APPROVAL_TTL_HOURS, DEFAULT_APPROVAL_TTL_HOURS) *
    MS_PER_HOUR
  );
}

/** Момент истечения ожидания: `now + ttlMs`. */
export function computeApprovalExpiresAt(now: Date, ttlMs: number): Date {
  return new Date(now.getTime() + ttlMs);
}

/** Просрочено ли ожидание (запись без TTL не истекает). */
function isExpired(record: PendingApprovalRecord, now: Date): boolean {
  return (
    record.expiresAt !== null && record.expiresAt.getTime() <= now.getTime()
  );
}

/**
 * Persistence ожидающих одобрения действий агента.
 *
 * Запись создаётся до `interrupt()` в графе, поэтому после рестарта API
 * сервис знает, какой диалог ждёт решения, какие инструменты подтверждаются
 * и какие escrow-hold'ы уже зарезервированы.
 */
@Injectable()
export class PendingApprovalService {
  private readonly logger = new Logger(PendingApprovalService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Создаёт ожидание для диалога или обновляет существующее (одна запись на
   * диалог, unique `conversationId`). Прежний результат решения сбрасывается:
   * запись снова `pending`, а дедлайн считается заново от текущего момента.
   */
  async upsertPending(
    input: UpsertPendingApprovalInput,
  ): Promise<PendingApprovalRecord> {
    const reason = PendingApprovalReasonSchema.parse(input.reason);
    const tools = PendingApprovalToolsSchema.parse([...input.tools]);
    const holds = PendingApprovalHoldsSchema.parse(
      input.holds.map((hold) => ({ ...hold })),
    );
    const expiresAt = computeApprovalExpiresAt(
      new Date(),
      resolveApprovalTtlMs(),
    );

    const row = await this.prisma.pendingApproval.upsert({
      where: { conversationId: input.conversationId },
      create: {
        conversationId: input.conversationId,
        userId: input.userId,
        reason,
        tools: toInputJson(tools),
        holds: toInputJson(holds),
        status: 'pending',
        expiresAt,
      },
      update: {
        reason,
        tools: toInputJson(tools),
        holds: toInputJson(holds),
        status: 'pending',
        resolvedAt: null,
        expiresAt,
      },
    });

    return this.requireRecord(row, input.conversationId);
  }

  /**
   * Ожидающее действие диалога или `null`, если ожидания нет либо дедлайн
   * уже прошёл (просроченное ожидание не считается активным до тика job'а).
   */
  async findPending(
    conversationId: string,
  ): Promise<PendingApprovalRecord | null> {
    const row = await this.prisma.pendingApproval.findFirst({
      where: { conversationId, status: 'pending' },
    });

    if (row === null) {
      return null;
    }

    const record = this.parseRow(row);

    if (record === null || isExpired(record, new Date())) {
      return null;
    }

    return record;
  }

  /**
   * Все активные ожидающие действия пользователя, от новых к старым.
   * Просроченные отбрасываются: их добьёт `ExpiredApprovalsService`.
   */
  async listPending(userId: string): Promise<PendingApprovalRecord[]> {
    const rows = await this.prisma.pendingApproval.findMany({
      where: { userId, status: 'pending' },
      orderBy: { createdAt: 'desc' },
    });
    const now = new Date();
    const records: PendingApprovalRecord[] = [];

    for (const row of rows) {
      const record = this.parseRow(row);

      if (record !== null && !isExpired(record, now)) {
        records.push(record);
      }
    }

    return records;
  }

  /**
   * Закрывает ожидание решением пользователя. Меняются только записи в
   * статусе `pending`, поэтому повторный resolve идемпотентен и вернёт 0.
   */
  async resolvePending(
    conversationId: string,
    status: PendingApprovalResolution,
  ): Promise<number> {
    const { count } = await this.prisma.pendingApproval.updateMany({
      where: { conversationId, status: 'pending' },
      data: { status, resolvedAt: new Date() },
    });

    return count;
  }

  /** Разбирает строку БД; битые JSON/типы — лог и `null` (без исключения). */
  private parseRow(row: unknown): PendingApprovalRecord | null {
    const parsed = PendingApprovalRecordSchema.safeParse(row);

    if (!parsed.success) {
      this.logger.warn(
        `Пропущена битая запись PendingApproval: ${parsed.error.message}`,
      );

      return null;
    }

    return parsed.data;
  }

  /** Разбор строки, которую только что записал сам сервис. */
  private requireRecord(
    row: unknown,
    conversationId: string,
  ): PendingApprovalRecord {
    const record = this.parseRow(row);

    if (record === null) {
      throw new Error(
        `Не удалось прочитать запись PendingApproval для диалога ${conversationId}`,
      );
    }

    return record;
  }
}

/** Массив plain-объектов → значение JSONB-колонки Prisma. */
function toInputJson(value: readonly unknown[]): Prisma.InputJsonValue {
  return value as unknown as Prisma.InputJsonValue;
}

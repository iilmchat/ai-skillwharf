import {
  BadRequestException,
  Injectable,
  Logger,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { BillingService } from '../billing/billing.service.js';
import { ERROR_KEYS } from '../i18n/error-keys.js';
import { MetricsService } from '../metrics/metrics.service.js';
import { recordGenAiUsageSpan } from '../observability/tracing.js';
import { PrismaService } from '../prisma/prisma.service.js';
import type { LlmRouteSelection, TokenUsage } from './contracts.js';
import { DailyTokenLimitException } from './llm-budget.errors.js';

/** Стоимость 1000 токенов LLM в рублях. */
export const LLM_COST_PER_1K_TOKENS = 0.01;

/** Минимальная стоимость вызова LLM: списание. */
export const MIN_LLM_BALANCE = 0.01;

/** Доля дневного лимита, после которой пишется soft-limit. */
export const DAILY_TOKEN_SOFT_LIMIT_RATIO = 0.8;

/** Резерв токенов на ответ модели по умолчанию. */
export const DEFAULT_RESERVED_OUTPUT_TOKENS = 4096;

interface TokenReservation {
  readonly reserved: number;
}

export interface BudgetReservation {
  reserved: number;
  tracked: boolean;
}

export interface SettleLlmUsageInput {
  userId: string;
  reserved: number;
  usage: TokenUsage;
  estimated: boolean;
  route: LlmRouteSelection | null;
  agentId?: string;
  skillId?: string;
}

/** Стоимость вызова LLM по числу токенов. */
export function calculateLlmCost(
  promptTokens: number,
  completionTokens: number,
): number {
  const total =
    Math.max(0, promptTokens || 0) + Math.max(0, completionTokens || 0);

  if (total === 0) {
    return 0;
  }

  const raw = (total / 1000) * LLM_COST_PER_1K_TOKENS;

  return Math.max(MIN_LLM_BALANCE, Math.ceil(raw * 100) / 100);
}

export function resolveReservedOutputTokens(
  value: string | undefined = process.env.LLM_RESERVE_OUTPUT_TOKENS,
): number {
  const parsed = Number.parseInt(value ?? '', 10);

  return Number.isInteger(parsed) && parsed > 0
    ? parsed
    : DEFAULT_RESERVED_OUTPUT_TOKENS;
}

export function startOfUtcDay(date: Date): Date {
  return new Date(
    Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()),
  );
}

export function needsDailyTokenReset(lastReset: Date, now: Date): boolean {
  return lastReset.getTime() < startOfUtcDay(now).getTime();
}

/**
 * Budget Guard, Ledger и OTel для LLM, оставшиеся в API.
 *
 * Worker перед вызовом модели резервирует дневной лимит через
 * `reserve`, после ответа присылает `usage` в `settle`, при ошибке —
 * `refund`. Все операции идемпотентны по `reserved`: его считает worker,
 * API лишь атомарно увеличивает/уменьшает счётчик.
 */
@Injectable()
export class LlmBudgetService {
  private readonly logger = new Logger(LlmBudgetService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly billingService: BillingService,
    private readonly metricsService: MetricsService,
  ) {}

  async reserve(
    userId: string,
    estimatedPromptTokens: number,
  ): Promise<BudgetReservation> {
    const { balance } = await this.billingService.getBalance(userId);

    if (Number.parseFloat(balance) < MIN_LLM_BALANCE) {
      throw new BadRequestException(ERROR_KEYS.insufficientFunds);
    }

    const reservation = await this.reserveDailyTokens(
      userId,
      estimatedPromptTokens,
    );

    return { reserved: reservation?.reserved ?? 0, tracked: true };
  }

  async settle(input: SettleLlmUsageInput): Promise<void> {
    const promptTokens = input.usage.input_tokens;
    const completionTokens = input.usage.output_tokens;
    const cost = calculateLlmCost(promptTokens, completionTokens);
    const model = input.route?.modelName?.trim() || process.env.LLM_MODEL || 'unknown';
    const provider = input.route?.providerType || 'openai';
    const agentId = input.agentId?.trim() || 'unknown';
    const routeName = input.route?.name ?? 'env';

    this.logger.log(
      JSON.stringify({
        event: 'gen_ai.usage',
        'gen_ai.system': provider,
        'gen_ai.model': model,
        'gen_ai.route': routeName,
        'gen_ai.agent.id': agentId,
        'gen_ai.tenant.id': input.userId,
        'gen_ai.skill.id': input.skillId ?? 'unknown',
        'gen_ai.usage.cost': cost,
        'gen_ai.prompt_tokens': promptTokens,
        'gen_ai.completion_tokens': completionTokens,
        ...(input.estimated ? { 'gen_ai.usage_estimated': true } : {}),
      }),
    );

    this.metricsService.countLlmTokens(provider, model, promptTokens, completionTokens);
    this.metricsService.countLlmCost(input.userId || 'anonymous', model, agentId, cost);
    recordGenAiUsageSpan({
      system: provider,
      model,
      tenantId: input.userId || 'anonymous',
      agentId,
      skillId: input.skillId,
      promptTokens,
      completionTokens,
      cost,
      estimated: input.estimated,
    });

    if (input.estimated) {
      this.logger.warn(
        JSON.stringify({
          event: 'gen_ai.usage.fallback',
          'gen_ai.system': provider,
          'gen_ai.model': model,
          'gen_ai.agent.id': agentId,
          'gen_ai.tenant.id': input.userId,
        }),
      );
    }

    await this.chargeLlmUsage(input.userId, cost, input.route);
    await this.reconcileDailyTokens(input.userId, input.reserved, input.usage);
  }

  async refund(userId: string, reserved: number): Promise<void> {
    if (reserved === 0) {
      return;
    }

    await this.prisma.user.updateMany({
      where: { id: userId, dailyTokensUsed: { gte: reserved } },
      data: { dailyTokensUsed: { decrement: reserved } },
    });
  }

  private async reserveDailyTokens(
    userId: string,
    estimatedPromptTokens: number,
  ): Promise<TokenReservation | null> {
    const reserved = estimatedPromptTokens + resolveReservedOutputTokens();
    const now = new Date();
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: {
        dailyTokenLimit: true,
        dailyTokensUsed: true,
        lastTokenReset: true,
      },
    });

    if (!user) {
      return null;
    }

    if (needsDailyTokenReset(user.lastTokenReset, now)) {
      await this.prisma.user.updateMany({
        where: { id: userId, lastTokenReset: { lt: startOfUtcDay(now) } },
        data: { dailyTokensUsed: 0, lastTokenReset: now },
      });
    }

    const reservation = await this.prisma.user.updateMany({
      where: {
        id: userId,
        dailyTokensUsed: { lte: user.dailyTokenLimit - reserved },
      },
      data: { dailyTokensUsed: { increment: reserved } },
    });

    if (reservation.count === 0) {
      this.logger.warn(
        JSON.stringify({
          event: 'gen_ai.budget.hard_limit',
          userId,
          'gen_ai.tokens': reserved,
          'gen_ai.daily_token_limit': user.dailyTokenLimit,
        }),
      );

      throw new DailyTokenLimitException();
    }

    const current = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { dailyTokensUsed: true },
    });
    const used = current?.dailyTokensUsed ?? user.dailyTokensUsed + reserved;
    const softLimit = Math.floor(
      user.dailyTokenLimit * DAILY_TOKEN_SOFT_LIMIT_RATIO,
    );

    if (used >= softLimit) {
      this.logger.warn(
        JSON.stringify({
          event: 'gen_ai.budget.soft_limit',
          userId,
          'gen_ai.daily_tokens_used': used,
          'gen_ai.daily_token_limit': user.dailyTokenLimit,
          'gen_ai.daily_token_soft_limit': softLimit,
        }),
      );
    }

    return { reserved };
  }

  private async reconcileDailyTokens(
    userId: string,
    reserved: number,
    usage: TokenUsage,
  ): Promise<void> {
    if (reserved === 0) {
      return;
    }

    const actual = Math.max(0, usage.total_tokens);
    const delta = actual - reserved;

    if (delta === 0) {
      return;
    }

    if (delta < 0) {
      const refund = -delta;

      await this.prisma.user.updateMany({
        where: { id: userId, dailyTokensUsed: { gte: refund } },
        data: { dailyTokensUsed: { decrement: refund } },
      });

      return;
    }

    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { dailyTokenLimit: true },
    });

    if (!user) {
      return;
    }

    const added = await this.prisma.user.updateMany({
      where: {
        id: userId,
        dailyTokensUsed: { lte: user.dailyTokenLimit - delta },
      },
      data: { dailyTokensUsed: { increment: delta } },
    });

    if (added.count !== 0) {
      return;
    }

    this.logger.warn(
      JSON.stringify({
        event: 'gen_ai.budget.reconcile_overflow',
        userId,
        'gen_ai.tokens': delta,
        'gen_ai.daily_token_limit': user.dailyTokenLimit,
      }),
    );

    await this.prisma.user.updateMany({
      where: { id: userId },
      data: { dailyTokensUsed: user.dailyTokenLimit },
    });
  }

  private async chargeLlmUsage(
    userId: string,
    cost: number,
    route: LlmRouteSelection | null,
  ): Promise<void> {
    if (cost === 0) {
      return;
    }

    const args: Parameters<BillingService['chargeForSkill']> = [
      userId,
      cost,
      'Использование LLM',
      randomUUID(),
    ];

    if (route !== null) {
      args.push(route.name);
    }

    try {
      await this.billingService.chargeForSkill(...args);
    } catch (error) {
      this.logger.warn(
        `Не удалось списать ${cost} ₽ за LLM у ${userId}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }
}

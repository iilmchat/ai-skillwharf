import {
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  UseGuards,
} from '@nestjs/common';
import { z } from 'zod';
import { Roles } from '../auth/decorators/roles.decorator.js';
import { RolesGuard } from '../auth/guards/roles.guard.js';
import { JwtAuthGuard } from '../auth/jwt-auth.guard.js';
import { invalidRequestError } from '../common/api-error.js';
import { BillingOutboxService } from './billing-outbox.service.js';
import { BillingService, type ReconciliationReport } from './billing.service.js';

const treasuryViewSchema = z.object({
  balance: z.object({
    balance: z.string(),
    heldBalance: z.string().optional(),
  }),
  outbox: z.object({
    pending: z.number().int().nonnegative(),
    sent: z.number().int().nonnegative(),
    failedDead: z.number().int().nonnegative(),
  }),
  recent: z.array(
    z.object({
      id: z.string(),
      eventType: z.string(),
      status: z.string(),
      attempts: z.number().int().nonnegative(),
      maxAttempts: z.number().int().positive(),
      nextRetryAt: z.string(),
      lastError: z.string().nullable(),
      createdAt: z.string(),
      sentAt: z.string().nullable(),
    }),
  ),
});

export type TreasuryView = z.infer<typeof treasuryViewSchema>;

/** Админские эндпоинты биллинга: Treasury, Outbox и сверка (Sprint 33). */
@Controller('admin/billing')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('admin', 'owner')
export class AdminBillingController {
  constructor(
    private readonly billing: BillingService,
    private readonly outbox: BillingOutboxService,
  ) {}

  @Get('treasury')
  treasury(): Promise<TreasuryView> {
    return this.treasuryView();
  }

  @Post('outbox/:id/retry')
  @HttpCode(HttpStatus.OK)
  async retryOutbox(@Param('id') id: string): Promise<{ retried: true; id: string }> {
    try {
      await this.outbox.retryDeadLetter(id);

      return { retried: true, id };
    } catch (error) {
      throw invalidRequestError(
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  @Get('reconciliation')
  reconciliation(): Promise<ReconciliationReport> {
    return this.billing.reconciliation();
  }

  private async treasuryView(): Promise<TreasuryView> {
    const [balance, stats, recent] = await Promise.all([
      this.billing.treasuryBalance(),
      this.outbox.stats(),
      this.outbox.recent(20),
    ]);

    return treasuryViewSchema.parse({
      balance,
      outbox: stats,
      recent: recent.map((row) => ({
        id: row.id,
        eventType: row.eventType,
        status: row.status,
        attempts: row.attempts,
        maxAttempts: row.maxAttempts,
        nextRetryAt: row.nextRetryAt.toISOString(),
        lastError: row.lastError,
        createdAt: row.createdAt.toISOString(),
        sentAt: row.sentAt?.toISOString() ?? null,
      })),
    });
  }
}

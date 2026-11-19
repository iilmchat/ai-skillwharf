import { Injectable, Logger } from '@nestjs/common';
import { z } from 'zod';
import {
  BillingService,
  splitRevenueShare,
  type RevenueShareChargeResult,
} from './billing.service.js';
import { YooKassaProvider } from './providers/yookassa.provider.js';
import { PrismaService } from '../prisma/prisma.service.js';

/** Входные данные платного вызова навыка из каталога. */
export interface MarketplaceChargeInput {
  readonly userId: string;
  readonly slug: string;
  readonly idempotencyKey: string;
}

export interface MarketplaceChargeReport {
  /** null — сплит не применялся (бесплатный навык или навык автора). */
  readonly charge: RevenueShareChargeResult | null;
  /** id перевода ЮKassa, если он выполнялся. */
  readonly transferId?: string;
  readonly reason?: string;
}

const chargeInputSchema = z.object({
  userId: z.string().min(1),
  slug: z.string().min(1).max(128),
  idempotencyKey: z.string().min(1),
});

/**
 * Revenue Share 85/15 (Sprint 27 / API-27.2).
 *
 * Ledger-сплит выполняется `BillingService` в одной транзакции.
 * Внешний перевод ЮKassa выполняется после коммита БД (сетевой вызов
 * не может быть частью транзакции): ошибка перевода логируется и не
 * откатывает уже списанные средства — операция идемпотентна по `idempotencyKey`.
 */
@Injectable()
export class RevenueShareService {
  private readonly logger = new Logger(RevenueShareService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly billing: BillingService,
    private readonly yookassa: YooKassaProvider,
  ) {}

  /**
   * Сплит уже списанного платежа (Pay-per-Call/Pay-per-Outcome): по имени
   * навыка находится `InstalledSkill.marketplaceSlug`, затем автор и цена.
   */
  async splitCapturedCharge(input: {
    readonly userId: string;
    readonly skillName: string;
    readonly entryId: string;
    readonly idempotencyKey: string;
  }): Promise<MarketplaceChargeReport> {
    const parsed = z
      .object({
        userId: z.string().min(1),
        skillName: z.string().min(1),
        entryId: z.string().min(1),
        idempotencyKey: z.string().min(1),
      })
      .parse(input);
    const installed = await this.prisma.installedSkill.findUnique({
      where: { name: parsed.skillName },
      select: { marketplaceSlug: true },
    });

    if (installed?.marketplaceSlug === null || installed === null) {
      return { charge: null, reason: 'not_marketplace_skill' };
    }

    const skill = await this.prisma.marketplaceSkill.findUnique({
      where: { slug: installed.marketplaceSlug },
      select: {
        authorId: true,
        name: true,
        payoutAccountId: true,
        price: true,
        status: true,
      },
    });

    if (skill === null || skill.status !== 'published') {
      return { charge: null, reason: 'skill_not_published' };
    }

    if (skill.authorId === parsed.userId || skill.price.toNumber() <= 0) {
      return { charge: null, reason: 'no_revenue_share' };
    }

    const entry = await this.prisma.ledgerEntry.findUnique({
      where: { id: parsed.entryId },
      select: { amount: true, wallet: { select: { userId: true } } },
    });

    if (entry === null || entry.wallet.userId !== parsed.userId) {
      return { charge: null, reason: 'charge_not_found' };
    }

    const amount = entry.amount.toNumber();
    const { author, platform } = splitRevenueShare(amount);
    const entries = await this.billing.recordRevenueShare({
      payerUserId: parsed.userId,
      authorId: skill.authorId,
      skillName: skill.name,
      amount,
      idempotencyKey: parsed.idempotencyKey,
    });
    const charge: RevenueShareChargeResult = {
      balance: '',
      entryId: parsed.entryId,
      total: amount.toFixed(2),
      authorAmount: author.toFixed(2),
      platformAmount: platform.toFixed(2),
      authorEntryId: entries.authorEntryId,
      platformEntryId: entries.platformEntryId,
    };

    return this.payout(skill, charge, parsed.idempotencyKey);
  }

  async chargeForMarketplaceSkill(
    raw: MarketplaceChargeInput,
  ): Promise<MarketplaceChargeReport> {
    const input = chargeInputSchema.parse(raw);
    const skill = await this.prisma.marketplaceSkill.findUnique({
      where: { slug: input.slug },
      select: {
        authorId: true,
        name: true,
        payoutAccountId: true,
        price: true,
        status: true,
      },
    });

    if (skill === null || skill.status !== 'published') {
      return { charge: null, reason: 'skill_not_published' };
    }

    const price = skill.price.toNumber();

    if (skill.authorId === input.userId || price <= 0) {
      return { charge: null, reason: 'no_revenue_share' };
    }

    const charge = await this.billing.chargeForMarketplaceSkill({
      userId: input.userId,
      authorId: skill.authorId,
      skillName: skill.name,
      price,
      idempotencyKey: input.idempotencyKey,
    });

    return this.payout(
      {
        payoutAccountId: skill.payoutAccountId,
        name: skill.name,
      },
      charge,
      input.idempotencyKey,
    );
  }

  /** Перевод ЮKassa после коммита BAL-операций (best effort, идемпотентно). */
  private async payout(
    skill: { payoutAccountId: string | null; name: string },
    charge: RevenueShareChargeResult,
    idempotencyKey: string,
  ): Promise<MarketplaceChargeReport> {
    if (skill.payoutAccountId === null || !this.yookassa.isConfigured()) {
      return { charge };
    }

    try {
      const transferId = await this.yookassa.createTransfer(
        skill.payoutAccountId,
        Number(charge.authorAmount),
        `revenue-share:${idempotencyKey}`,
        `Revenue Share: ${skill.name}`,
      );

      return { charge, transferId };
    } catch (error) {
      this.logger.error(
        JSON.stringify({
          event: 'marketplace.transfer_failed',
          skill: skill.name,
          message: error instanceof Error ? error.message : String(error),
        }),
      );

      return { charge, reason: 'transfer_failed' };
    }
  }
}

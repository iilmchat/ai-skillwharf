import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { z } from 'zod';
import { outboxPayloadSchema } from '../billing/billing-outbox.service.js';
import {
  invalidSkillSignatureError,
  marketplaceSkillNotFoundError,
  policyBlockedError,
  skillAuditRejectedError,
} from '../common/api-error.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { parseSkillFile } from '../skills/skill-file.js';
import { SkillSignatureService } from '../skills/skill-signature.service.js';
import {
  developerDashboardSchema,
  developerPayoutUpdateSchema,
  developerSkillItemSchema,
  publishDeveloperSkillSchema,
  updatePayoutAccountSchema,
  type DeveloperDashboard,
  type DeveloperSkillItem,
} from './developer-portal.schemas.js';
import { marketplaceSlugSchema } from './marketplace.schemas.js';
import {
  auditFindingSchema,
  auditStatusSchema,
} from './skill-audit.schemas.js';
import { SkillSecurityAuditService } from './skill-security-audit.service.js';

/** Личный кабинет автора навыков (DEVPORTAL-36.1/36.2/36.3). */
@Injectable()
export class DeveloperPortalService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly signatures: SkillSignatureService,
    private readonly audit: SkillSecurityAuditService,
  ) {}

  async dashboard(userId: string): Promise<DeveloperDashboard> {
    const skills = await this.prisma.marketplaceSkill.findMany({
      where: { authorId: userId },
      orderBy: { createdAt: 'desc' },
    });
    const accounts = new Set(
      skills
        .map((skill) => skill.payoutAccountId)
        .filter((account): account is string => account !== null),
    );
    const names = new Set(skills.map((skill) => skill.name));
    const [revenue, pending] = await Promise.all([
      this.prisma.ledgerEntry.aggregate({
        where: { type: 'author_revenue_share', wallet: { userId } },
        _sum: { amount: true },
      }),
      this.prisma.billingOutbox.findMany({
        where: {
          eventType: 'yookassa_author_transfer',
          status: { in: ['pending', 'processing'] },
        },
        select: { payloadJson: true },
      }),
    ]);

    let pendingPayoutRub = 0;

    for (const row of pending) {
      const payload = outboxPayloadSchema.safeParse(row.payloadJson);

      if (
        payload.success &&
        (accounts.has(payload.data.payoutAccountId) ||
          names.has(payload.data.skillName))
      ) {
        pendingPayoutRub += payload.data.amountRub;
      }
    }

    return developerDashboardSchema.parse({
      totalSkills: skills.length,
      totalDownloads: skills.reduce((sum, skill) => sum + skill.downloadsCount, 0),
      totalRevenueRub: revenue._sum.amount?.toNumber() ?? 0,
      pendingPayoutRub,
      skills: skills.map((skill) => this.toItem(skill)),
    });
  }

  async publish(
    userId: string,
    raw: unknown,
  ): Promise<{ skill: DeveloperSkillItem }> {
    const input = publishDeveloperSkillSchema.parse(raw);
    const parsed = parseSkillFile(input.manifestYaml);

    if (!parsed.success) {
      throw invalidSkillSignatureError(
        `Некорректный SKILL.md: ${parsed.errors.join('; ')}`,
      );
    }

    const { manifest, body } = parsed.value;
    const signature = this.signatures.verifyParsed(manifest, body);
    const report = this.audit.audit(manifest, body, input.manifestYaml);

    if (report.status === 'rejected') {
      throw skillAuditRejectedError(report.findings);
    }

    const slug = marketplaceSlugSchema.parse(manifest.name);
    const existing = await this.prisma.marketplaceSkill.findUnique({
      where: { slug },
    });

    if (existing !== null && existing.authorId !== userId) {
      throw policyBlockedError('Навык с таким slug принадлежит другому автору');
    }

    const data = {
      name: manifest.name,
      version: manifest.version,
      description: manifest.description,
      authorName: manifest.author.name,
      manifestYaml: input.manifestYaml,
      signature: manifest.signature ?? null,
      publicKeyId: manifest.publicKeyId ?? null,
      verified: signature.verified,
      pricingModel: manifest.pricing?.model ?? 'Free',
      price: new Prisma.Decimal(manifest.pricing?.price ?? 0),
      status: 'published',
      auditStatus: report.status,
      auditFindingsJson: report.findings as unknown as Prisma.InputJsonValue,
      ...(input.payoutAccountId === undefined
        ? {}
        : { payoutAccountId: input.payoutAccountId }),
    };
    const row = await this.prisma.marketplaceSkill.upsert({
      where: { slug },
      create: { slug, authorId: userId, trackIds: [], ...data },
      update: data,
    });

    return { skill: this.toItem(row) };
  }

  async updatePayout(
    userId: string,
    slug: string,
    raw: unknown,
  ): Promise<{ skill: DeveloperSkillItem }> {
    const input = updatePayoutAccountSchema.parse(raw);
    const normalizedSlug = marketplaceSlugSchema.parse(slug);
    const existing = await this.prisma.marketplaceSkill.findUnique({
      where: { slug: normalizedSlug },
    });

    if (existing === null) {
      throw marketplaceSkillNotFoundError('Навык не найден');
    }

    if (existing.authorId !== userId) {
      throw policyBlockedError(
        'Недостаточно прав для изменения счёта выплат навыка',
      );
    }

    const row = await this.prisma.marketplaceSkill.update({
      where: { slug: normalizedSlug },
      data: { payoutAccountId: input.payoutAccountId },
    });

    return developerPayoutUpdateSchema.parse({ skill: this.toItem(row) });
  }

  private toItem(skill: {
    id: string;
    slug: string;
    name: string;
    version: string;
    pricingModel: string;
    price: Prisma.Decimal;
    downloadsCount: number;
    verified: boolean;
    auditStatus: string;
    auditFindingsJson: Prisma.JsonValue | null;
    payoutAccountId: string | null;
    createdAt: Date;
  }) {
    const findings = z.array(auditFindingSchema).safeParse(
      skill.auditFindingsJson ?? [],
    );
    const status = auditStatusSchema.safeParse(skill.auditStatus);

    return developerSkillItemSchema.parse({
      id: skill.id,
      slug: skill.slug,
      name: skill.name,
      version: skill.version,
      pricingModel: skill.pricingModel,
      price: skill.price.toNumber(),
      downloadsCount: skill.downloadsCount,
      verified: skill.verified,
      auditStatus: status.success ? status.data : 'passed',
      auditFindings: findings.success ? findings.data : [],
      payoutAccountId: skill.payoutAccountId,
      createdAt: skill.createdAt.toISOString(),
    });
  }
}

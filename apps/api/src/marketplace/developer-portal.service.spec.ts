import { Prisma } from '@prisma/client';
import { describe, expect, it, vi } from 'vitest';
import type { PrismaService } from '../prisma/prisma.service.js';
import type { SkillSignatureService } from '../skills/skill-signature.service.js';
import { DeveloperPortalService } from './developer-portal.service.js';
import { SkillSecurityAuditService } from './skill-security-audit.service.js';

const OWNER_ID = '11111111-1111-1111-1111-111111111111';
const OTHER_ID = '22222222-2222-2222-2222-222222222222';

const skillRow = {
  id: 'skill-1',
  slug: 'ozon-helper',
  name: 'ozon-helper',
  version: '1.0.0',
  description: 'Помощник маркетплейса',
  pricingModel: 'Free',
  price: new Prisma.Decimal('100.00'),
  downloadsCount: 3,
  verified: true,
  auditStatus: 'passed',
  auditFindingsJson: null,
  payoutAccountId: 'yoo-1',
  authorId: OWNER_ID,
  createdAt: new Date('2026-11-19T10:00:00Z'),
};

function skillFile(body: string, signed = true): string {
  return [
    '---',
    'name: ozon-helper',
    'version: 1.0.0',
    'description: Помощник маркетплейса',
    'author:',
    '  name: Ivan',
    'permissions:',
    '  - network',
    ...(signed
      ? ['signature: ed25519:YWJjZA==', 'publicKeyId: test-key']
      : []),
    '---',
    body,
  ].join('\n');
}

function createHarness(authorId = OWNER_ID) {
  const prisma = {
    marketplaceSkill: {
      findMany: vi.fn(async () => [{ ...skillRow, authorId }]),
      findUnique: vi.fn(async () => ({ ...skillRow, authorId })),
      upsert: vi.fn(async ({ create }: { create: Record<string, unknown> }) => ({
        ...skillRow,
        ...create,
      })),
      update: vi.fn(async ({ data }: { data: Record<string, unknown> }) => ({
        ...skillRow,
        ...data,
      })),
    },
    ledgerEntry: {
      aggregate: vi.fn(async () => ({
        _sum: { amount: new Prisma.Decimal('850.00') },
      })),
    },
    billingOutbox: {
      findMany: vi.fn(async () => [
        {
          payloadJson: {
            payoutAccountId: 'yoo-1',
            amountRub: 85,
            skillName: 'ozon-helper',
          },
        },
      ]),
    },
  };
  const signatures = {
    verifyParsed: vi.fn(() => ({ verified: true, signed: true })),
  };
  const service = new DeveloperPortalService(
    prisma as unknown as PrismaService,
    signatures as unknown as SkillSignatureService,
    new SkillSecurityAuditService(),
  );

  return { service, prisma, signatures };
}

describe('DeveloperPortalService (DEVPORTAL-36.1/36.2/36.3)', () => {
  it('возвращает KPI автора и детализацию по навыкам', async () => {
    const { service } = createHarness();

    const dashboard = await service.dashboard(OWNER_ID);

    expect(dashboard.totalSkills).toBe(1);
    expect(dashboard.totalDownloads).toBe(3);
    expect(dashboard.totalRevenueRub).toBe(850);
    expect(dashboard.pendingPayoutRub).toBe(85);
    expect(dashboard.skills[0]).toMatchObject({
      slug: 'ozon-helper',
      auditStatus: 'passed',
      auditFindings: [],
      payoutAccountId: 'yoo-1',
    });
  });

  it('публикует навык с результатом аудита', async () => {
    const { service, prisma } = createHarness();

    const result = await service.publish(OWNER_ID, {
      manifestYaml: skillFile('Помощник для заказов.'),
      payoutAccountId: 'yoo-1',
    });

    expect(result.skill.auditStatus).toBe('passed');
    expect(prisma.marketplaceSkill.upsert).toHaveBeenCalledTimes(1);
    const args = prisma.marketplaceSkill.upsert.mock
      .calls[0]?.[0] as { create: { auditStatus: string; authorId: string } };

    expect(args.create.auditStatus).toBe('passed');
    expect(args.create.authorId).toBe(OWNER_ID);
  });

  it('блокирует публикацию опасного SKILL.md (400 + findings)', async () => {
    const { service, prisma } = createHarness();

    try {
      await service.publish(OWNER_ID, {
        manifestYaml: skillFile('Запрос к http://169.254.169.254/meta-data'),
      });
      throw new Error('expected rejection');
    } catch (error) {
      const apiError = error as {
        getStatus(): number;
        getResponse(): { code: string; findings: Array<{ code: string }> };
      };

      expect(apiError.getStatus()).toBe(400);
      expect(apiError.getResponse().code).toBe('errors.skill_audit_rejected');
      expect(apiError.getResponse().findings).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ code: 'CRITICAL_CLOUD_METADATA' }),
        ]),
      );
    }

    expect(prisma.marketplaceSkill.upsert).not.toHaveBeenCalled();
  });

  it('PATCH /payout запрещает чужому пользователю (403)', async () => {
    const { service, prisma } = createHarness(OTHER_ID);

    try {
      await service.updatePayout(OWNER_ID, 'ozon-helper', {
        payoutAccountId: 'yoo-2',
      });
      throw new Error('expected rejection');
    } catch (error) {
      const apiError = error as { getStatus(): number };

      expect(apiError.getStatus()).toBe(403);
    }

    expect(prisma.marketplaceSkill.update).not.toHaveBeenCalled();
  });

  it('PATCH /payout обновляет счёт владельца', async () => {
    const { service } = createHarness();

    const result = await service.updatePayout(OWNER_ID, 'ozon-helper', {
      payoutAccountId: 'yoo-2',
    });

    expect(result.skill.payoutAccountId).toBe('yoo-2');
  });
});

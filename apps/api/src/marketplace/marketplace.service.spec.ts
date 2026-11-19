import { Prisma } from '@prisma/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SkillSignatureService } from '../skills/skill-signature.service.js';
import { MarketplaceService } from './marketplace.service.js';

interface Harness {
  service: MarketplaceService;
  rows: Array<Record<string, unknown>>;
  installed: Array<Record<string, unknown>>;
  prisma: Record<string, unknown>;
}

const manifestYaml = `---
name: test-skill
version: 1.0.0
description: Тестовый навык
author:
  name: Author
permissions:
  - network
  - filesystem
---

# Инструкции
`;

function skill(
  slug: string,
  trackIds: string[],
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id: `id-${slug}`,
    slug,
    name: slug,
    version: '1.0.0',
    description: `Навык ${slug}`,
    trackIds,
    authorId: 'author-1',
    authorName: 'Author',
    verified: true,
    pricingModel: 'Pay-per-Call',
    price: new Prisma.Decimal('5.00'),
    downloadsCount: 0,
    manifestYaml,
    signature: 'ed25519:YWJj',
    publicKeyId: 'author-key',
    status: 'published',
    createdAt: new Date('2026-11-19T00:00:00Z'),
    ...overrides,
  };
}

function createHarness(allRows: Array<Record<string, unknown>>): Harness {
  const rows = [...allRows];
  const installed: Array<Record<string, unknown>> = [];
  const findMany = vi.fn(async ({ where }: { where?: { trackIds?: { has: string }; verified?: boolean; OR?: unknown } } = {}) => {
    return rows.filter((row) => {
      if (row.status !== 'published') {
        return false;
      }
      if (where?.trackIds?.has !== undefined && !(row.trackIds as string[]).includes(where.trackIds.has)) {
        return false;
      }
      if (where?.verified !== undefined && row.verified !== where.verified) {
        return false;
      }
      return true;
    });
  });
  const prisma = {
    marketplaceSkill: {
      findMany,
      count: vi.fn(async () => findMany.mock.calls.length > 0 ? rows.filter((row) => row.status === 'published').length : 0),
      findUnique: vi.fn(async ({ where }: { where: { slug: string } }) =>
        rows.find((row) => row.slug === where.slug) ?? null,
      ),
      update: vi.fn(async ({ where }: { where: { slug: string } }) => {
        const row = rows.find((item) => item.slug === where.slug);
        if (row === undefined) {
          throw new Error('not found');
        }
        row.downloadsCount = ((row.downloadsCount as number) ?? 0) + 1;
        return { downloadsCount: row.downloadsCount };
      }),
    },
    installedSkill: {
      upsert: vi.fn(async (args: { create: Record<string, unknown>; update: Record<string, unknown> }) => {
        const record = {
          id: 'installed-1',
          name: args.create.name,
          version: args.create.version,
          marketplaceSlug: args.create.marketplaceSlug,
          ...args.create,
        };
        installed.push(record);
        return record;
      }),
      findUnique: vi.fn(async () => null),
      findMany: vi.fn(
        async ({ where }: { where?: { marketplaceSlug?: { in: string[] } } } = {}) =>
          installed.filter(
            (item) =>
              where?.marketplaceSlug?.in === undefined ||
              where.marketplaceSlug.in.includes(
                String(item.marketplaceSlug ?? ''),
              ),
          ),
      ),
    },
    $transaction: vi.fn(async (callback: (tx: unknown) => Promise<unknown>) => callback(prisma)),
  } as unknown as Record<string, unknown>;
  const signatures = {
    verifyParsed: vi.fn(() => ({ verified: true, signed: true })),
  } as unknown as SkillSignatureService;

  return {
    service: new MarketplaceService(prisma as never, signatures),
    rows,
    installed,
    prisma,
  };
}

describe('MarketplaceService (API-27.2)', () => {
  let harness: Harness;

  beforeEach(() => {
    harness = createHarness([
      skill('seo-audit', ['A', 'D']),
      skill('finance-report', ['J']),
      skill('wholesale-doc', ['K'], { verified: false }),
      skill('draft-skill', ['B'], { status: 'draft' }),
    ]);
  });

  it('фильтрует каталог по трекам A–L и отдаёт только опубликованные', async () => {
    const result = await harness.service.listSkills({ track: 'J', limit: 10, offset: 0 });

    expect(result.items.map((item) => item.slug)).toEqual(['finance-report']);
    expect(result.items[0]?.price).toBe('5.00');
    expect(result.limit).toBe(10);

    const byTrackA = await harness.service.listSkills({ track: 'A', limit: 20, offset: 0 });

    expect(byTrackA.items.map((item) => item.slug)).toEqual(['seo-audit']);
  });

  it('фильтрует по verified и валидирует невалидный track через Zod', async () => {
    const result = await harness.service.listSkills({ verified: 'false' });

    expect(result.items.map((item) => item.slug)).toEqual(['wholesale-doc']);
    await expect(harness.service.listSkills({ track: 'Z' })).rejects.toThrow();
  });

  it('устанавливает навык в 1 клик и инкрементирует downloadsCount в транзакции', async () => {
    const result = await harness.service.install('user-1', 'seo-audit');

    expect(result).toMatchObject({
      installedId: 'installed-1',
      name: 'seo-audit',
      slug: 'seo-audit',
      downloadsCount: 1,
    });
    expect(harness.installed[0]).toMatchObject({ marketplaceSlug: 'seo-audit' });
    expect(harness.prisma.$transaction).toHaveBeenCalledTimes(1);
  });

  it('не устанавливает неопубликованный навык', async () => {
    await expect(harness.service.install('user-1', 'draft-skill')).rejects.toThrow(
      /не опубликован/,
    );
  });

  describe('контракт ответа каталога (KI-086)', () => {
    it('возвращает permissions из SKILL.md и детали подписи', async () => {
      const result = await harness.service.listSkills({});
      const item = result.items.find((row) => row.slug === 'seo-audit');

      expect(item?.permissions).toEqual(['network', 'filesystem']);
      expect(item?.signature).toEqual({
        verified: true,
        status: 'verified',
        publicKeyId: 'author-key',
      });
      expect(item?.publicKeyId).toBe('author-key');
      expect(item?.installed).toBe(false);
    });

    it('проставляет installed: true только для установленных навыков', async () => {
      await harness.service.install('user-1', 'seo-audit');
      const result = await harness.service.listSkills({}, 'user-1');
      const bySlug = new Map(result.items.map((item) => [item.slug, item]));

      expect(bySlug.get('seo-audit')?.installed).toBe(true);
      expect(bySlug.get('finance-report')?.installed).toBe(false);
      expect(harness.prisma.installedSkill.findMany).toHaveBeenCalledWith({
        where: { marketplaceSlug: { in: expect.arrayContaining(['seo-audit']) } },
        select: { marketplaceSlug: true },
      });
    });

    it('без userId не делает запрос в InstalledSkill и installed=false', async () => {
      const result = await harness.service.listSkills({});

      expect(harness.prisma.installedSkill.findMany).not.toHaveBeenCalled();
      expect(result.items.every((item) => item.installed === false)).toBe(true);
    });

    it('неподписанный навык отдаёт signature.status=unverified, а битый манифест — permissions=[]', async () => {
      harness.rows.push(
        skill('unsigned-skill', ['C'], {
          signature: null,
          publicKeyId: null,
          verified: false,
          manifestYaml: ' frontiers: not a skill.md',
        }),
      );
      const result = await harness.service.listSkills({});
      const item = result.items.find((row) => row.slug === 'unsigned-skill');

      expect(item?.permissions).toEqual([]);
      expect(item?.signature).toEqual({ verified: false, status: 'unverified' });
      expect(item?.publicKeyId).toBeNull();
    });
  });
});

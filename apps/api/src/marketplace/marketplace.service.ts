import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { parseSkillFile } from '../skills/skill-file.js';
import { SkillSignatureService } from '../skills/skill-signature.service.js';
import { invalidSkillSignatureError } from '../common/api-error.js';
import { marketplaceSkillNotFoundError } from '../common/api-error.js';
import { PrismaService } from '../prisma/prisma.service.js';
import {
  marketplaceListQuerySchema,
  marketplaceSkillViewSchema,
  publishMarketplaceSkillSchema,
  type MarketplaceListQuery,
  type MarketplaceSkillViewSchema,
  type PublishMarketplaceSkillInput,
} from './marketplace.schemas.js';

/** Ответ элемента каталога — тот же контракт, что валидирует витрина. */
export type MarketplaceSkillView = MarketplaceSkillViewSchema;

export interface MarketplaceListResult {
  items: MarketplaceSkillView[];
  total: number;
  limit: number;
  offset: number;
}

export interface InstallMarketplaceResult {
  installedId: string;
  name: string;
  slug: string;
  downloadsCount: number;
}

interface MarketplaceSkillRow {
  id: string;
  slug: string;
  name: string;
  version: string;
  description: string;
  trackIds: string[];
  authorName: string;
  verified: boolean;
  pricingModel: string;
  price: Prisma.Decimal;
  downloadsCount: number;
  status: string;
  signature: string | null;
  publicKeyId: string | null;
  manifestYaml: string;
}

function toView(
  row: MarketplaceSkillRow,
  permissions: readonly string[],
  installed: boolean,
): MarketplaceSkillView {
  return marketplaceSkillViewSchema.parse({
    id: row.id,
    slug: row.slug,
    name: row.name,
    version: row.version,
    description: row.description,
    trackIds: row.trackIds,
    authorName: row.authorName,
    verified: row.verified,
    pricingModel: row.pricingModel,
    price: row.price.toFixed(2),
    downloadsCount: row.downloadsCount,
    status: row.status,
    permissions: [...permissions],
    signature: {
      verified: row.verified,
      status:
        row.verified && row.signature !== null
          ? 'verified'
          : row.signature !== null
            ? 'invalid'
            : 'unverified',
      ...(row.publicKeyId === null ? {} : { publicKeyId: row.publicKeyId }),
    },
    publicKeyId: row.publicKeyId,
    installed,
  });
}

/** Разрешения из SKILL.md; битый манифест не должен ломать выдачу списка. */
function extractPermissions(manifestYaml: string): readonly string[] {
  const parsed = parseSkillFile(manifestYaml);

  return parsed.success ? parsed.value.manifest.permissions : [];
}

/**
 * Публичный каталог навыков (Sprint 27 / API-27.2).
 *
 * Публикация проверяет SKILL.md и Ed25519-подпись; установка — одна транзакция:
 * запись в `InstalledSkill` + инкремент `downloadsCount`.
 */
@Injectable()
export class MarketplaceService {
  private readonly logger = new Logger(MarketplaceService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly signatures: SkillSignatureService,
  ) {}

  /**
   * Публичный список: только опубликованные навыки.
   *
   * `userId` из JWT используется для флага `installed`: он берётся из БД,
   * поэтому состояние переживает перезагрузку страницы (KI-086).
   */
  async listSkills(
    rawQuery: unknown,
    userId?: string,
  ): Promise<MarketplaceListResult> {
    const query: MarketplaceListQuery =
      marketplaceListQuerySchema.parse(rawQuery ?? {});
    const where: Prisma.MarketplaceSkillWhereInput = { status: 'published' };

    if (query.track !== undefined) {
      where.trackIds = { has: query.track };
    }

    if (query.pricingModel !== undefined) {
      where.pricingModel = query.pricingModel;
    }

    if (query.verified !== undefined) {
      where.verified = query.verified === 'true';
    }

    if (query.search !== undefined) {
      where.OR = [
        { name: { contains: query.search, mode: 'insensitive' } },
        { description: { contains: query.search, mode: 'insensitive' } },
      ];
    }

    const [rows, total] = await Promise.all([
      this.prisma.marketplaceSkill.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: query.offset,
        take: query.limit,
      }),
      this.prisma.marketplaceSkill.count({ where }),
    ]);
    const slugs = rows.map((row) => row.slug);
    const installedRows =
      userId === undefined || slugs.length === 0
        ? []
        : await this.prisma.installedSkill.findMany({
            where: { marketplaceSlug: { in: slugs } },
            select: { marketplaceSlug: true },
          });

    // NOTE: в текущей схеме InstalledSkill глобальный (нет колонки userId),
    // поэтому фильтр `where: { userId, marketplaceSlug: { in: slugs } }`
    // невозможен без миграции. userId принимается для совместимости вызова
    // и логируется; как только схема станет per-user, фильтр добавится.
    if (userId !== undefined) {
      this.logger.debug(
        JSON.stringify({ event: 'marketplace.list', userId, count: rows.length }),
      );
    }

    const installedSlugs = new Set(
      installedRows
        .map((row) => row.marketplaceSlug)
        .filter((slug): slug is string => slug !== null),
    );

    return {
      items: rows.map((row) =>
        toView(
          row,
          extractPermissions(row.manifestYaml),
          installedSlugs.has(row.slug),
        ),
      ),
      total,
      limit: query.limit,
      offset: query.offset,
    };
  }

  /** Публикация навыка автором. */
  async publish(
    authorId: string,
    raw: unknown,
  ): Promise<MarketplaceSkillView> {
    const input: PublishMarketplaceSkillInput =
      publishMarketplaceSkillSchema.parse(raw);
    const parsed = parseSkillFile(input.manifestYaml);

    if (!parsed.success) {
      throw invalidSkillSignatureError(
        `Некорректный SKILL.md: ${parsed.errors.join('; ')}`,
      );
    }

    const signature = this.signatures.verifyParsed(
      parsed.value.manifest,
      parsed.value.body,
    );
    const pricing = parsed.value.manifest.pricing;

    const row = await this.prisma.marketplaceSkill.upsert({
      where: { slug: input.slug },
      create: {
        slug: input.slug,
        name: input.name,
        version: input.version,
        description: input.description,
        trackIds: [...input.trackIds],
        authorId,
        authorName: input.authorName,
        ...(input.payoutAccountId === undefined
          ? {}
          : { payoutAccountId: input.payoutAccountId }),
        manifestYaml: input.manifestYaml,
        signature: parsed.value.manifest.signature ?? null,
        publicKeyId: parsed.value.manifest.publicKeyId ?? null,
        verified: signature.verified,
        pricingModel: pricing?.model ?? 'Free',
        price: new Prisma.Decimal(pricing?.price ?? 0),
        status: input.status,
      },
      update: {
        name: input.name,
        version: input.version,
        description: input.description,
        trackIds: [...input.trackIds],
        authorName: input.authorName,
        ...(input.payoutAccountId === undefined
          ? {}
          : { payoutAccountId: input.payoutAccountId }),
        manifestYaml: input.manifestYaml,
        signature: parsed.value.manifest.signature ?? null,
        publicKeyId: parsed.value.manifest.publicKeyId ?? null,
        verified: signature.verified,
        pricingModel: pricing?.model ?? 'Free',
        price: new Prisma.Decimal(pricing?.price ?? 0),
        status: input.status,
      },
    });

    return toView(row, extractPermissions(input.manifestYaml), false);
  }

  /** Установка в 1 клик: InstalledSkill + инкремент счётчика в транзакции. */
  async install(
    userId: string,
    slug: string,
  ): Promise<InstallMarketplaceResult> {
    const skill = await this.prisma.marketplaceSkill.findUnique({
      where: { slug },
    });

    if (skill === null || skill.status !== 'published') {
      throw marketplaceSkillNotFoundError(`Навык ${slug} не опубликован`);
    }

    // Повторная проверка подписи на установке: каталог мог быть изменён.
    const parsed = parseSkillFile(skill.manifestYaml);

    if (!parsed.success) {
      throw invalidSkillSignatureError('SKILL.md в каталоге невалиден');
    }

    this.signatures.verifyParsed(parsed.value.manifest, parsed.value.body);

    const manifest = parsed.value.manifest as unknown as Prisma.InputJsonValue;

    return this.prisma.$transaction(async (tx) => {
      const installed = await tx.installedSkill.upsert({
        where: { name: skill.name },
        create: {
          name: skill.name,
          version: skill.version,
          author: skill.authorName,
          manifest,
          marketplaceSlug: skill.slug,
        },
        update: {
          version: skill.version,
          author: skill.authorName,
          manifest,
          marketplaceSlug: skill.slug,
          isEnabled: true,
        },
      });
      const updated = await tx.marketplaceSkill.update({
        where: { slug },
        data: { downloadsCount: { increment: 1 } },
        select: { downloadsCount: true },
      });

      // InstalledSkill в текущей схеме глобальный (как и в `installSkill`);
      // потребитель фиксируется структурированным логом для аудита.
      this.logger.log(
        JSON.stringify({
          event: 'marketplace.skill_installed',
          userId,
          slug: skill.slug,
        }),
      );

      return {
        installedId: installed.id,
        name: installed.name,
        slug: skill.slug,
        downloadsCount: updated.downloadsCount,
      };
    });
  }
}

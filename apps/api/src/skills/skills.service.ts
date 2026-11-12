import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
  type OnModuleInit,
} from '@nestjs/common';
import { Prisma, type InstalledSkill } from '@prisma/client';
import { SkillManifestSchema, type SkillManifest } from '@skillwharf/shared';
import { existsSync, globSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { parse } from 'yaml';
import { PrismaService } from '../prisma/prisma.service.js';

export interface SkillValidationResult {
  valid: boolean;
  errors: string[];
}

type ManifestParseResult =
  | { success: true; manifest: SkillManifest }
  | { success: false; errors: string[] };

/** YAML frontmatter: блок между первыми строками `---`. */
const FRONTMATTER_PATTERN = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/;

/** Каталог стартовых навыков в корне репозитория. */
const STARTER_SKILLS_DIRNAME = 'starter-skills';

/** Насколько глубоко подниматься от рабочей директории в поисках каталога. */
const MAX_PARENT_LOOKUP_DEPTH = 5;

@Injectable()
export class SkillsService implements OnModuleInit {
  private readonly logger = new Logger(SkillsService.name);

  constructor(private readonly prisma: PrismaService) {}

  /** При старте API подхватывает навыки «из коробки». */
  async onModuleInit(): Promise<void> {
    try {
      await this.seedStarterSkills();
    } catch (error) {
      // Недоступная БД не должна превращать старт API в падение:
      // health-эндпоинт покажет проблему, а навыки загрузятся при рестарте.
      this.logger.error(
        `Не удалось загрузить стартовые навыки: ${String(error)}`,
      );
    }
  }

  /**
   * Парсит YAML-заголовок SKILL.md и валидирует его Zod-схемой
   * `SkillManifestSchema` из `@skillwharf/shared`.
   */
  validateManifest(fileContent: string): SkillValidationResult {
    const result = this.parseManifest(fileContent);

    return result.success
      ? { valid: true, errors: [] }
      : { valid: false, errors: result.errors };
  }

  /**
   * Устанавливает навык в каталог: манифест перечитывается и валидируется,
   * повторная установка навыка с тем же именем обновляет запись.
   */
  async installSkill(fileContent: string): Promise<InstalledSkill> {
    const result = this.parseManifest(fileContent);

    if (!result.success) {
      throw new BadRequestException({
        message: 'Некорректный манифест навыка',
        errors: result.errors,
      });
    }

    const { manifest } = result;
    const manifestJson = manifest as unknown as Prisma.InputJsonValue;
    const version = manifest.version;
    const author = manifest.author.name;

    return this.prisma.installedSkill.upsert({
      where: { name: manifest.name },
      create: {
        name: manifest.name,
        version,
        author,
        manifest: manifestJson,
      },
      update: {
        version,
        author,
        manifest: manifestJson,
        isEnabled: true,
      },
    });
  }

  /** Список всех установленных навыков (каталог). */
  getInstalledSkills(): Promise<InstalledSkill[]> {
    return this.prisma.installedSkill.findMany({
      orderBy: { installedAt: 'desc' },
    });
  }

  /**
   * Загружает стартовый каталог навыков: читает все `SKILL.md` из
   * `starter-skills/`, валидирует манифесты и делает upsert по имени.
   * Возвращает количество успешно загруженных навыков.
   */
  async seedStarterSkills(): Promise<number> {
    const directory = findStarterSkillsDir();

    if (!directory) {
      this.logger.warn(
        `Каталог ${STARTER_SKILLS_DIRNAME} не найден — стартовые навыки не загружены`,
      );
      return 0;
    }

    const files = globSync('**/SKILL.md', { cwd: directory }).sort();
    let seeded = 0;

    for (const file of files) {
      try {
        await this.installSkill(readFileSync(join(directory, file), 'utf8'));
        seeded += 1;
      } catch (error) {
        // Битый манифест логируем, но не блокируем старт API.
        if (!(error instanceof BadRequestException)) {
          throw error;
        }

        this.logger.error(`Не удалось загрузить ${file}: ${String(error)}`);
      }
    }

    this.logger.log(`Стартовые навыки загружены: ${seeded}/${files.length}`);

    return seeded;
  }

  /** Включает или выключает установленный навык. */
  async toggleSkill(id: string, isEnabled: boolean): Promise<InstalledSkill> {
    await this.assertInstalled(id);

    return this.prisma.installedSkill.update({
      where: { id },
      data: { isEnabled },
    });
  }

  /** Удаляет навык из каталога. */
  async uninstallSkill(id: string): Promise<InstalledSkill> {
    await this.assertInstalled(id);

    return this.prisma.installedSkill.delete({ where: { id } });
  }

  private async assertInstalled(id: string): Promise<void> {
    const skill = await this.prisma.installedSkill.findUnique({
      where: { id },
      select: { id: true },
    });

    if (!skill) {
      throw new NotFoundException(`Навык ${id} не найден`);
    }
  }

  private parseManifest(fileContent: string): ManifestParseResult {
    const content = fileContent.replace(/^\uFEFF/, '');
    const frontmatter = FRONTMATTER_PATTERN.exec(content);

    if (!frontmatter || frontmatter[1] === undefined) {
      return {
        success: false,
        errors: [
          'YAML frontmatter не найден: файл должен начинаться с блока --- ... ---',
        ],
      };
    }

    let parsed: unknown;

    try {
      parsed = parse(frontmatter[1]);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);

      return {
        success: false,
        errors: [`Не удалось распарсить YAML frontmatter: ${reason}`],
      };
    }

    const result = SkillManifestSchema.safeParse(parsed);

    if (result.success) {
      return { success: true, manifest: result.data };
    }

    return {
      success: false,
      errors: result.error.issues.map((issue) => {
        const path = issue.path.length > 0 ? issue.path.join('.') : 'manifest';

        return `${path}: ${issue.message}`;
      }),
    };
  }
}

/**
 * Ищет каталог `starter-skills` вверх от рабочей директории: так путь
 * находится и в dev-режиме (`apps/api`), и в runtime-образе (`/app`).
 */
function findStarterSkillsDir(): string | null {
  let current = process.cwd();

  for (let depth = 0; depth <= MAX_PARENT_LOOKUP_DEPTH; depth += 1) {
    const candidate = join(current, STARTER_SKILLS_DIRNAME);

    if (existsSync(candidate)) {
      return candidate;
    }

    const parent = dirname(current);

    if (parent === current) {
      return null;
    }

    current = parent;
  }

  return null;
}

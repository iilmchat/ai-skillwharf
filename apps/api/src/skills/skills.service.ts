import { BadRequestException, Injectable } from '@nestjs/common';
import { Prisma, type InstalledSkill } from '@prisma/client';
import { SkillManifestSchema, type SkillManifest } from '@skillwharf/shared';
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

@Injectable()
export class SkillsService {
  constructor(private readonly prisma: PrismaService) {}

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

import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
  type OnModuleInit,
} from '@nestjs/common';
import { Prisma, type InstalledSkill } from '@prisma/client';
import { SkillManifestSchema, type SkillManifest } from '@skillwharf/shared';
import AdmZip from 'adm-zip';
import { existsSync, globSync, readFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { parse } from 'yaml';
import { PrismaService } from '../prisma/prisma.service.js';

export interface SkillValidationResult {
  valid: boolean;
  errors: string[];
}

/** Результат установки: запись каталога плюс предупреждения skill-vetter. */
export type SkillInstallResult = InstalledSkill & {
  warning?: string;
  danger?: string;
};

/** Предупреждение о разрешениях, которые дают доступ к сети или терминалу. */
export const SKILL_PERMISSION_WARNING = 'Навык требует доступ к сети/терминалу';

/** Предупреждение об опасных конструкциях в коде навыка. */
export const SKILL_CODE_DANGER = 'Навык содержит потенциально опасный код';

/** Разрешения, требующие отдельного внимания пользователя. */
const DANGEROUS_PERMISSIONS = new Set(['shell', 'network']);

/** Паттерны потенциально опасного кода в манифесте. */
const DANGEROUS_CODE_PATTERNS = [
  /\brm\s+-rf\b/,
  /\bcurl\b[^\n|]*\|\s*(?:ba)?sh\b/,
  /\beval\s*\(/,
];

type ManifestParseResult =
  | { success: true; manifest: SkillManifest; raw: Record<string, unknown> }
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
   * Перед сохранением выполняется проверка skill-vetter.
   */
  async installSkill(fileContent: string): Promise<SkillInstallResult> {
    const result = this.parseManifest(fileContent);

    if (!result.success) {
      throw new BadRequestException({
        message: 'Некорректный манифест навыка',
        errors: result.errors,
      });
    }

    const vetting = this.vetManifest(result.raw);
    const installed = await this.persistSkillManifest(result.manifest, true);

    return { ...installed, ...vetting };
  }

  /**
   * Импорт навыка из ZIP-архива OpenClaw. Архив читается в памяти: ищем
   * `SKILL.md` в корне или вложенной папке, валидируем YAML и прогоняем
   * skill-vetter. Опасный код блокирует импорт.
   */
  async importFromZip(archive: Buffer): Promise<SkillInstallResult> {
    let zip: AdmZip;

    try {
      zip = new AdmZip(archive);
    } catch {
      throw new BadRequestException('Не удалось прочитать ZIP-архив');
    }

    const skillEntry = zip
      .getEntries()
      .find(
        (entry) =>
          !entry.isDirectory &&
          basename(entry.entryName).toLowerCase() === 'skill.md',
      );

    if (!skillEntry) {
      throw new BadRequestException('В архиве не найден SKILL.md');
    }

    let fileContent: string;

    try {
      fileContent = skillEntry.getData().toString('utf8');
    } catch {
      throw new BadRequestException('Не удалось прочитать SKILL.md из архива');
    }

    const result = this.parseManifest(fileContent);

    if (!result.success) {
      throw new BadRequestException({
        message: 'Некорректный манифест навыка',
        errors: result.errors,
      });
    }

    const vetting = this.vetManifest(result.raw);

    if (vetting.danger !== undefined) {
      throw new BadRequestException('Ошибка: найдены опасные команды');
    }

    const installed = await this.persistSkillManifest(result.manifest, true);

    return { ...installed, ...vetting };
  }

  /** Список всех установленных навыков (каталог). */
  getInstalledSkills(): Promise<InstalledSkill[]> {
    return this.prisma.installedSkill.findMany({
      orderBy: { installedAt: 'desc' },
    });
  }

  /**
   * Включённые навыки. По их манифестам ChatService определяет цену
   * инструментов для динамического paywall.
   */
  getEnabledSkills(): Promise<InstalledSkill[]> {
    return this.prisma.installedSkill.findMany({
      where: { isEnabled: true },
      orderBy: { name: 'asc' },
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
      const result = this.parseManifest(
        readFileSync(join(directory, file), 'utf8'),
      );

      if (!result.success) {
        // Битый манифест логируем, но не блокируем старт API.
        this.logger.error(
          `Не удалось загрузить ${file}: ${result.errors.join('; ')}`,
        );
        continue;
      }

      // isEnabled не сбрасываем: админ мог выключить навык в каталоге.
      await this.persistSkillManifest(result.manifest, false);
      seeded += 1;
    }

    this.logger.log(`Стартовые навыки загружены: ${seeded}/${files.length}`);

    return seeded;
  }

  /**
   * Upsert навыка по имени. При ручной установке навык включается, а при
   * сидинге флаг `isEnabled` не трогаем — иначе рестарт сбрасывал бы выбор
   * администратора.
   */
  private persistSkillManifest(
    manifest: SkillManifest,
    enableOnUpdate: boolean,
  ): Promise<InstalledSkill> {
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
        ...(enableOnUpdate ? { isEnabled: true } : {}),
      },
    });
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

  /**
   * Skill-vetter: проверяет разрешения и код из манифеста. Не блокирует
   * установку, а возвращает флаги, которые клиент показывает пользователю.
   */
  private vetManifest(
    raw: Record<string, unknown>,
  ): Pick<SkillInstallResult, 'warning' | 'danger'> {
    const permissions = Array.isArray(raw.permissions) ? raw.permissions : [];
    const needsAttention = permissions.some((permission) =>
      DANGEROUS_PERMISSIONS.has(String(permission)),
    );

    const code = manifestCode(raw);
    const hasDangerousCode =
      code.length > 0 &&
      DANGEROUS_CODE_PATTERNS.some((pattern) => pattern.test(code));

    return {
      ...(needsAttention ? { warning: SKILL_PERMISSION_WARNING } : {}),
      ...(hasDangerousCode ? { danger: SKILL_CODE_DANGER } : {}),
    };
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
      return {
        success: true,
        manifest: result.data,
        // Zod отбрасывает неописанные поля (`code`), а skill-vetter
        // проверяет сырой манифест — поэтому храним его отдельно.
        raw: parsed as Record<string, unknown>,
      };
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
 * Достаёт код из сырого манифеста. Поддерживается `code` строкой
 * (YAML block scalar) или объектом/массивом — тогда он сериализуется.
 */
function manifestCode(raw: Record<string, unknown>): string {
  const code = raw.code;

  if (typeof code === 'string') {
    return code;
  }

  if (code === undefined || code === null) {
    return '';
  }

  return JSON.stringify(code);
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

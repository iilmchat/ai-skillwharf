import { Injectable } from '@nestjs/common';
import { SkillManifestSchema } from '@skillwharf/shared';
import { parse } from 'yaml';

export interface SkillValidationResult {
  valid: boolean;
  errors: string[];
}

/** YAML frontmatter: блок между первыми строками `---`. */
const FRONTMATTER_PATTERN = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/;

@Injectable()
export class SkillsService {
  /**
   * Парсит YAML-заголовок SKILL.md и валидирует его Zod-схемой
   * `SkillManifestSchema` из `@skillwharf/shared`.
   */
  validateManifest(fileContent: string): SkillValidationResult {
    const content = fileContent.replace(/^\uFEFF/, '');
    const frontmatter = FRONTMATTER_PATTERN.exec(content);

    if (!frontmatter || frontmatter[1] === undefined) {
      return {
        valid: false,
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
        valid: false,
        errors: [`Не удалось распарсить YAML frontmatter: ${reason}`],
      };
    }

    const result = SkillManifestSchema.safeParse(parsed);

    if (result.success) {
      return { valid: true, errors: [] };
    }

    return {
      valid: false,
      errors: result.error.issues.map((issue) => {
        const path = issue.path.length > 0 ? issue.path.join('.') : 'manifest';

        return `${path}: ${issue.message}`;
      }),
    };
  }
}

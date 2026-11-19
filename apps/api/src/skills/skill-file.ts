import { SkillManifestSchema, type SkillManifest } from '@skillwharf/shared';
import { parse } from 'yaml';

/** YAML frontmatter: блок между первыми строками `---`. */
export const FRONTMATTER_PATTERN = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/;

export interface ParsedSkillFile {
  readonly manifest: SkillManifest;
  /** Markdown Body между закрывающим `---` и концом файла. */
  readonly body: string;
  /** Сырой frontmatter до Zod (для skill-vetter). */
  readonly raw: Record<string, unknown>;
}

export type SkillFileParseResult =
  | { success: true; value: ParsedSkillFile }
  | { success: false; errors: string[] };

/**
 * Разбирает SKILL.md один раз для установки и для проверки подписи:
 * канонический body и манифест должны быть идентичны в обоих путях.
 */
export function parseSkillFile(fileContent: string): SkillFileParseResult {
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

  if (!result.success) {
    return {
      success: false,
      errors: result.error.issues.map((issue) => {
        const path = issue.path.length > 0 ? issue.path.join('.') : 'manifest';

        return `${path}: ${issue.message}`;
      }),
    };
  }

  return {
    success: true,
    value: {
      manifest: result.data,
      body: content.slice(frontmatter[0].length),
      raw: parsed as Record<string, unknown>,
    },
  };
}

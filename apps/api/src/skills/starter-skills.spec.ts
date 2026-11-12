import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SkillManifestSchema } from '@skillwharf/shared';
import { parse } from 'yaml';

/** Каталог `starter-skills` в корне репозитория. */
const STARTER_SKILLS_DIR = fileURLToPath(
  new URL('../../../../starter-skills/', import.meta.url),
);

/** YAML frontmatter: блок между первыми строками `---`. */
const FRONTMATTER_PATTERN = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/;

const STARTER_SKILLS = [
  '01-external-data/tavily-search/SKILL.md',
  '02-work-tools/github/SKILL.md',
  '03-automation/cron-automation/SKILL.md',
  '04-security/skill-vetter/SKILL.md',
] as const;

describe('starter skills', () => {
  it.each(STARTER_SKILLS)('валидирует манифест %s', (relativePath) => {
    const content = readFileSync(
      join(STARTER_SKILLS_DIR, relativePath),
      'utf8',
    );
    const frontmatter = FRONTMATTER_PATTERN.exec(content);

    expect(
      frontmatter,
      `в ${relativePath} не найден YAML frontmatter`,
    ).not.toBeNull();

    const yaml = frontmatter?.[1];

    if (yaml === undefined) {
      throw new Error(`Не удалось прочитать YAML frontmatter: ${relativePath}`);
    }

    const result = SkillManifestSchema.safeParse(parse(yaml));
    const errors = result.success
      ? []
      : result.error.issues.map((issue) => {
          const path = issue.path.length > 0 ? issue.path.join('.') : 'manifest';

          return `${path}: ${issue.message}`;
        });

    expect(result.success, errors.join('; ')).toBe(true);
  });
});

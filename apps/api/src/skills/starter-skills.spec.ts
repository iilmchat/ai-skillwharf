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
  '05-utility/code-runner/SKILL.md',
  '06-marketplace/ozon-seller/SKILL.md',
  '06-marketplace/wb-seller/SKILL.md',
  '07-communication/messenger-connector/SKILL.md',
  '08-productivity/google-workspace/SKILL.md',
  '09-creative/midjourney-api/SKILL.md',
  '10-orchestration/workflow-orchestrator/SKILL.md',
  '11-content/dzen-article/SKILL.md',
  '12-content/fact-checker/SKILL.md',
  '13-hr/resume-screener/SKILL.md',
  '14-legal/document-analyzer/SKILL.md',
  '15-finance/unit-economics/SKILL.md',
  '15-finance/profit-leak-detector/SKILL.md',
  '15-finance/price-monitor/SKILL.md',
  '15-finance/fraud-shield-audit/SKILL.md',
  '16-documents/pdf-extractor/SKILL.md',
  '16-documents/docx-writer/SKILL.md',
  '16-documents/ocr-smart-engine/SKILL.md',
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
          const path =
            issue.path.length > 0 ? issue.path.join('.') : 'manifest';

          return `${path}: ${issue.message}`;
        });

    expect(result.success, errors.join('; ')).toBe(true);
  });
});

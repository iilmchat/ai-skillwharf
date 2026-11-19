// Подпись SKILL.md: pnpm --filter api skill:sign <path-to-SKILL.md>
//
// Env:
//   SKILL_SIGNING_PRIVATE_KEY — base64 PKCS#8 Ed25519 (см. skill:keygen)
//   SKILL_SIGNING_KEY_ID      — keyId издателя (по умолчанию author-key)
// Выводит готовые поля для frontmatter: signature и publicKeyId.
import { readFileSync } from 'node:fs';
import { SkillManifestSchema, signSkillManifest } from '@skillwharf/shared';
import { parse } from 'yaml';

const filePath = process.argv[2];

if (!filePath) {
  console.error('Использование: skill:sign <path-to-SKILL.md>');
  process.exit(1);
}

const privateKey = (process.env.SKILL_SIGNING_PRIVATE_KEY ?? '').trim();
const keyId = (process.env.SKILL_SIGNING_KEY_ID ?? 'author-key').trim();

if (privateKey === '') {
  console.error('SKILL_SIGNING_PRIVATE_KEY не задан');
  process.exit(1);
}

try {
  const content = readFileSync(filePath, 'utf8').replace(/^\uFEFF/, '');
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(content);

  if (!match || match[1] === undefined) {
    throw new Error('YAML frontmatter не найден');
  }

  const manifest = SkillManifestSchema.parse(parse(match[1]));
  const bodyStart = match[0].length;
  const body = content.slice(bodyStart);
  const signature = signSkillManifest({ manifest, body }, privateKey);

  console.log(JSON.stringify({ signature, publicKeyId: keyId }, null, 2));
} catch (error) {
  console.error(`skill:sign: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}

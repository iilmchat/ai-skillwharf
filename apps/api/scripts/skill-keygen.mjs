// Генерация тестовой пары Ed25519-ключей для подписи SKILL.md (API-27.1).
// Приватный ключ — только у издателя; публичный попадает в
// TRUSTED_SKILL_PUBLIC_KEYS с выбранным keyId.
import { generateSkillKeyPair } from '@skillwharf/shared';

const pair = generateSkillKeyPair();

console.log(JSON.stringify(pair, null, 2));
console.error(
  'Сохраните privateKey в секретном хранилище. publicKey добавьте в TRUSTED_SKILL_PUBLIC_KEYS как <keyId>:<publicKey>.',
);

import { ApiException } from '../common/api-error.js';
import {
  generateSkillKeyPair,
  signSkillManifest,
  type SkillManifest,
} from '@skillwharf/shared';
import { describe, expect, it } from 'vitest';
import { SkillSignatureService } from './skill-signature.service.js';

const manifest: SkillManifest = {
  name: 'signed-skill',
  version: '1.0.0',
  description: 'Подписанный навык',
  author: { name: 'Author' },
  permissions: [],
};
const body = '\n# Instructions\n';

function file(signature?: string, keyId = 'author-key'): string {
  return `---
name: signed-skill
version: 1.0.0
description: Подписанный навык
author:
  name: Author
permissions: []
${signature === undefined ? '' : `signature: ${signature}\npublicKeyId: ${keyId}\n`}---
${body}`;
}

describe('SkillSignatureService (API-27.1)', () => {
  it('по умолчанию пропускает неподписанные локальные навыки', () => {
    const service = new SkillSignatureService({});

    expect(service.verify(file())).toEqual({ verified: false, signed: false });
  });

  it('проверяет валидную подпись по доверенному keyId', () => {
    const pair = generateSkillKeyPair();
    const signature = signSkillManifest({ manifest, body }, pair.privateKey);
    const service = new SkillSignatureService({
      TRUSTED_SKILL_PUBLIC_KEYS: `author-key:${pair.publicKey}`,
    });

    expect(service.verify(file(signature))).toEqual({
      verified: true,
      signed: true,
      keyId: 'author-key',
    });
  });

  it('отвергает подмену тела и неизвестный keyId единым JSON-исключением', () => {
    const pair = generateSkillKeyPair();
    const signature = signSkillManifest({ manifest, body }, pair.privateKey);
    const service = new SkillSignatureService({
      TRUSTED_SKILL_PUBLIC_KEYS: `author-key:${pair.publicKey}`,
    });

    expect(() =>
      service.verify(file(signature).replace('Instructions', 'InstructionX')),
    ).toThrow(ApiException);
    expect(() => service.verify(file(signature, 'unknown'))).toThrow(
      /Неизвестный keyId/,
    );
  });

  it('REQUIRE_SIGNED_SKILLS=true блокирует неподписанные навыки', () => {
    const service = new SkillSignatureService({ REQUIRE_SIGNED_SKILLS: 'true' });

    expect(() => service.assertInstallable(file())).toThrow(
      /должен быть подписан/,
    );
  });

  it('невалидный реестр ключей — ошибка старта (fail closed)', () => {
    expect(
      () =>
        new SkillSignatureService({
          TRUSTED_SKILL_PUBLIC_KEYS: 'bad-key:not-base64!!',
        }),
    ).toThrow();
  });
});

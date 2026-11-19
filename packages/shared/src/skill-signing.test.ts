import { describe, expect, it } from 'vitest';
import {
  skillManifestSchema,
  type SkillManifest,
} from './skill-manifest.js';
import {
  canonicalSkillPayload,
  findTrustedKey,
  generateSkillKeyPair,
  parseTrustedSkillPublicKeys,
  signSkillManifest,
  verifySkillSignature,
} from './skill-signing.js';

const manifest: SkillManifest = {
  name: 'web-researcher-pro',
  version: '1.2.0',
  description: 'Ищет информацию и проверяет источники.',
  author: { name: 'Ivan Petrov', email: 'ivan@example.com' },
  dependencies: { tools: ['web_search'] },
  permissions: ['network'],
  pricing: { model: 'Pay-per-Call', price: 5, currency: 'RUB' },
};

const body = '\n# Инструкции\n\nИспользуй web_search.\n';

describe('Ed25519 подпись SKILL.md (API-27.1)', () => {
  it('генерирует пару ключей и валидирует схему манифеста с signature/publicKeyId', () => {
    const pair = generateSkillKeyPair();

    expect(pair.publicKey.length).toBeGreaterThan(0);
    expect(pair.privateKey.length).toBeGreaterThan(0);

    const signed: SkillManifest = {
      ...manifest,
      publicKeyId: 'author-key',
      signature: signSkillManifest({ manifest, body }, pair.privateKey),
    };

    expect(signed.signature).toMatch(/^ed25519:/);
    expect(skillManifestSchema.safeParse(signed).success).toBe(true);
    expect(
      skillManifestSchema.safeParse({ ...signed, publicKeyId: 'BAD_KEY' }).success,
    ).toBe(false);
  });

  it('принимает подпись и отвергает подмену одного символа в теле SKILL.md', () => {
    const pair = generateSkillKeyPair();
    const signature = signSkillManifest({ manifest, body }, pair.privateKey);

    expect(verifySkillSignature({ manifest, body }, signature, pair.publicKey)).toBe(
      true,
    );

    let tamperedBody = body;

    if (tamperedBody.startsWith('\n')) {
      tamperedBody = ` ${tamperedBody.slice(1)}`; // заменили перевод строки на пробел
    } else {
      tamperedBody = `${tamperedBody.slice(0, -1)}X`;
    }

    expect(
      verifySkillSignature(
        { manifest, body: tamperedBody },
        signature,
        pair.publicKey,
      ),
    ).toBe(false);
  });

  it('отвергает подмену манифеста и чужой ключ', () => {
    const pair = generateSkillKeyPair();
    const other = generateSkillKeyPair();
    const signature = signSkillManifest({ manifest, body }, pair.privateKey);

    expect(
      verifySkillSignature(
        { manifest: { ...manifest, version: '1.2.1' }, body },
        signature,
        pair.publicKey,
      ),
    ).toBe(false);
    expect(
      verifySkillSignature({ manifest, body }, signature, other.publicKey),
    ).toBe(false);
  });

  it('каноническая сериализация не зависит от порядка ключей и исключает signature', () => {
    const a = canonicalSkillPayload({ manifest, body });
    const b = canonicalSkillPayload({
      manifest: {
        permissions: ['network'],
        name: 'web-researcher-pro',
        version: '1.2.0',
        description: 'Ищет информацию и проверяет источники.',
        dependencies: { tools: ['web_search'] },
        author: { email: 'ivan@example.com', name: 'Ivan Petrov' },
        pricing: { currency: 'RUB', price: 5, model: 'Pay-per-Call' },
      },
      body,
    });

    expect(a).toBe(b);
    expect(a).not.toContain('signature');
  });

  it('парсит реестр доверенных ключей в JSON и CSV форматах', () => {
    const pair = generateSkillKeyPair();
    const fromJson = parseTrustedSkillPublicKeys(
      JSON.stringify({ 'author-key': pair.publicKey }),
    );
    const fromCsv = parseTrustedSkillPublicKeys(
      `author-key:${pair.publicKey}`,
    );

    expect(fromJson).toEqual([{ keyId: 'author-key', publicKey: pair.publicKey }]);
    expect(fromCsv).toEqual(fromJson);
    expect(findTrustedKey(fromJson, 'author-key')).toEqual(fromJson[0]);
    expect(findTrustedKey(fromJson, 'unknown')).toBeUndefined();
    expect(parseTrustedSkillPublicKeys(undefined)).toEqual([]);
    expect(() => parseTrustedSkillPublicKeys('author-key:not-base64!!')).toThrow();
  });
});

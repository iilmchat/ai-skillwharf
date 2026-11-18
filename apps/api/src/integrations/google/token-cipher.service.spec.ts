import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { ApiException } from '../../common/api-error.js';
import {
  LocalAesGcmKms,
  parsePreviousKeys,
  TokenCipherService,
} from './token-cipher.service.js';

const KEY = randomBytes(32);
const OLD_KEY = randomBytes(32);

function legacyEnvelope(key: Buffer, plaintext: string): string {
  const payload = new LocalAesGcmKms(key, 'local-v0').encrypt(
    Buffer.from(plaintext, 'utf8'),
  );

  return [
    'v1',
    payload.iv.toString('base64'),
    payload.tag.toString('base64'),
    payload.ciphertext.toString('base64'),
  ].join(':');
}

describe('TokenCipherService', () => {
  it('шифрует и расшифровывает refresh-token в формате v2 с keyId', () => {
    const cipher = new TokenCipherService(KEY);
    const plaintext = '1//0g-refresh-token-example';
    const encrypted = cipher.encrypt(plaintext);
    const parts = encrypted.split(':');

    expect(parts).toHaveLength(5);
    expect(parts[0]).toBe('v2');
    expect(parts[1]).toBe('local-v1');
    expect(encrypted).not.toContain(plaintext);
    expect(cipher.decrypt(encrypted)).toBe(plaintext);
  });

  it('использует случайный IV: одинаковые токены дают разные ciphertext', () => {
    const cipher = new TokenCipherService(KEY);

    expect(cipher.encrypt('same')).not.toBe(cipher.encrypt('same'));
  });

  it('не расшифровывает подменённый ciphertext', () => {
    const cipher = new TokenCipherService(KEY);
    const parts = cipher.encrypt('refresh-token').split(':');
    const tampered = [
      parts[0],
      parts[1],
      parts[2],
      parts[3],
      Buffer.from('evil').toString('base64'),
    ].join(':');

    expect(() => cipher.decrypt(tampered)).toThrow();
  });

  it('падает с provider_not_configured без ключа', () => {
    const cipher = new TokenCipherService();

    expect(cipher.isConfigured()).toBe(false);
    expect(() => cipher.encrypt('token')).toThrow(ApiException);
    expect(() => cipher.encrypt('token')).toThrow(/TOKEN_ENCRYPTION_KEY/);
  });

  it('публикует keyId для аудита и помечает старые envelope', () => {
    const previous = process.env.TOKEN_ENCRYPTION_KEY_ID;
    process.env.TOKEN_ENCRYPTION_KEY_ID = 'test-key-2';

    try {
      const cipher = new TokenCipherService(KEY);

      expect(cipher.keyId).toBe('test-key-2');
      expect(cipher.needsRotation(cipher.encrypt('x'))).toBe(false);
      expect(cipher.needsRotation(legacyEnvelope(KEY, 'x'))).toBe(true);
    } finally {
      if (previous === undefined) {
        delete process.env.TOKEN_ENCRYPTION_KEY_ID;
      } else {
        process.env.TOKEN_ENCRYPTION_KEY_ID = previous;
      }
    }
  });

  it('читает старый формат v1 активным и предыдущим ключом', () => {
    const current = new TokenCipherService(KEY, { keyId: 'local-v2' });

    expect(current.decrypt(legacyEnvelope(KEY, 'current'))).toBe('current');

    const withPrevious = new TokenCipherService(KEY, {
      keyId: 'local-v2',
      previousKeys: new Map([['local-v0', OLD_KEY]]),
    });

    expect(withPrevious.decrypt(legacyEnvelope(OLD_KEY, 'previous'))).toBe(
      'previous',
    );
  });

  it('расшифровывает v2 предыдущего keyId через previous keys из env (CSV)', () => {
    const previousId = process.env.TOKEN_ENCRYPTION_KEY_ID;
    const previousKeys = process.env.TOKEN_ENCRYPTION_PREVIOUS_KEYS;
    process.env.TOKEN_ENCRYPTION_KEY_ID = 'local-v2';
    process.env.TOKEN_ENCRYPTION_PREVIOUS_KEYS = `local-v0:${OLD_KEY.toString('base64')}`;

    try {
      const oldCipher = new TokenCipherService(OLD_KEY, { keyId: 'local-v0' });
      const oldEnvelope = oldCipher.encrypt('old-secret');
      const current = new TokenCipherService(KEY);

      expect(current.needsRotation(oldEnvelope)).toBe(true);
      expect(current.decrypt(oldEnvelope)).toBe('old-secret');
    } finally {
      if (previousId === undefined) {
        delete process.env.TOKEN_ENCRYPTION_KEY_ID;
      } else {
        process.env.TOKEN_ENCRYPTION_KEY_ID = previousId;
      }
      if (previousKeys === undefined) {
        delete process.env.TOKEN_ENCRYPTION_PREVIOUS_KEYS;
      } else {
        process.env.TOKEN_ENCRYPTION_PREVIOUS_KEYS = previousKeys;
      }
    }
  });

  it('отвергает неизвестный keyId и невалидные previous keys', () => {
    const cipher = new TokenCipherService(KEY);
    const unknown = ['v2', 'missing-key', 'AAAA', 'AAAA', 'AAAA'].join(':');

    expect(() => cipher.decrypt(unknown)).toThrow(/keyId/);
    expect(() => parsePreviousKeys('local-v0:not-a-key')).toThrow();
    expect(() => parsePreviousKeys('{"k":"YWJj"}')).toThrow();
    expect(parsePreviousKeys(undefined).size).toBe(0);
  });

  it('parsePreviousKeys поддерживает JSON-объект и массив', () => {
    const encoded = OLD_KEY.toString('base64');

    expect(parsePreviousKeys(JSON.stringify({ 'local-v0': encoded })).get('local-v0')).toEqual(
      OLD_KEY,
    );
    expect(
      parsePreviousKeys(
        JSON.stringify([{ keyId: 'local-v0', key: encoded }]),
      ).get('local-v0'),
    ).toEqual(OLD_KEY);
  });
});

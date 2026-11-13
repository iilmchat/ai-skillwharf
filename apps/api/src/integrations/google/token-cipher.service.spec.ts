import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { ApiException } from '../../common/api-error.js';
import { TokenCipherService } from './token-cipher.service.js';

const KEY = randomBytes(32);

describe('TokenCipherService', () => {
  it('шифрует и расшифровывает refresh-token', () => {
    const cipher = new TokenCipherService(KEY);
    const plaintext = '1//0g-refresh-token-example';
    const encrypted = cipher.encrypt(plaintext);

    expect(encrypted).not.toContain(plaintext);
    expect(encrypted.startsWith('v1:')).toBe(true);
    expect(cipher.decrypt(encrypted)).toBe(plaintext);
  });

  it('использует случайный IV: одинаковые токены дают разные ciphertext', () => {
    const cipher = new TokenCipherService(KEY);

    expect(cipher.encrypt('same')).not.toBe(cipher.encrypt('same'));
  });

  it('не расшифровывает подменённый ciphertext', () => {
    const cipher = new TokenCipherService(KEY);
    const encrypted = cipher.encrypt('refresh-token');
    const parts = encrypted.split(':');
    const tampered = `${parts[0]}:${parts[1]}:${parts[2]}:${Buffer.from('evil').toString('base64')}`;

    expect(() => cipher.decrypt(tampered)).toThrow();
  });

  it('падает с provider_not_configured без ключа', () => {
    const cipher = new TokenCipherService();

    expect(cipher.isConfigured()).toBe(false);
    expect(() => cipher.encrypt('token')).toThrow(ApiException);
    expect(() => cipher.encrypt('token')).toThrow(/TOKEN_ENCRYPTION_KEY/);
  });

  it('публикует keyId для аудита', () => {
    const previous = process.env.TOKEN_ENCRYPTION_KEY_ID;
    process.env.TOKEN_ENCRYPTION_KEY_ID = 'test-key-2';

    try {
      expect(new TokenCipherService(KEY).keyId).toBe('test-key-2');
    } finally {
      if (previous === undefined) {
        delete process.env.TOKEN_ENCRYPTION_KEY_ID;
      } else {
        process.env.TOKEN_ENCRYPTION_KEY_ID = previous;
      }
    }
  });
});

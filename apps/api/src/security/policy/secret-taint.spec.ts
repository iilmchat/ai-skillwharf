import {
  REDACTED_VALUE,
  containsSecretValue,
  extractSecretCandidates,
  maskSecretValues,
} from './secret-taint.js';

const GITHUB_TOKEN = 'ghp_a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8';
const OPENAI_TOKEN = 'sk-a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8';

describe('secret-taint', () => {
  describe('extractSecretCandidates', () => {
    it('находит GitHub PAT, OpenAI-ключ и AWS access key', () => {
      const text = `токены: ${GITHUB_TOKEN} и ${OPENAI_TOKEN} и AKIAIOSFODNN7EXAMPLE`;

      expect(extractSecretCandidates(text)).toEqual(
        expect.arrayContaining([GITHUB_TOKEN, OPENAI_TOKEN]),
      );
      expect(extractSecretCandidates(text).join(' ')).toContain(
        'AKIAIOSFODNN7EXAMPLE',
      );
    });

    it('находит Яндекс OAuth, JWT, Slack и Bearer-токены', () => {
      const yandex = `ya29.${'a'.repeat(30)}`;
      const jwt =
        'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.' +
        'dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U';
      const slack = 'xoxb-123456789012-abcdefghijkl';
      const bearer = `Bearer ${'t'.repeat(24)}`;

      const candidates = extractSecretCandidates(
        `${yandex} ${jwt} ${slack} ${bearer}`,
      );

      expect(candidates).toContain(yandex);
      expect(candidates).toContain(jwt);
      expect(candidates).toContain(slack);
      expect(candidates).toContain('t'.repeat(24));
    });

    it('находит PEM-блок приватного ключа целиком', () => {
      const pem =
        '-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA\n-----END RSA PRIVATE KEY-----';
      const candidates = extractSecretCandidates(`ключ:\n${pem}`);

      expect(candidates).toContain(pem);
    });

    it('не считает секретом обычный текст и короткие токены', () => {
      expect(
        extractSecretCandidates(
          'обычный текст про password и sk-короткий, ghp_short',
        ),
      ).toEqual([]);
    });
  });

  describe('maskSecretValues', () => {
    it('маскирует секрет в строке, массиве и объекте', () => {
      const result = maskSecretValues(
        {
          query: `найди ${GITHUB_TOKEN}`,
          rows: [[GITHUB_TOKEN], 'ok'],
          nested: { token: GITHUB_TOKEN, count: 3 },
        },
        [GITHUB_TOKEN],
      );

      expect(result.masked).toBe(true);
      expect(JSON.stringify(result.value)).not.toContain(GITHUB_TOKEN);
      expect(JSON.stringify(result.value)).toContain(REDACTED_VALUE);
      expect(result.value).toMatchObject({ nested: { count: 3 } });
    });

    it('возвращает исходное значение, если секретов нет', () => {
      const value = { query: 'погода' };

      const result = maskSecretValues(value, [GITHUB_TOKEN]);

      expect(result.masked).toBe(false);
      expect(result.value).toBe(value);
    });

    it('не маскирует при пустом списке секретов', () => {
      const value = { query: GITHUB_TOKEN };

      expect(maskSecretValues(value, []).masked).toBe(false);
      expect(maskSecretValues(value, ['']).masked).toBe(false);
    });
  });

  describe('containsSecretValue', () => {
    it('находит секрет на любой глубине', () => {
      const value = { a: [{ b: `Bearer ${OPENAI_TOKEN}` }] };

      expect(containsSecretValue(value, [OPENAI_TOKEN])).toBe(true);
    });

    it('возвращает false для чистого значения', () => {
      expect(containsSecretValue({ query: 'погода' }, [GITHUB_TOKEN])).toBe(
        false,
      );
    });
  });
});

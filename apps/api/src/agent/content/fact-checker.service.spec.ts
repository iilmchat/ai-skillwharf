import nock from 'nock';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ApiException } from '../../common/api-error.js';
import { ERROR_KEYS } from '../../i18n/error-keys.js';
import {
  FactCheckerService,
  checkClaim,
  claimTokens,
  domainOf,
  extractClaims,
  extractNumbers,
} from './fact-checker.service.js';

const TAVILY_HOST = 'https://api.tavily.com';

const ENV_KEYS = [
  'TAVILY_API_KEY',
  'OUTBOUND_ALLOWLIST',
  'PROVIDER_RETRY_MAX_ATTEMPTS',
  'PROVIDER_RETRY_BASE_DELAY_MS',
  'PROVIDER_RETRY_MAX_DELAY_MS',
] as const;

let saved: Record<string, string | undefined> = {};

beforeEach(() => {
  saved = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));

  for (const key of ENV_KEYS) {
    delete process.env[key];
  }

  process.env.OUTBOUND_ALLOWLIST = 'api.tavily.com';
  process.env.PROVIDER_RETRY_BASE_DELAY_MS = '1';
  process.env.PROVIDER_RETRY_MAX_DELAY_MS = '1';
});

afterEach(() => {
  nock.cleanAll();

  for (const key of ENV_KEYS) {
    const value = saved[key];

    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
});

/** Один результат Tavily. */
function result(
  url: string,
  content: string,
  title = 'Источник',
): { title: string; url: string; content: string } {
  return { title, url, content };
}

describe('extractClaims', () => {
  const TEXT =
    'Компания выросла на 25% за 2025 год. Это было интересное время для всех. ' +
    'В Москве открылось 12 новых офисов. Слишком коротко. ' +
    'Выручка достигла 1 500 000 рублей по итогам квартала.';

  it('сначала берёт утверждения с числами', () => {
    const claims = extractClaims(TEXT, 2);

    expect(claims[0]).toContain('25%');
    expect(claims[1]).toContain('12 новых офисов');
  });

  it('отбрасывает короткие и слишком длинные предложения', () => {
    const claims = extractClaims('Слишком коротко. ' + 'а'.repeat(500) + '.', 5);

    expect(claims).toEqual([]);
  });

  it('уважает лимит maxClaims', () => {
    expect(extractClaims(TEXT, 1)).toHaveLength(1);
  });
});

describe('claimTokens / extractNumbers / domainOf', () => {
  it('оставляет значимые слова (числа проверяются отдельно)', () => {
    expect(claimTokens('Выручка составила 1500 рублей в 2025 году')).toEqual([
      'выручка',
      'составила',
      'рублей',
      'году',
    ]);
    expect(extractNumbers('1 500 000 рублей и 25%')).toEqual([
      '1 500 000',
      '25',
    ]);
    expect(domainOf('https://www.example.com/news')).toBe('www.example.com');
    expect(domainOf('not a url')).toBe('not a url');
  });
});

describe('checkClaim', () => {
  const CLAIM = 'Выручка компании составила 1 500 000 рублей за 2025 год';

  it('два независимых домена дают supported', () => {
    const check = checkClaim(CLAIM, [
      result(
        'https://a.example/news',
        'Выручка компании составила 1 500 000 рублей за 2025 год',
      ),
      result(
        'https://b.example/report',
        'По итогам 2025 года выручка компании составила 1 500 000 рублей',
      ),
    ]);

    expect(check.verdict).toBe('supported');
    expect(check.confidence).toBeGreaterThanOrEqual(0.6);
    expect(check.sources.filter((source) => source.supports)).toHaveLength(2);
  });

  it('один домен даёт single_source', () => {
    const check = checkClaim(CLAIM, [
      result(
        'https://a.example/news',
        'Выручка компании составила 1 500 000 рублей за 2025 год',
      ),
      result('https://a.example/other', 'Выручка компании составила 1 500 000 рублей'),
    ]);

    expect(check.verdict).toBe('single_source');
  });

  it('другие числа при похожем тексте дают contradicted', () => {
    const check = checkClaim(CLAIM, [
      result(
        'https://c.example/news',
        'Выручка компании составила 900 000 рублей за 2025 год',
      ),
    ]);

    expect(check.verdict).toBe('contradicted');
    expect(check.note).toContain('другие числа');
  });

  it('без результатов — unverified с честной причиной', () => {
    const check = checkClaim(CLAIM, []);

    expect(check).toMatchObject({
      verdict: 'unverified',
      confidence: 0.1,
      checkedSources: 0,
      note: 'нет результатов поиска',
    });
    expect(check.numbers).toEqual(['1 500 000', '2025']);
  });

  it('игнорирует пустые сниппеты', () => {
    const check = checkClaim(CLAIM, [
      { url: 'https://empty.example/page' },
    ]);

    expect(check.checkedSources).toBe(0);
  });
});

describe('FactCheckerService', () => {
  const service = new FactCheckerService();
  const TEXT =
    'Выручка компании составила 1 500 000 рублей за 2025 год. ' +
    'Штат вырос до 120 сотрудников к концу года.';

  it('требует TAVILY_API_KEY', async () => {
    const error: unknown = await service
      .check({ text: TEXT })
      .catch((caught: unknown) => caught);

    expect((error as ApiException).getResponse()).toMatchObject({
      statusCode: 503,
      code: ERROR_KEYS.providerNotConfigured,
    });
  });

  it('ищет по каждому утверждению и сводит вердикты', async () => {
    process.env.TAVILY_API_KEY = 'tvly-test';

    nock(TAVILY_HOST)
      .post('/search', (body: Record<string, unknown>) => {
        expect(body).toMatchObject({
          api_key: 'tvly-test',
          search_depth: 'basic',
          max_results: 5,
        });
        expect(String(body.query).toLowerCase()).toContain('выручка');

        return true;
      })
      .reply(200, {
        results: [
          result(
            'https://a.example/news',
            'Выручка компании составила 1 500 000 рублей за 2025 год',
          ),
          result(
            'https://b.example/report',
            'Выручка компании составила 1 500 000 рублей за 2025 год',
          ),
        ],
      });
    nock(TAVILY_HOST).post('/search').reply(200, { results: [] });

    const report = JSON.parse(
      await service.check({ text: TEXT, maxClaims: 2 }),
    ) as {
      claims: Array<{ verdict: string }>;
      summary: Record<string, number>;
      provider: string;
    };

    expect(report.provider).toBe('tavily');
    expect(report.claims[0]?.verdict).toBe('supported');
    expect(report.claims[1]?.verdict).toBe('unverified');
    expect(report.summary).toEqual({
      supported: 1,
      singleSource: 0,
      contradicted: 0,
      unverified: 1,
    });
  });

  it('ошибка провайдера не теряется: предупреждение и unverified', async () => {
    process.env.TAVILY_API_KEY = 'tvly-test';
    process.env.PROVIDER_RETRY_MAX_ATTEMPTS = '1';

    nock(TAVILY_HOST).post('/search').reply(500, { error: 'boom' });

    const report = JSON.parse(
      await service.check({ text: TEXT, maxClaims: 1 }),
    ) as {
      claims: Array<{ verdict: string; note: string }>;
      warnings: string[];
    };

    expect(report.claims[0]).toMatchObject({
      verdict: 'unverified',
      note: 'поиск недоступен',
    });
    expect(report.warnings.join(' ')).toContain('Tavily');
  });

  it('пустой текст не даёт утверждений', async () => {
    process.env.TAVILY_API_KEY = 'tvly-test';

    const report = JSON.parse(await service.check({ text: 'коротко' })) as {
      claims: unknown[];
      warnings: string[];
    };

    expect(report.claims).toEqual([]);
    expect(report.warnings).toContain(
      'в тексте не найдено утверждений для проверки',
    );
  });
});

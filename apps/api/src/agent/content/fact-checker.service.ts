import { Injectable, Logger } from '@nestjs/common';
import { z } from 'zod';
import { providerNotConfiguredError } from '../../common/api-error.js';
import { providerRequest } from '../../integrations/provider-http.js';
import {
  CheckFactsToolSchema,
  type CheckFactsToolArgs,
} from './content.schemas.js';

/**
 * Проверка фактов через Tavily и сравнение источников.
 *
 * Алгоритм прозрачен и намеренно консервативен:
 * 1. Текст делится на утверждения (предложения); проверяются не длиннее 400
 *    символов, в приоритете утверждения с числами и датами.
 * 2. Для каждого утверждения выполняется реальный поиск Tavily (`/search`).
 * 3. Каждый результат сравнивается с утверждением по пересечению значимых
 *    слов и по числам: источник «поддерживает» утверждение, если покрыто не
 *    меньше 60 % слов или найдены все числа/даты утверждения.
 * 4. Вердикт: `supported` — два независимых домена и больше, `single_source` —
 *    один домен, `contradicted` — высокая текстуальная близость без чисел
 *    утверждения при числах в источнике, иначе `unverified`.
 *
 * Инструмент не «подтверждает» факт без источников: `unverified` — это
 * честный результат, а не ошибка.
 */

const TAVILY_SEARCH_URL = 'https://api.tavily.com/search';

/** Сколько результатов запрашивать у Tavily. */
const MAX_RESULTS = 5;

/** Сколько источников показывать в ответе. */
const MAX_SOURCES = 3;

/** Минимальная длина проверяемого утверждения. */
const MIN_CLAIM_LENGTH = 20;

/** Максимальная длина проверяемого утверждения. */
const MAX_CLAIM_LENGTH = 400;

/** Порог текстуального совпадения для «поддержки». */
const SUPPORT_OVERLAP = 0.6;

/** Порог совпадения, при котором возможно противоречие. */
const CONTRADICTION_OVERLAP = 0.4;

const tavilyResultSchema = z
  .object({
    title: z.string().optional(),
    url: z.string(),
    content: z.string().optional(),
    score: z.number().optional(),
  })
  .passthrough();

const tavilyResponseSchema = z
  .object({
    answer: z.string().optional(),
    results: z.array(tavilyResultSchema).default([]),
  })
  .passthrough();

/** Источник, найденный по утверждению. */
export interface FactCheckSource {
  readonly title: string | null;
  readonly url: string;
  readonly domain: string;
  readonly excerpt: string;
  readonly overlap: number;
  readonly supports: boolean;
}

/** Результат проверки одного утверждения. */
export interface ClaimCheck {
  readonly claim: string;
  readonly verdict:
    | 'supported'
    | 'single_source'
    | 'contradicted'
    | 'unverified';
  readonly confidence: number;
  readonly numbers: readonly string[];
  readonly sources: readonly FactCheckSource[];
  readonly checkedSources: number;
  readonly note: string | null;
}

/** Итог проверки текста. */
export interface FactCheckReport {
  readonly tool: 'fact-checker';
  readonly provider: 'tavily';
  readonly claims: readonly ClaimCheck[];
  readonly summary: {
    readonly supported: number;
    readonly singleSource: number;
    readonly contradicted: number;
    readonly unverified: number;
  };
  readonly warnings: readonly string[];
}

@Injectable()
export class FactCheckerService {
  private readonly logger = new Logger(FactCheckerService.name);

  /**
   * Проверяет текст: поиск по каждому утверждению и сравнение источников.
   *
   * @throws ApiException 503, если `TAVILY_API_KEY` не задан
   */
  async check(rawArgs: unknown): Promise<string> {
    const args = CheckFactsToolSchema.parse(rawArgs) as CheckFactsToolArgs;
    const apiKey = process.env.TAVILY_API_KEY?.trim() ?? '';

    if (apiKey === '') {
      throw providerNotConfiguredError(
        'Tavily: задайте TAVILY_API_KEY в окружении Gateway',
      );
    }

    const claims = extractClaims(args.text, args.maxClaims ?? 5);
    const warnings: string[] = [];
    const checks: ClaimCheck[] = [];

    if (claims.length === 0) {
      warnings.push('в тексте не найдено утверждений для проверки');
    }

    for (const claim of claims) {
      try {
        const results = await this.search(
          claim,
          apiKey,
          args.searchDepth ?? 'basic',
        );

        if (results.length === 0) {
          warnings.push(`по утверждению «${shorten(claim)}» нет результатов`);
        }

        checks.push(checkClaim(claim, results));
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);

        this.logger.warn(
          JSON.stringify({ event: 'fact_check.search_failed', message }),
        );
        warnings.push(`Tavily: ${message}`);
        checks.push({
          claim,
          verdict: 'unverified',
          confidence: 0,
          numbers: extractNumbers(claim),
          sources: [],
          checkedSources: 0,
          note: 'поиск недоступен',
        });
      }
    }

    const report: FactCheckReport = {
      tool: 'fact-checker',
      provider: 'tavily',
      claims: checks,
      summary: {
        supported: checks.filter((check) => check.verdict === 'supported').length,
        singleSource: checks.filter((check) => check.verdict === 'single_source')
          .length,
        contradicted: checks.filter((check) => check.verdict === 'contradicted')
          .length,
        unverified: checks.filter((check) => check.verdict === 'unverified')
          .length,
      },
      warnings,
    };

    return JSON.stringify(report);
  }

  /** Один запрос к Tavily. */
  private async search(
    claim: string,
    apiKey: string,
    searchDepth: 'basic' | 'advanced',
  ): Promise<ReadonlyArray<z.infer<typeof tavilyResultSchema>>> {
    const payload = await providerRequest({
      provider: 'tavily',
      method: 'POST',
      url: TAVILY_SEARCH_URL,
      headers: { 'Content-Type': 'application/json' },
      data: {
        api_key: apiKey,
        query: shorten(claim, 380),
        search_depth: searchDepth,
        max_results: MAX_RESULTS,
        include_answer: false,
      },
      schema: tavilyResponseSchema,
      logger: this.logger,
    });

    return payload.results;
  }
}

/**
 * Делит текст на утверждения, приоритет — утверждения с числами/датами.
 *
 * @param maxClaims сколько утверждений вернуть
 */
export function extractClaims(text: string, maxClaims: number): string[] {
  const normalized = text.replace(/\s+/g, ' ').trim();
  const sentences = normalized
    .split(/(?<=[.!?])\s+/u)
    .map((sentence) => sentence.trim())
    .filter(
      (sentence) =>
        sentence.length >= MIN_CLAIM_LENGTH &&
        sentence.length <= MAX_CLAIM_LENGTH,
    );
  const numeric = sentences.filter((sentence) => extractNumbers(sentence).length > 0);
  const rest = sentences.filter((sentence) => !numeric.includes(sentence));
  const ordered = [...numeric, ...rest];

  return [...new Set(ordered)].slice(0, Math.max(1, maxClaims));
}

/** Проверяет одно утверждение по результатам поиска (без сети). */
export function checkClaim(
  claim: string,
  results: ReadonlyArray<z.infer<typeof tavilyResultSchema>>,
): ClaimCheck {
  const tokens = claimTokens(claim);
  const numbers = extractNumbers(claim);
  const sources: FactCheckSource[] = [];

  for (const result of results.slice(0, MAX_RESULTS)) {
    const snippet = `${result.title ?? ''} ${result.content ?? ''}`.trim();

    if (snippet === '') {
      continue;
    }

    const snippetTokens = new Set(claimTokens(snippet));
    const matched = tokens.filter((token) => snippetTokens.has(token));
    const overlap = tokens.length === 0 ? 0 : matched.length / tokens.length;
    const normalizedSnippet = normalizeDigits(snippet);
    const numbersFound = numbers.filter((number) =>
      normalizedSnippet.includes(normalizeDigits(number)),
    );
    // Числа утверждения обязательны: высокая текстовая близость не спасает,
    // если в источнике другие суммы («1 500 000» против «900 000»).
    const numbersConflict =
      numbers.length > 0 && numbersFound.length < numbers.length;
    const supports =
      !numbersConflict &&
      ((tokens.length > 0 && overlap >= SUPPORT_OVERLAP) ||
        (numbers.length > 0 && numbersFound.length === numbers.length));

    sources.push({
      title: result.title ?? null,
      url: result.url,
      domain: domainOf(result.url),
      excerpt: shorten(snippet, 240),
      overlap: Math.round(overlap * 100) / 100,
      supports,
    });
  }

  const supportingDomains = new Set(
    sources.filter((source) => source.supports).map((source) => source.domain),
  );
  const contradicted = sources.some(
    (source) =>
      !source.supports &&
      source.overlap >= CONTRADICTION_OVERLAP &&
      numbers.length > 0 &&
      extractNumbers(source.excerpt).length > 0,
  );
  const topSources = [...sources]
    .sort((left, right) => Number(right.supports) - Number(left.supports))
    .slice(0, MAX_SOURCES);

  if (contradicted && supportingDomains.size === 0) {
    return {
      claim,
      verdict: 'contradicted',
      confidence: 0.5,
      numbers,
      sources: topSources,
      checkedSources: sources.length,
      note: 'источники приводят другие числа',
    };
  }

  if (supportingDomains.size >= 2) {
    return {
      claim,
      verdict: 'supported',
      confidence: Math.min(0.95, 0.6 + 0.1 * (supportingDomains.size - 2)),
      numbers,
      sources: topSources,
      checkedSources: sources.length,
      note: `подтверждено ${supportingDomains.size} независимыми доменами`,
    };
  }

  if (supportingDomains.size === 1) {
    return {
      claim,
      verdict: 'single_source',
      confidence: 0.4,
      numbers,
      sources: topSources,
      checkedSources: sources.length,
      note: 'подтверждено только одним доменом',
    };
  }

  return {
    claim,
    verdict: 'unverified',
    confidence: 0.1,
    numbers,
    sources: topSources,
    checkedSources: sources.length,
    note: sources.length === 0 ? 'нет результатов поиска' : 'совпадений не найдено',
  };
}

/** Значимые слова утверждения: нижний регистр, длина ≥ 4, без чисел. */
export function claimTokens(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s-]/gu, ' ')
    .split(/\s+/u)
    .map((token) => token.trim())
    .filter(
      (token) =>
        token.length >= 4 && !/^\d+$/.test(token) && !STOP_WORDS.has(token),
    );
}

/** Числа и даты утверждения (в исходном написании). */
export function extractNumbers(text: string): string[] {
  return [...text.matchAll(/\d[\d\s.,-]*\d|\d/gu)]
    .map((match) => match[0].trim())
    .filter((value) => value !== '');
}

/** Нормализует цифры: пробелы и разделители не должны мешать сравнению. */
function normalizeDigits(text: string): string {
  return text.replace(/[ \u00A0\u202F]/g, '').replace(/,/g, '.');
}

/** Домен URL или сам URL, если разобрать не удалось. */
export function domainOf(rawUrl: string): string {
  try {
    return new URL(rawUrl).hostname.toLowerCase();
  } catch {
    return rawUrl;
  }
}

/** Обрезка строки с многоточием. */
function shorten(text: string, max = 120): string {
  const normalized = text.replace(/\s+/g, ' ').trim();

  return normalized.length <= max
    ? normalized
    : `${normalized.slice(0, Math.max(0, max - 1))}…`;
}

/** Служебные слова, которые не влияют на совпадение. */
const STOP_WORDS = new Set([
  'этот',
  'эта',
  'эти',
  'того',
  'также',
  'более',
  'менее',
  'очень',
  'который',
  'которая',
  'которые',
  'чтобы',
  'между',
  'после',
  'перед',
  'через',
  'было',
  'были',
  'будет',
  'есть',
  'как',
  'для',
  'при',
  'над',
  'под',
  'про',
  'без',
  'или',
  'что',
  'чем',
  'его',
  'она',
  'они',
  'оно',
  'the',
  'and',
  'for',
  'with',
  'that',
  'this',
  'from',
  'were',
  'was',
  'are',
  'has',
  'have',
]);

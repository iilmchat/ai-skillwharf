import { Injectable, Optional } from '@nestjs/common';
import { z } from 'zod';

/** Состояние маскирования одного запроса — живёт только в памяти вызова. */
export interface PiiMaskState {
  readonly map: Map<string, string>;
  readonly counters: Map<string, number>;
}

export interface PiiMaskResult {
  readonly maskedText: string;
  readonly tokensMap: Map<string, string>;
  readonly maskedCount: number;
}

function createState(): PiiMaskState {
  return { map: new Map(), counters: new Map() };
}

function nextToken(state: PiiMaskState, kind: string): string {
  const index = (state.counters.get(kind) ?? 0) + 1;

  state.counters.set(kind, index);

  return `[${kind}_${index}]`;
}

/** Проверка контрольной суммы Луна для 16-значного номера карты. */
export function passesLuhn(digits: string): boolean {
  if (!/^\d{16}$/.test(digits)) {
    return false;
  }

  let sum = 0;
  let double = false;

  for (let index = digits.length - 1; index >= 0; index -= 1) {
    let value = Number(digits[index]);

    if (double) {
      value *= 2;
      if (value > 9) {
        value -= 9;
      }
    }
    sum += value;
    double = !double;
  }

  return sum % 10 === 0;
}

interface Extracted {
  readonly original: string;
  /** Сохраняемый префикс, например «ИНН: ». */
  readonly prefix?: string;
}

function replaceWithToken(
  text: string,
  pattern: RegExp,
  kind: string,
  state: PiiMaskState,
  extract: (match: string) => Extracted | null,
): string {
  return text.replace(pattern, (match) => {
    const found = extract(match);

    if (found === null) {
      return match;
    }

    const token = nextToken(state, kind);

    state.map.set(token, found.original);

    return `${found.prefix ?? ''}${token}`;
  });
}

/**
 * Маскирует российские ПДн. Соответствие токен→значение живёт только в
 * переданном `state` — ничего не пишется в БД, Redis или логи.
 */
export function maskPii(
  text: string,
  state: PiiMaskState = createState(),
): PiiMaskResult {
  const before = state.map.size;
  let result = text;

  // Карты — раньше телефонов/ИНН, чтобы не маскировать части номера.
  result = replaceWithToken(
    result,
    /(?<!\d)(?:\d[ -]?){15}\d(?!\d)/g,
    'CARD',
    state,
    (match) => {
      const digits = match.replace(/\D/g, '');

      return passesLuhn(digits) ? { original: match } : null;
    },
  );

  result = replaceWithToken(
    result,
    /\b\d{3}-\d{3}-\d{3}[ -]\d{2}\b/g,
    'SNILS',
    state,
    (match) => ({ original: match }),
  );

  result = replaceWithToken(
    result,
    /(?:паспорт|паспорта|паспорту|паспортом)[:\s№]*\d{2}\s?\d{2}\s?\d{6}\b/gi,
    'PASSPORT',
    state,
    (match) => ({
      original: match.slice(match.search(/\d/)),
      prefix: match.slice(0, match.search(/\d/)),
    }),
  );

  result = replaceWithToken(
    result,
    /ИНН[:\s№]*\d{10}(?:\d{2})?\b/gi,
    'INN',
    state,
    (match) => ({
      original: match.slice(match.search(/\d/)),
      prefix: match.slice(0, match.search(/\d/)),
    }),
  );

  result = replaceWithToken(
    result,
    /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g,
    'EMAIL',
    state,
    (match) => ({ original: match }),
  );

  result = replaceWithToken(
    result,
    /(?:\+7|8)[^\d\n]{0,3}(?:\d[^\d\n]{0,3}){10}/g,
    'PHONE',
    state,
    (match) =>
      match.replace(/\D/g, '').length >= 11 ? { original: match } : null,
  );

  return {
    maskedText: result,
    tokensMap: state.map,
    maskedCount: state.map.size - before,
  };
}

/** Восстанавливает исходные значения по токенам в ответе модели. */
export function unmaskPii(
  text: string,
  tokensMap: ReadonlyMap<string, string>,
): string {
  let result = text;

  for (const [token, original] of [...tokensMap].sort(
    (a, b) => b[0].length - a[0].length,
  )) {
    result = result.split(token).join(original);
  }

  return result;
}

/** Сервис PII-маскирования (PII-44.1/44.2). */
@Injectable()
export class PiiMaskingService {
  readonly enabled: boolean;

  constructor(@Optional() env: NodeJS.ProcessEnv = process.env) {
    const flag = z.enum(['true', 'false']).catch('false');

    this.enabled =
      flag.parse((env.PII_MASKING_ENABLED ?? '').trim().toLowerCase()) ===
      'true';
  }

  /** Маскирует текст; при указанном state нумерация токенов общая. */
  maskPii(text: string, state?: PiiMaskState): PiiMaskResult {
    return maskPii(text, state);
  }

  unmaskPii(text: string, tokensMap: ReadonlyMap<string, string>): string {
    return unmaskPii(text, tokensMap);
  }
}

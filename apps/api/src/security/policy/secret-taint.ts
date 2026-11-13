/**
 * Детектор и маскировщик секретов (secret taint) для Agent Gateway.
 *
 * Секреты из недоверенных источников (результаты web_search, ответы внешних
 * MCP-серверов) нельзя безусловно передавать в инструменты-каналы
 * эксфильтрации: policy engine либо блокирует такой вызов, либо заменяет
 * значения на `[REDACTED]`.
 *
 * Паттерны только высоконадёжные: случайные high-entropy строки не считаются
 * секретами, иначе обычный текст блокировал бы легитимные вызовы.
 */

/** Значение, которым заменяются секреты в аргументах инструмента. */
export const REDACTED_VALUE = '[REDACTED]';

/**
 * Регулярные выражения секретов. Первая группа — само значение (без префикса
 * `Bearer`), чтобы маскировать подстроку, а не весь заголовок.
 */
const SECRET_PATTERNS: readonly RegExp[] = [
  // OpenAI-подобные ключи.
  /\b(sk-[A-Za-z0-9_-]{16,})/g,
  // GitHub personal access tokens: классические и fine-grained.
  /\b(ghp_[A-Za-z0-9]{20,})/g,
  /\b(gh[ousr]_[A-Za-z0-9]{20,})/g,
  /\b(github_pat_[A-Za-z0-9_]{20,})/g,
  // AWS access key id.
  /\b(AKIA[0-9A-Z]{16})\b/g,
  // Google OAuth access token.
  /\b(ya29\.[A-Za-z0-9_-]{20,})/g,
  // JWT (header.payload.signature в base64url).
  /\b(eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,})/g,
  // Slack tokens.
  /\b(xox[baprs]-[A-Za-z0-9-]{10,})/g,
  // Bearer-токены: само значение без префикса.
  /\bBearer\s+([A-Za-z0-9._~+/=-]{20,})/g,
];

/** PEM-блок приватного ключа целиком. */
const PRIVATE_KEY_BLOCK_RE =
  /(-----BEGIN (?:[A-Z0-9 ]+ )?PRIVATE KEY-----[\s\S]*?-----END (?:[A-Z0-9 ]+ )?PRIVATE KEY-----)/g;

/** Заголовок приватного ключа без закрывающей строки (обрезанный ввод). */
const PRIVATE_KEY_HEADER_RE = /(-----BEGIN (?:[A-Z0-9 ]+ )?PRIVATE KEY-----)/g;

/**
 * Извлекает из текста значения, похожие на секреты.
 *
 * Возвращает уникальные значения в порядке появления. Пустые и слишком
 * короткие совпадения отбрасываются.
 */
export function extractSecretCandidates(text: string): string[] {
  const found = new Set<string>();

  for (const pattern of SECRET_PATTERNS) {
    collectMatches(text, pattern, found);
  }

  collectMatches(text, PRIVATE_KEY_BLOCK_RE, found);

  // Обрезанный PEM-заголовок добавляем, только если целого блока в тексте нет.
  if (found.size === 0 || [...found].every((value) => !value.includes('END'))) {
    collectMatches(text, PRIVATE_KEY_HEADER_RE, found);
  }

  return [...found];
}

/** Добавляет совпадения первой группы (или всего match) в множество. */
function collectMatches(
  text: string,
  pattern: RegExp,
  target: Set<string>,
): void {
  for (const match of text.matchAll(pattern)) {
    const candidate = (match[1] ?? match[0]).trim();

    // Слишком короткие значения не считаем секретами: это ложные срабатывания.
    if (candidate.length >= MIN_SECRET_LENGTH) {
      target.add(candidate);
    }
  }
}

/** Минимальная длина секрета, чтобы не маскировать случайные подстроки. */
const MIN_SECRET_LENGTH = 16;

/**
 * Рекурсивно заменяет вхождения секретов в строках, массивах и объектах.
 *
 * Возвращает новое значение и признак того, что хотя бы одна замена была
 * сделана. Исходное значение не мутируется.
 */
export function maskSecretValues(
  value: unknown,
  secrets: readonly string[],
): { value: unknown; masked: boolean } {
  const usable = usableSecrets(secrets);

  if (usable.length === 0 || !containsSecretValue(value, usable)) {
    return { value, masked: false };
  }

  const masked = replaceSecrets(value, usable);

  return { value: masked.value, masked: masked.changed };
}

/** Содержит ли значение (рекурсивно) хотя бы один секрет из списка. */
export function containsSecretValue(
  value: unknown,
  secrets: readonly string[],
): boolean {
  const usable = usableSecrets(secrets);

  if (usable.length === 0) {
    return false;
  }

  if (typeof value === 'string') {
    return usable.some((secret) => value.includes(secret));
  }

  if (Array.isArray(value)) {
    return value.some((item) => containsSecretValue(item, usable));
  }

  if (isPlainObject(value)) {
    return Object.values(value).some((item) =>
      containsSecretValue(item, usable),
    );
  }

  return false;
}

/** Отбрасывает пустые секреты и дубликаты (длинные — первыми). */
function usableSecrets(secrets: readonly string[]): readonly string[] {
  const unique = new Set<string>();

  for (const secret of secrets) {
    if (secret.length > 0) {
      unique.add(secret);
    }
  }

  return [...unique].sort((left, right) => right.length - left.length);
}

interface MaskResult {
  value: unknown;
  changed: boolean;
}

/** Рекурсивная замена секретов по структуре значения. */
function replaceSecrets(
  value: unknown,
  secrets: readonly string[],
): MaskResult {
  if (typeof value === 'string') {
    let result = value;
    let changed = false;

    for (const secret of secrets) {
      if (result.includes(secret)) {
        result = result.split(secret).join(REDACTED_VALUE);
        changed = true;
      }
    }

    return { value: result, changed };
  }

  if (Array.isArray(value)) {
    let changed = false;
    const items = value.map((item) => {
      const masked = replaceSecrets(item, secrets);
      changed = changed || masked.changed;

      return masked.value;
    });

    return { value: items, changed };
  }

  if (isPlainObject(value)) {
    let changed = false;
    const entries = Object.entries(value).map(([key, item]) => {
      const masked = replaceSecrets(item, secrets);
      changed = changed || masked.changed;

      return [key, masked.value] as const;
    });

    return { value: Object.fromEntries(entries), changed };
  }

  return { value, changed: false };
}

/** Обычный JSON-объект (не класс, не Date, не Map). */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object') {
    return false;
  }

  const prototype = Object.getPrototypeOf(value);

  return prototype === Object.prototype || prototype === null;
}

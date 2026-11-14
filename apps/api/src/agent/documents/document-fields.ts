/**
 * Извлечение реквизитов из текста договора.
 *
 * Правила намеренно «прозрачные»: каждое найденное значение содержит `raw`
 * (как в документе) и `context` (окружение), чтобы человек мог проверить
 * результат. Никаких подставленных значений: если в тексте нет суммы или
 * даты, поле остаётся `null`, а причина попадает в `warnings`.
 *
 * Эвристики и их ограничения:
 * - сумма — число с валютой (₽/руб./RUB/$/USD/€/EUR); «основной» суммой
 *   считается максимальная по номиналу (типично — цена договора);
 * - дата — `ДД.ММ.ГГГГ`, `ГГГГ-ММ-ДД` или «12 марта 2026 г.»; основной
 *   считается первая валидная дата документа (обычно дата заключения);
 * - стороны — организационно-правовая форма + название в кавычках или без.
 */

/** Валюта найденной суммы. */
export type DocumentCurrency = 'RUB' | 'USD' | 'EUR' | 'UNKNOWN';

/** Найденная денежная сумма. */
export interface ExtractedAmount {
  readonly value: number;
  readonly currency: DocumentCurrency;
  readonly raw: string;
  readonly context: string;
}

/** Найденная дата. */
export interface ExtractedDate {
  /** ISO 8601 `YYYY-MM-DD`. */
  readonly iso: string;
  readonly raw: string;
  readonly context: string;
}

/** Найденная сторона договора. */
export interface ExtractedParty {
  /** Организационно-правовая форма (`ООО`, `АО`, `ИП`, ...). */
  readonly kind: string;
  readonly name: string;
  readonly raw: string;
}

/** Результат извлечения реквизитов. */
export interface DocumentFields {
  readonly contractNumber: string | null;
  readonly subject: string | null;
  readonly amounts: readonly ExtractedAmount[];
  readonly primaryAmount: ExtractedAmount | null;
  readonly dates: readonly ExtractedDate[];
  readonly primaryDate: ExtractedDate | null;
  readonly parties: readonly ExtractedParty[];
  readonly inn: readonly string[];
  readonly kpp: readonly string[];
  readonly ogrn: readonly string[];
  readonly signatory: string | null;
  readonly warnings: readonly string[];
}

/** Русские названия месяцев → номер (1–12). */
const MONTHS: Readonly<Record<string, number>> = {
  января: 1,
  феврали: 2,
  февраля: 2,
  марта: 3,
  апреля: 4,
  мая: 5,
  июня: 6,
  июля: 7,
  августа: 8,
  сентября: 9,
  октября: 10,
  ноября: 11,
  декабря: 12,
};

const MONTH_PATTERN = Object.keys(MONTHS)
  .filter((month) => month !== 'феврали')
  .join('|');

/** Максимум сумм и дат в ответе: ответ уходит в LLM. */
const MAX_AMOUNTS = 20;
const MAX_DATES = 20;

/**
 * Извлекает реквизиты договора из текста.
 *
 * @param text сырой текст документа (после pdf-extractor/OCR)
 */
export function extractDocumentFields(text: string): DocumentFields {
  const warnings: string[] = [];
  const normalized = text.replace(/\r\n?/g, '\n');

  if (normalized.trim() === '') {
    return {
      contractNumber: null,
      subject: null,
      amounts: [],
      primaryAmount: null,
      dates: [],
      primaryDate: null,
      parties: [],
      inn: [],
      kpp: [],
      ogrn: [],
      signatory: null,
      warnings: ['документ пуст'],
    };
  }

  const amounts = extractAmounts(normalized);
  const dates = extractDates(normalized);
  const parties = extractParties(normalized);
  const contractNumber = extractContractNumber(normalized);
  const subject = extractSubject(normalized);
  const signatory = extractSignatory(normalized);

  if (amounts.length === 0) {
    warnings.push('в тексте не найдено сумм с валютой');
  }

  if (dates.length === 0) {
    warnings.push('в тексте не найдено дат');
  }

  if (parties.length < 2) {
    warnings.push(
      `найдено сторон: ${parties.length} (для договора обычно две)`,
    );
  }

  if (contractNumber === null) {
    warnings.push('номер договора не найден');
  }

  const primaryAmount = pickPrimaryAmount(amounts);

  return {
    contractNumber,
    subject,
    amounts,
    primaryAmount,
    dates,
    primaryDate: dates[0] ?? null,
    parties,
    inn: collectMatches(
      normalized,
      /(?<![\wА-Яа-яЁё])ИНН\s*[:№]?\s*(\d{10}|\d{12})(?!\d)/gi,
    ),
    kpp: collectMatches(
      normalized,
      /(?<![\wА-Яа-яЁё])КПП\s*[:№]?\s*(\d{9})(?!\d)/gi,
    ),
    ogrn: collectMatches(
      normalized,
      /(?<![\wА-Яа-яЁё])ОГРН(?:ИП)?\s*[:№]?\s*(\d{13}|\d{15})(?!\d)/gi,
    ),
    signatory,
    warnings,
  };
}

/** Все денежные суммы с валютой (валюта до и после числа). */
export function extractAmounts(text: string): ExtractedAmount[] {
  const number = String.raw`(?:\d{1,3}(?:[ \u00A0\u202F]\d{3})+|\d+)(?:[.,]\d{1,2})?`;
  const suffix = new RegExp(
    String.raw`(?:^|[^\d])(${number})\s*(₽|руб(?:лей|ля|ль)?\.?|р\.|RUB|USD|\$|€|EUR)`,
    'gi',
  );
  const prefix = new RegExp(
    String.raw`(₽|\$|€|USD|EUR|RUB)\s*(\d{1,3}(?:,\d{3})+(?:\.\d{1,2})?|${number})(?![\d])`,
    'gi',
  );
  const amounts: Array<ExtractedAmount & { readonly index: number }> = [];

  const push = (
    rawNumber: string,
    marker: string,
    index: number,
    length: number,
  ): void => {
    if (amounts.length >= MAX_AMOUNTS) {
      return;
    }

    const value = parseAmount(rawNumber);

    if (value === null) {
      return;
    }

    amounts.push({
      value,
      currency: currencyOf(marker),
      raw: marker.length > 0 ? `${marker} ${rawNumber}`.trim() : rawNumber,
      context: contextAround(text, index, length),
      index,
    });
  };

  let match: RegExpExecArray | null;

  while ((match = suffix.exec(text)) !== null && amounts.length < MAX_AMOUNTS) {
    push(
      match[1] ?? '',
      match[2] ?? '',
      match.index,
      match[0].length,
    );
  }

  while ((match = prefix.exec(text)) !== null && amounts.length < MAX_AMOUNTS) {
    push(
      match[2] ?? '',
      match[1] ?? '',
      match.index,
      match[0].length,
    );
  }

  return amounts
    .sort((left, right) => left.index - right.index)
    .map(({ value, currency, raw, context }) => ({
      value,
      currency,
      raw,
      context,
    }));
}

/** Все даты в поддерживаемых форматах (в порядке появления в тексте). */
export function extractDates(text: string): ExtractedDate[] {
  const found: Array<ExtractedDate & { readonly index: number }> = [];
  const seen = new Set<string>();

  const push = (iso: string | null, raw: string, index: number, length: number): void => {
    if (iso === null || seen.has(iso)) {
      return;
    }

    seen.add(iso);
    found.push({
      iso,
      raw,
      context: contextAround(text, index, length),
      index,
    });
  };

  const dotted = /\b(\d{1,2})[.\-/](\d{1,2})[.\-/](\d{4})\b/g;
  let match: RegExpExecArray | null;

  while ((match = dotted.exec(text)) !== null) {
    push(
      toIsoDate(
        Number.parseInt(match[3] ?? '', 10),
        Number.parseInt(match[2] ?? '', 10),
        Number.parseInt(match[1] ?? '', 10),
      ),
      match[0],
      match.index,
      match[0].length,
    );
  }

  const isoForm = /\b(\d{4})-(\d{2})-(\d{2})\b/g;

  while ((match = isoForm.exec(text)) !== null) {
    push(
      toIsoDate(
        Number.parseInt(match[1] ?? '', 10),
        Number.parseInt(match[2] ?? '', 10),
        Number.parseInt(match[3] ?? '', 10),
      ),
      match[0],
      match.index,
      match[0].length,
    );
  }

  const longForm = new RegExp(
    `«?(\\d{1,2})»?\\s+(${MONTH_PATTERN})\\s+(\\d{4})\\s*(?:г\\.?|года)?`,
    'gi',
  );

  while ((match = longForm.exec(text)) !== null) {
    const month = MONTHS[(match[2] ?? '').toLowerCase()] ?? 0;

    push(
      toIsoDate(
        Number.parseInt(match[3] ?? '', 10),
        month,
        Number.parseInt(match[1] ?? '', 10),
      ),
      match[0].trim(),
      match.index,
      match[0].length,
    );
  }

  return found
    .sort((left, right) => left.index - right.index)
    .slice(0, MAX_DATES)
    .map(({ iso, raw, context }) => ({ iso, raw, context }));
}

/** Стороны договора по организационно-правовой форме. */
export function extractParties(text: string): ExtractedParty[] {
  // `\b` в JS работает только для ASCII, поэтому границу слова задаём
  // lookbehind-классом с кириллицей.
  const pattern =
    /(?<![\wА-Яа-яЁё])(ОАО|ПАО|ЗАО|ООО|ФГУП|ГУП|МУП|НКО|ИП|АО)\s*(?:«([^»]{2,120})»|"([^"]{2,120})"|(?!в\s|на\s|о\s|об\s|с\s|по\s|и\s|не\s|от\s|до\s)([А-ЯЁA-Z][^,;.\n]{2,120}))/g;
  const parties: ExtractedParty[] = [];
  const seen = new Set<string>();

  let match: RegExpExecArray | null;

  while ((match = pattern.exec(text)) !== null && parties.length < 10) {
    const kind = match[1] ?? '';
    const name = (match[2] ?? match[3] ?? match[4] ?? '').trim();

    if (name === '') {
      continue;
    }

    const key = `${kind} ${name}`;

    if (seen.has(key)) {
      continue;
    }

    seen.add(key);
    parties.push({ kind, name, raw: match[0].trim() });
  }

  return parties;
}

/** Номер договора. */
export function extractContractNumber(text: string): string | null {
  const patterns = [
    /договор[а-яё]*\s*(?:№|номер)\s*([\wА-Яа-яЁё/.-]{1,40})/i,
    /контракт[а-яё]*\s*(?:№|номер)\s*([\wА-Яа-яЁё/.-]{1,40})/i,
    /№\s*([\wА-Яа-яЁё/.-]{1,40})/,
  ];

  for (const pattern of patterns) {
    const match = pattern.exec(text);
    const raw = match?.[1]?.replace(/[.,;:]+$/, '').trim() ?? '';

    if (raw !== '' && /\d/.test(raw)) {
      return raw;
    }
  }

  return null;
}

/** Предмет договора: строка после заголовка «Предмет договора». */
function extractSubject(text: string): string | null {
  const pattern = /предмет\s+договора\s*[:\-—]?\s*([^\n]{3,300})/i;
  const match = pattern.exec(text);

  return match?.[1]?.trim() ?? null;
}

/** Подписант: фраза после «в лице» до конца предложения. */
function extractSignatory(text: string): string | null {
  const flat = text.replace(/\s+/g, ' ');
  const pattern = /в лице ([^,.;]{3,160})/i;
  const match = pattern.exec(flat);
  const raw = match?.[1]?.trim() ?? '';

  return raw === '' ? null : raw;
}

/** Основная сумма: максимальная по номиналу (валюта должна быть найдена). */
function pickPrimaryAmount(amounts: readonly ExtractedAmount[]): ExtractedAmount | null {
  let best: ExtractedAmount | null = null;

  for (const amount of amounts) {
    if (best === null || amount.value > best.value) {
      best = amount;
    }
  }

  return best;
}

/** «1 500 000,50» → 1500000.5. */
export function parseAmount(raw: string): number | null {
  const cleaned = raw.replace(/[ \u00A0\u202F]/g, '');

  if (cleaned === '' || !/\d/.test(cleaned)) {
    return null;
  }

  const lastComma = cleaned.lastIndexOf(',');
  const lastDot = cleaned.lastIndexOf('.');
  let normalized = cleaned;

  if (lastComma === -1) {
    normalized = cleaned;
  } else if (lastDot === -1) {
    normalized = cleaned.replace(/,/g, '.');
  } else if (lastComma > lastDot) {
    normalized = cleaned.replace(/\./g, '').replace(',', '.');
  } else {
    normalized = cleaned.replace(/,/g, '');
  }

  const value = Number.parseFloat(normalized);

  return Number.isFinite(value) && value >= 0 ? value : null;
}

/** Валюта по обозначению в тексте. */
function currencyOf(marker: string): DocumentCurrency {
  const normalized = marker.trim().toLowerCase();

  if (normalized === '₽' || normalized.startsWith('руб') || normalized === 'р.' || normalized === 'rub') {
    return 'RUB';
  }

  if (normalized === '$' || normalized === 'usd') {
    return 'USD';
  }

  if (normalized === '€' || normalized === 'eur') {
    return 'EUR';
  }

  return 'UNKNOWN';
}

/** Проверка и нормализация даты в ISO 8601. */
function toIsoDate(year: number, month: number, day: number): string | null {
  if (
    !Number.isInteger(year) ||
    !Number.isInteger(month) ||
    !Number.isInteger(day) ||
    year < 1900 ||
    year > 2199 ||
    month < 1 ||
    month > 12 ||
    day < 1 ||
    day > 31
  ) {
    return null;
  }

  const date = new Date(Date.UTC(year, month - 1, day));

  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    return null;
  }

  const pad = (value: number): string => String(value).padStart(2, '0');

  return `${year}-${pad(month)}-${pad(day)}`;
}

/** Окружение найденного значения: до и после, без переводов строк. */
function contextAround(text: string, index: number, length: number): string {
  const start = Math.max(0, index - 40);
  const end = Math.min(text.length, index + length + 40);

  return text
    .slice(start, end)
    .replace(/\s+/g, ' ')
    .trim();
}

/** Все уникальные совпадения группы 1 регулярного выражения. */
function collectMatches(text: string, pattern: RegExp): string[] {
  const values = new Set<string>();

  let match: RegExpExecArray | null;

  while ((match = pattern.exec(text)) !== null) {
    const value = match[1]?.trim() ?? '';

    if (value !== '') {
      values.add(value);
    }
  }

  return [...values];
}

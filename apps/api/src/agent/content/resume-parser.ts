/**
 * Разбор резюме: контакты, навыки, опыт, образование, языки.
 *
 * Никаких «средних» значений и демонстрационных оценок: результат строится
 * только на тексте резюме. Каждое поле сопровождается признаком источника
 * (навыки — словарь + раздел «Навыки»), а спорные места попадают в `warnings`.
 *
 * Опыт считается по явным диапазонам дат (`03.2021 — н.в.`,
 * `январь 2020 — декабрь 2021`, `2020 — 2022`, `01.03.2020 — 31.12.2021`).
 * Месяцы пересекающихся периодов не суммируются дважды.
 */

/** Контакты кандидата. */
export interface ResumeContact {
  readonly name: string | null;
  readonly email: string | null;
  readonly phone: string | null;
  readonly telegram: string | null;
  readonly location: string | null;
}

/** Место работы, восстановленное по строке с датами. */
export interface ResumePosition {
  readonly title: string | null;
  readonly company: string | null;
  readonly from: string | null;
  readonly to: string | null;
  readonly months: number | null;
}

/** Опыт работы. */
export interface ResumeExperience {
  readonly totalMonths: number;
  readonly years: number;
  readonly positions: readonly ResumePosition[];
  /** Есть ли открытый период (`н.в.`, `present`). */
  readonly current: boolean;
}

/** Образование. */
export interface ResumeEducation {
  readonly level: string | null;
  readonly institutions: readonly string[];
}

/** Владение языком. */
export interface ResumeLanguage {
  readonly name: string;
  readonly level: string | null;
}

/** Разобранное резюме. */
export interface ParsedResume {
  readonly contact: ResumeContact;
  /** Навыки, найденные по словарю (канонические названия). */
  readonly skills: readonly string[];
  /** Навыки из раздела «Навыки», которых нет в словаре (как в резюме). */
  readonly skillsFromSections: readonly string[];
  readonly experience: ResumeExperience;
  readonly education: ResumeEducation;
  readonly languages: readonly ResumeLanguage[];
  readonly summary: string | null;
  readonly warnings: readonly string[];
}

/** Запись словаря навыков: каноническое имя и варианты написания. */
interface SkillEntry {
  readonly canonical: string;
  readonly aliases: readonly string[];
}

/**
 * Словарь навыков (IT + офисные + управленческие).
 *
 * Список намеренно небольшой и проверяемый: расширять его нужно вместе с
 * тестами, а не «на всякий случай».
 */
export const SKILL_DICTIONARY: readonly SkillEntry[] = [
  { canonical: 'JavaScript', aliases: ['javascript', 'js', 'джаваскрипт'] },
  { canonical: 'TypeScript', aliases: ['typescript', 'ts'] },
  { canonical: 'Node.js', aliases: ['node.js', 'nodejs', 'node js', 'нода'] },
  { canonical: 'React', aliases: ['react', 'react.js', 'reactjs'] },
  { canonical: 'Vue', aliases: ['vue', 'vue.js', 'vuejs'] },
  { canonical: 'Angular', aliases: ['angular'] },
  { canonical: 'NestJS', aliases: ['nestjs', 'nest.js'] },
  { canonical: 'Python', aliases: ['python', 'питон'] },
  { canonical: 'Django', aliases: ['django'] },
  { canonical: 'FastAPI', aliases: ['fastapi'] },
  { canonical: 'Java', aliases: ['java'] },
  { canonical: 'Spring', aliases: ['spring', 'spring boot'] },
  { canonical: 'Kotlin', aliases: ['kotlin'] },
  { canonical: 'Go', aliases: ['golang', 'go lang'] },
  { canonical: 'C#', aliases: ['c#', 'c sharp', 'csharp'] },
  { canonical: 'C++', aliases: ['c++', 'cpp'] },
  { canonical: 'PHP', aliases: ['php'] },
  { canonical: '1С', aliases: ['1с', '1c', '1с:предприятие'] },
  { canonical: 'SQL', aliases: ['sql'] },
  { canonical: 'PostgreSQL', aliases: ['postgresql', 'postgres', 'постгрес'] },
  { canonical: 'MySQL', aliases: ['mysql'] },
  { canonical: 'MongoDB', aliases: ['mongodb', 'mongo'] },
  { canonical: 'Redis', aliases: ['redis'] },
  { canonical: 'ClickHouse', aliases: ['clickhouse'] },
  { canonical: 'Kafka', aliases: ['kafka', 'кафка'] },
  { canonical: 'RabbitMQ', aliases: ['rabbitmq'] },
  { canonical: 'Docker', aliases: ['docker', 'докер'] },
  { canonical: 'Kubernetes', aliases: ['kubernetes', 'k8s'] },
  { canonical: 'Terraform', aliases: ['terraform'] },
  { canonical: 'Ansible', aliases: ['ansible'] },
  { canonical: 'CI/CD', aliases: ['ci/cd', 'cicd', 'ci cd'] },
  { canonical: 'Git', aliases: ['git', 'гит'] },
  { canonical: 'GitLab CI', aliases: ['gitlab ci'] },
  { canonical: 'Linux', aliases: ['linux', 'линукс'] },
  { canonical: 'REST API', aliases: ['rest api', 'rest', 'restful'] },
  { canonical: 'GraphQL', aliases: ['graphql'] },
  { canonical: 'gRPC', aliases: ['grpc'] },
  { canonical: 'RabbitMQ/AMQP', aliases: ['amqp'] },
  { canonical: 'Nginx', aliases: ['nginx'] },
  { canonical: 'Prometheus', aliases: ['prometheus'] },
  { canonical: 'Grafana', aliases: ['grafana'] },
  { canonical: 'Figma', aliases: ['figma', 'фигма'] },
  { canonical: 'Photoshop', aliases: ['photoshop', 'фотошоп'] },
  { canonical: 'Excel', aliases: ['excel', 'эксель'] },
  { canonical: 'Google Sheets', aliases: ['google sheets', 'гугл таблицы'] },
  { canonical: 'Power BI', aliases: ['power bi', 'powerbi'] },
  { canonical: 'Tableau', aliases: ['tableau'] },
  { canonical: 'Jira', aliases: ['jira', 'джира'] },
  { canonical: 'Confluence', aliases: ['confluence'] },
  { canonical: 'Scrum', aliases: ['scrum', 'скрам'] },
  { canonical: 'Kanban', aliases: ['kanban', 'канбан'] },
  { canonical: 'Agile', aliases: ['agile', 'аджайл'] },
  { canonical: 'Управление командой', aliases: ['управление командой', 'team lead', 'тимлид', 'руководство командой'] },
  { canonical: 'Продажи', aliases: ['продажи', 'sales'] },
  { canonical: 'Переговоры', aliases: ['переговоры', 'negotiation'] },
  { canonical: 'Бухгалтерский учёт', aliases: ['бухгалтерский учёт', 'бухгалтерский учет'] },
  { canonical: 'Маркетинг', aliases: ['маркетинг', 'marketing'] },
  { canonical: 'SEO', aliases: ['seo', 'сео'] },
  { canonical: 'Копирайтинг', aliases: ['копирайтинг', 'copywriting'] },
  { canonical: 'Английский язык', aliases: ['английский язык', 'английский'] },
];

/** Заголовки разделов резюме (RU/EN) → тип раздела. */
const SECTION_PATTERNS: ReadonlyArray<{
  readonly kind: ResumeSection;
  readonly pattern: RegExp;
}> = [
  { kind: 'summary', pattern: /^(?:о себе|summary|профиль|profile|цель|objective)(?![А-Яа-яЁёA-Za-z])/i },
  { kind: 'experience', pattern: /^(?:опыт работы|опыт|work experience|experience|профессиональный опыт|трудовая деятельность)(?![А-Яа-яЁёA-Za-z])/i },
  { kind: 'skills', pattern: /^(?:навыки|ключевые навыки|skills|технологии|stack|компетенции)(?![А-Яа-яЁёA-Za-z])/i },
  { kind: 'education', pattern: /^(?:образование|education|обучение)(?![А-Яа-яЁёA-Za-z])/i },
  { kind: 'languages', pattern: /^(?:языки|languages|владение языками)(?![А-Яа-яЁёA-Za-z])/i },
  { kind: 'additional', pattern: /^(?:дополнительно|дополнительная информация|additional|курсы|courses|проекты|projects|сертификаты)(?![А-Яа-яЁёA-Za-z])/i },
];

type ResumeSection =
  | 'summary'
  | 'experience'
  | 'skills'
  | 'education'
  | 'languages'
  | 'additional';

/** Русские и английские месяцы → номер (1–12). */
const MONTH_NAMES: Readonly<Record<string, number>> = {
  январь: 1, января: 1, jan: 1, january: 1,
  февраль: 2, февраля: 2, feb: 2, february: 2,
  март: 3, марта: 3, mar: 3, march: 3,
  апрель: 4, апреля: 4, apr: 4, april: 4,
  май: 5, мая: 5, may: 5,
  июнь: 6, июня: 6, jun: 6, june: 6,
  июль: 7, июля: 7, jul: 7, july: 7,
  август: 8, августа: 8, aug: 8, august: 8,
  сентябрь: 9, сентября: 9, sep: 9, september: 9,
  октябрь: 10, октября: 10, oct: 10, october: 10,
  ноябрь: 11, ноября: 11, nov: 11, november: 11,
  декабрь: 12, декабря: 12, dec: 12, december: 12,
};

const MONTH_WORD = Object.keys(MONTH_NAMES).join('|');

/** Признак открытого периода. */
const PRESENT_PATTERN =
  /(?:н\.?\s?в\.?|наст\.?\s*(?:время|вр\.?)|по\s+настоящее\s+время|present|current|now|сейчас)/i;

/** Города, которые распознаём в строке контактов. */
const CITIES = [
  'Москва',
  'Санкт-Петербург',
  'Новосибирск',
  'Екатеринбург',
  'Казань',
  'Нижний Новгород',
  'Самара',
  'Омск',
  'Ростов-на-Дону',
  'Краснодар',
  'Уфа',
  'Воронеж',
  'Пермь',
  'Волгоград',
];

/** Максимум распознанных мест работы. */
const MAX_POSITIONS = 20;

/** Максимум языков. */
const MAX_LANGUAGES = 10;

/** Разбирает резюме. */
export function parseResume(text: string): ParsedResume {
  const normalized = text.replace(/\r\n?/g, '\n');
  const warnings: string[] = [];
  const contact = extractContact(normalized);
  const sections = splitSections(normalized);
  const skillMatch = extractSkills(normalized, sections);
  const experience = extractExperience(sections.experience ?? normalized, warnings);
  const education = extractEducation(sections.education ?? '');
  const languages = extractLanguages(sections.languages ?? normalized);
  const summary = (sections.summary ?? '').trim() || null;

  if (normalized.trim() === '') {
    warnings.push('резюме пусто');
  }

  if (contact.email === null && contact.phone === null) {
    warnings.push('в резюме не найдены email и телефон');
  }

  if (skillMatch.skills.length === 0 && skillMatch.fromSections.length === 0) {
    warnings.push('навыки не найдены: ни по словарю, ни в разделе «Навыки»');
  }

  if (experience.totalMonths === 0) {
    warnings.push('не найдено ни одного периода работы с датами');
  }

  return {
    contact,
    skills: skillMatch.skills,
    skillsFromSections: skillMatch.fromSections,
    experience,
    education,
    languages,
    summary,
    warnings,
  };
}

/** Контакты: имя, email, телефон, Telegram, город. */
export function extractContact(text: string): ResumeContact {
  const email = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/.exec(text)?.[0] ?? null;
  const phone =
    /(?:\+7|8)[\s(-]*\d{3}[\s)-]*\d{3}[\s-]*\d{2}[\s-]*\d{2}/.exec(text)?.[0] ?? null;
  const telegramMatch = /(?:^|[^A-Za-z0-9._%+-])@([A-Za-z0-9_]{4,32})(?!\.)/.exec(
    text,
  );
  const telegram =
    telegramMatch?.[1] === undefined ? null : `@${telegramMatch[1]}`;
  const city =
    CITIES.find((candidate) =>
      new RegExp(`(?:^|[^А-Яа-яЁё])${candidate}(?:$|[^А-Яа-яЁё])`, 'i').test(text),
    ) ?? null;
  const name = extractName(text);

  return {
    name,
    email,
    phone: phone === null ? null : phone.replace(/\s+/g, ' ').trim(),
    telegram,
    location: city,
  };
}

/** Имя: первая строка, похожая на ФИО (2–3 слова с заглавной буквы). */
function extractName(text: string): string | null {
  const lines = text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '')
    .slice(0, 8);

  for (const line of lines) {
    if (/[0-9@:/\\]/.test(line) || line.length > 80) {
      continue;
    }

    const ru = /^[А-ЯЁ][а-яё-]+(?:\s+[А-ЯЁ][а-яё-]+){1,2}$/;
    const en = /^[A-Z][a-z-]+(?:\s+[A-Z][a-z-]+){1,2}$/;

    if (ru.test(line) || en.test(line)) {
      return line;
    }
  }

  return null;
}

/** Делит текст резюме на разделы по заголовкам. */
export function splitSections(
  text: string,
): Partial<Record<ResumeSection, string>> {
  const sections: Partial<Record<ResumeSection, string>> = {};
  let current: ResumeSection | null = null;
  let buffer: string[] = [];
  let preamble: string[] = [];

  const flush = (): void => {
    if (current === null) {
      return;
    }

    sections[current] = buffer.join('\n').trim();
  };

  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim();
    const heading = line === '' ? null : matchSection(line);

    if (heading !== null) {
      flush();
      current = heading;
      buffer = [];
      continue;
    }

    if (current === null) {
      preamble.push(rawLine);
    } else {
      buffer.push(rawLine);
    }
  }

  flush();

  if (preamble.some((line) => line.trim() !== '')) {
    sections.summary ??= preamble.join('\n').trim();
  }

  return sections;
}

/** Заголовок раздела или null. */
function matchSection(line: string): ResumeSection | null {
  const normalized = line.replace(/[:\s]+$/g, '').trim();

  if (normalized.length > 64) {
    return null;
  }

  for (const { kind, pattern } of SECTION_PATTERNS) {
    if (pattern.test(normalized)) {
      return kind;
    }
  }

  return null;
}

/** Навыки: словарь + раздел «Навыки». */
function extractSkills(
  text: string,
  sections: Partial<Record<ResumeSection, string>>,
): { skills: string[]; fromSections: string[] } {
  const skills = new Set<string>();
  const lower = text.toLowerCase();

  for (const entry of ALIAS_PATTERNS) {
    if (entry.patterns.some((pattern) => pattern.test(lower))) {
      skills.add(entry.canonical);
    }
  }

  const sectionText = sections.skills ?? '';
  const fromSections: string[] = [];

  for (const token of splitSkillList(sectionText)) {
    const canonical = canonicalSkill(token);

    if (canonical === null) {
      if (!fromSections.includes(token)) {
        fromSections.push(token);
      }

      continue;
    }

    skills.add(canonical);
  }

  return {
    skills: [...skills].sort((left, right) => left.localeCompare(right, 'ru')),
    fromSections: fromSections.slice(0, 100),
  };
}

/**
 * Скомпилированные шаблоны алиасов: словарь переиспользуется на каждый разбор,
 * а `\p{L}`-шаблоны дороги в компиляции.
 */
const ALIAS_PATTERNS: ReadonlyArray<{
  readonly canonical: string;
  readonly patterns: readonly RegExp[];
}> = SKILL_DICTIONARY.map((entry) => ({
  canonical: entry.canonical,
  patterns: entry.aliases.map(aliasPattern),
}));

/** Регулярное выражение для алиаса с границами слова. */
function aliasPattern(alias: string): RegExp {
  const escaped = alias.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // `.` и `-` не входят в границу: «Node.js.» и «C++» должны совпадать.
  const boundary = '\\p{L}\\p{N}_+#';

  return new RegExp(`(?:^|[^${boundary}])${escaped}(?:$|[^${boundary}])`, 'iu');
}

/** Каноническое имя навыка по строке или null. */
export function canonicalSkill(raw: string): string | null {
  const value = raw.trim().toLowerCase();
  const candidate = value.replace(/^[-•*\s]+/, '').trim();

  if (candidate === '' || candidate.length < 2 || candidate.length > 60) {
    return null;
  }

  for (const entry of SKILL_DICTIONARY) {
    if (entry.canonical.toLowerCase() === candidate) {
      return entry.canonical;
    }

    if (entry.aliases.some((alias) => alias === candidate)) {
      return entry.canonical;
    }
  }

  return null;
}

/** Разбивает раздел навыков на токены. */
export function splitSkillList(section: string): string[] {
  return section
    .split(/[,;|•·\n]+/)
    .map((token) =>
      token
        .replace(/^[-–—*\s]+/, '')
        .replace(/[.\s]+$/g, '')
        .trim(),
    )
    .filter((token) => token.length >= 2 && token.length <= 60);
}

/** Опыт: интервалы дат, объединение пересечений, места работы. */
export function extractExperience(
  section: string,
  warnings: string[] = [],
): ResumeExperience {
  const intervals = findIntervals(section);

  if (intervals.length === 0) {
    return { totalMonths: 0, years: 0, positions: [], current: false };
  }

  const merged = mergeIntervals(intervals.map((interval) => ({
    start: interval.start,
    end: interval.end,
  })));
  const totalMonths = merged.reduce(
    (sum, interval) => sum + (interval.end - interval.start + 1),
    0,
  );
  const positions = findPositions(section, intervals);
  const current = intervals.some((interval) => interval.open);

  if (totalMonths > 12 * 60) {
    warnings.push(
      `суммарный опыт больше 60 лет (${totalMonths} мес.): проверьте даты`,
    );
  }

  return {
    totalMonths,
    years: Math.round((totalMonths / 12) * 10) / 10,
    positions,
    current,
  };
}

interface ResumeInterval {
  /** Абсолютный месяц начала (год*12 + месяц-1). */
  readonly start: number;
  readonly open: boolean;
  readonly end: number;
  readonly from: string;
  readonly to: string;
  readonly raw: string;
}

/** Упорядоченные интервалы работы. */
function findIntervals(section: string): ResumeInterval[] {
  const intervals: ResumeInterval[] = [];
  const now = new Date();
  const nowIndex = now.getUTCFullYear() * 12 + now.getUTCMonth();

  const push = (
    from: { year: number; month: number },
    to: { year: number; month: number } | null,
    raw: string,
  ): void => {
    const start = from.year * 12 + (from.month - 1);
    const open = to === null;
    const end = open ? nowIndex : to.year * 12 + (to.month - 1);

    if (start < 1970 * 12 || start > nowIndex + 12) {
      return;
    }

    if (end < start || end - start > 12 * 60) {
      return;
    }

    const format = (value: number): string =>
      `${Math.floor(value / 12)}-${String((value % 12) + 1).padStart(2, '0')}`;

    intervals.push({
      start,
      end,
      open,
      from: format(start),
      to: open ? 'н.в.' : format(end),
      raw,
    });
  };

  const monthYear = new RegExp(
    String.raw`(\d{1,2})[./](\d{4})\s*(?:[-–—]|—|по|до|\bto\b)\s*(?:${PRESENT_PATTERN.source}|(\d{1,2})[./](\d{4}))`,
    'giu',
  );
  const namedMonth = new RegExp(
    String.raw`(${MONTH_WORD})\.?\s*(\d{4})\s*(?:[-–—]|по|до|\bto\b)\s*(?:${PRESENT_PATTERN.source}|(${MONTH_WORD})\.?\s*(\d{4}))`,
    'giu',
  );
  const fullDate = new RegExp(
    String.raw`(\d{1,2})[./](\d{1,2})[./](\d{4})\s*(?:[-–—]|по|до|\bto\b)\s*(?:${PRESENT_PATTERN.source}|(\d{1,2})[./](\d{1,2})[./](\d{4}))`,
    'giu',
  );
  const years = new RegExp(
    String.raw`(?<![\d.])(\d{4})\s*(?:[-–—]|по|до|\bto\b)\s*(?:${PRESENT_PATTERN.source}|(\d{4}))(?![\d.])`,
    'giu',
  );

  const collect = (
    pattern: RegExp,
    read: (match: RegExpExecArray) => void,
  ): void => {
    let match: RegExpExecArray | null;

    while ((match = pattern.exec(section)) !== null) {
      read(match);
    }
  };

  collect(monthYear, (match) => {
    const start = {
      year: Number.parseInt(match[2] ?? '0', 10),
      month: Number.parseInt(match[1] ?? '0', 10),
    };

    if (!PLAUSIBLE_MONTH.test(String(start.month))) {
      return;
    }

    const hasEnd = match[3] !== undefined;

    push(
      start,
      hasEnd
        ? {
            year: Number.parseInt(match[4] ?? '0', 10),
            month: Number.parseInt(match[3] ?? '0', 10),
          }
        : null,
      match[0],
    );
  });

  collect(namedMonth, (match) => {
    const startMonth = MONTH_NAMES[(match[1] ?? '').toLowerCase()];

    if (startMonth === undefined) {
      return;
    }

    const start = {
      year: Number.parseInt(match[2] ?? '0', 10),
      month: startMonth,
    };
    const endMonth = MONTH_NAMES[(match[3] ?? '').toLowerCase()];
    const hasEnd = endMonth !== undefined;

    push(
      start,
      hasEnd
        ? {
            year: Number.parseInt(match[4] ?? '0', 10),
            month: endMonth,
          }
        : null,
      match[0],
    );
  });

  collect(fullDate, (match) => {
    const start = {
      year: Number.parseInt(match[3] ?? '0', 10),
      month: Number.parseInt(match[2] ?? '0', 10),
    };

    if (!PLAUSIBLE_MONTH.test(String(start.month))) {
      return;
    }

    const hasEnd = match[4] !== undefined;

    push(
      start,
      hasEnd
        ? {
            year: Number.parseInt(match[6] ?? '0', 10),
            month: Number.parseInt(match[5] ?? '0', 10),
          }
        : null,
      match[0],
    );
  });

  collect(years, (match) => {
    const startYear = Number.parseInt(match[1] ?? '0', 10);
    const hasEnd = match[2] !== undefined;

    push(
      { year: startYear, month: 1 },
      hasEnd ? { year: Number.parseInt(match[2] ?? '0', 10), month: 12 } : null,
      match[0],
    );
  });

  // Один и тот же период мог совпасть с несколькими шаблонами: убираем дубли
  // по нормализованным границам.
  const seen = new Set<string>();
  const unique: ResumeInterval[] = [];

  for (const interval of intervals) {
    const key = `${interval.start}|${interval.end}|${interval.open}`;

    if (!seen.has(key)) {
      seen.add(key);
      unique.push(interval);
    }
  }

  return unique.sort((left, right) => left.start - right.start);
}

/** Проверка номера месяца. */
const PLAUSIBLE_MONTH = /^(?:[1-9]|1[0-2])$/;

/** Объединение пересекающихся интервалов. */
function mergeIntervals(
  intervals: ReadonlyArray<{ readonly start: number; readonly end: number }>,
): Array<{ start: number; end: number }> {
  const sorted = [...intervals].sort((left, right) => left.start - right.start);
  const merged: Array<{ start: number; end: number }> = [];

  for (const interval of sorted) {
    const last = merged.at(-1);

    if (last === undefined || interval.start > last.end + 1) {
      merged.push({ start: interval.start, end: interval.end });

      continue;
    }

    last.end = Math.max(last.end, interval.end);
  }

  return merged;
}

/** Места работы: строки с датами (или строка перед датами). */
function findPositions(
  section: string,
  intervals: readonly ResumeInterval[],
): ResumePosition[] {
  const positions: ResumePosition[] = [];
  const lines = section.split('\n');

  for (let index = 0; index < lines.length; index += 1) {
    const trimmed = (lines[index] ?? '').trim();

    if (trimmed === '') {
      continue;
    }

    const interval = intervals.find((candidate) =>
      trimmed.includes(candidate.raw),
    );

    if (interval === undefined) {
      continue;
    }

    const fromThisLine = cleanPositionLine(trimmed, interval.raw);
    // Часто дата стоит отдельной строкой под названием должности.
    const candidate =
      fromThisLine === '' ? cleanPositionLine((lines[index - 1] ?? '').trim(), '') : fromThisLine;

    if (candidate !== '') {
      positions.push({
        ...splitPosition(candidate),
        from: interval.from,
        to: interval.to,
        months: interval.end - interval.start + 1,
      });
    }

    if (positions.length >= MAX_POSITIONS) {
      break;
    }
  }

  return positions;
}

/** Убирает из строки даты и открытый период. */
function cleanPositionLine(line: string, rawRange: string): string {
  return line
    .replace(rawRange, ' ')
    .replace(new RegExp(PRESENT_PATTERN.source, 'giu'), ' ')
    .replace(/\s{2,}/g, ' ')
    .replace(/^[\s,;:–—-]+|[\s,;:–—-]+$/g, '')
    .trim();
}

/** Делит строку «Компания — Должность» на компанию и должность. */
function splitPosition(line: string): {
  title: string | null;
  company: string | null;
} {
  const parts = line
    .split(/\s*[—–|]\s*|\s+-\s+/)
    .map((part) => part.trim())
    .filter((part) => part !== '');

  if (parts.length === 0) {
    return { title: null, company: null };
  }

  if (parts.length === 1) {
    return { title: parts[0] ?? null, company: null };
  }

  const companyPattern =
    /(?:ООО|ОАО|ЗАО|ПАО|АО|ИП|НКО|ФГУП|ГУП|МУП|LLC|Ltd|Inc|GmbH|«)/i;
  const first = parts[0] ?? '';
  const second = parts[1] ?? '';

  if (companyPattern.test(first)) {
    return { title: second, company: first };
  }

  if (companyPattern.test(second)) {
    return { title: first, company: second };
  }

  return { title: first, company: second };
}

/** Образование: уровень и учебные заведения. */
export function extractEducation(section: string): ResumeEducation {
  const lower = section.toLowerCase();
  let level: string | null = null;

  if (/кандидат наук|phd|doctor/.test(lower)) {
    level = 'phd';
  } else if (/магистр|master/.test(lower)) {
    level = 'master';
  } else if (/бакалавр|bachelor/.test(lower)) {
    level = 'bachelor';
  } else if (/высшее|university degree/.test(lower)) {
    level = 'higher';
  } else if (/среднее специальное|колледж|техникум|college/.test(lower)) {
    level = 'secondary';
  }

  const institutions = section
    .split('\n')
    .map((line) => line.trim())
    .filter((line) =>
      /(университет|институт|академи|колледж|техникум|училище|лицей|гимназия|school|university|college|institute|\bМГТУ\b|\bМГУ\b|\bСПбГУ\b|\bВШЭ\b|\bМФТИ\b|\bМАИ\b|\bМИФИ\b|\bРЭУ\b|\bРАНХиГС\b|им\.)/i.test(
        line,
      ),
    )
    .map((line) => line.replace(/\s{2,}/g, ' '))
    .slice(0, 5);

  return { level, institutions };
}

/** Языки и уровень владения. */
export function extractLanguages(section: string): ResumeLanguage[] {
  const languages: ResumeLanguage[] = [];
  const pattern =
    /(английский|немецкий|французский|испанский|китайский|итальянский|english|german|french|spanish|chinese)(?:\s+(?:язык|language))?[\s:—-]*([A-C][12]|свободн\w*|продвинут\w*|средн\w*|базов\w*|beginner|intermediate|advanced|fluent|native)?/giu;

  let match: RegExpExecArray | null;

  while ((match = pattern.exec(section)) !== null && languages.length < MAX_LANGUAGES) {
    const name = capitalize(match[1] ?? '');
    const level = match[2]?.trim() ?? null;

    if (name === '' || languages.some((language) => language.name === name)) {
      continue;
    }

    languages.push({ name, level });
  }

  return languages;
}

function capitalize(value: string): string {
  if (value === '') {
    return '';
  }

  return `${value[0]?.toUpperCase() ?? ''}${value.slice(1).toLowerCase()}`;
}

import { isAxiosError } from 'axios';
import i18n from '../i18n';
import { api } from './api';
import type { SkillManifest, SkillPricing } from './skills';

export type StoreCategory =
  | 'all'
  | 'search'
  | 'dev'
  | 'communication'
  | 'productivity'
  | 'content'
  | 'hr'
  | 'documents'
  | 'finance';

interface CategoryRule {
  category: Exclude<StoreCategory, 'all'>;
  keywords: readonly string[];
}

interface CategoryPrefixRule {
  category: Exclude<StoreCategory, 'all'>;
  prefixes: readonly string[];
}

/** Специфичные новые направления: dzen/fact → Контент, resume → HR, document → Документы. */
const CATEGORY_PREFIX_RULES: readonly CategoryPrefixRule[] = [
  { category: 'content', prefixes: ['dzen', 'fact'] },
  { category: 'hr', prefixes: ['resume'] },
  { category: 'documents', prefixes: ['document'] },
];

/** Порядок важен: поиск должен сработать раньше разработки. */
const CATEGORY_RULES: readonly CategoryRule[] = [
  {
    category: 'finance',
    keywords: ['unit', 'profit', 'price', 'fraud'],
  },
  {
    category: 'search',
    keywords: ['search', 'tavily', 'weather', 'web', 'research'],
  },
  {
    category: 'communication',
    keywords: [
      'messenger',
      'telegram',
      'slack',
      'discord',
      'whatsapp',
      'vk',
      'email',
      'connector',
    ],
  },
  {
    category: 'dev',
    keywords: [
      'github',
      'code',
      'sql',
      'cron',
      'workflow',
      'orchestrat',
      'vetter',
      'sandbox',
    ],
  },
  {
    category: 'productivity',
    keywords: [
      'workspace',
      'google',
      'ozon',
      'wb',
      'wildberries',
      'midjourney',
      'notion',
      'calendar',
      'document',
      'sheet',
      'image',
      'creative',
      'pdf',
    ],
  },
];

/** Простой маппинг категории по имени навыка (ТЗ магазина). */
export function getSkillCategory(name: string): StoreCategory {
  const normalized = name.toLowerCase();

  for (const rule of CATEGORY_PREFIX_RULES) {
    if (rule.prefixes.some((prefix) => normalized.startsWith(prefix))) {
      return rule.category;
    }
  }

  for (const rule of CATEGORY_RULES) {
    if (rule.keywords.some((keyword) => normalized.includes(keyword))) {
      return rule.category;
    }
  }

  return 'all';
}

/** Карточка навыка из публичного реестра. */
export interface RegistrySkill {
  /** Есть у реестров, которые устанавливают навык по идентификатору. */
  id?: string;
  name: string;
  version?: string;
  author?: string;
  description?: string;
  /** Цена из реестра: `0` — бесплатно. Альтернатива `pricing`. */
  price?: number;
  permissions?: string[];
  manifest?: SkillManifest;
  pricing?: SkillPricing;
}

/**
 * Результат проверки Vetter. Наличие `danger`/`warning` в ответе бэкенда
 * означает, что установку нужно подтвердить явно.
 */
export interface VetterReport {
  dangers: string[];
  warnings: string[];
}

export interface InstallRegistrySkillInput {
  skill: RegistrySkill;
  /** Повторная установка после подтверждения предупреждений Vetter. */
  ignoreWarnings?: boolean;
}

export interface InstallRegistrySkillResult {
  vetter: VetterReport | null;
}

interface MessagePayload {
  message: string | string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isMessagePayload(value: unknown): value is MessagePayload {
  if (!isRecord(value) || !('message' in value)) {
    return false;
  }

  const { message } = value;

  return (
    typeof message === 'string' ||
    (Array.isArray(message) &&
      message.every((item): item is string => typeof item === 'string'))
  );
}

function translateServerMessage(message: string): string {
  return message.startsWith('errors.') && i18n.exists(message)
    ? i18n.t(message)
    : message;
}

function formatServerMessage(message: string | string[]): string {
  return Array.isArray(message)
    ? message.map(translateServerMessage).join('; ')
    : translateServerMessage(message);
}

/** Строка отчёта Vetter: бэкенд может прислать текст или объект. */
function readFinding(value: unknown): string | null {
  if (typeof value === 'string') {
    const trimmed = value.trim();

    return trimmed === '' ? null : trimmed;
  }

  if (isRecord(value)) {
    const text = value.message ?? value.description ?? value.text;

    if (typeof text === 'string' && text.trim() !== '') {
      return text.trim();
    }
  }

  return null;
}

function readFindings(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value
      .map(readFinding)
      .filter((item): item is string => item !== null);
  }

  const finding = readFinding(value);

  return finding === null ? [] : [finding];
}

function readVetterSource(source: Record<string, unknown>): VetterReport | null {
  const hasDanger = 'danger' in source || 'dangers' in source;
  const hasWarning = 'warning' in source || 'warnings' in source;

  if (!hasDanger && !hasWarning) {
    return null;
  }

  return {
    dangers: readFindings(source.danger ?? source.dangers),
    warnings: readFindings(source.warning ?? source.warnings),
  };
}

/**
 * Достаёт отчёт Vetter из произвольного ответа API. Поддерживает плоский
 * вариант (`{ danger, warning }`) и вложенный (`{ vetter: { ... } }`).
 */
export function extractVetterReport(value: unknown): VetterReport | null {
  if (!isRecord(value)) {
    return null;
  }

  const direct = readVetterSource(value);

  if (direct !== null) {
    return direct;
  }

  return isRecord(value.vetter) ? readVetterSource(value.vetter) : null;
}

export function getVetterReportFromError(error: unknown): VetterReport | null {
  if (!isAxiosError(error) || error.response === undefined) {
    return null;
  }

  return extractVetterReport(error.response.data);
}

export async function fetchRegistrySkills(): Promise<RegistrySkill[]> {
  const { data } = await api.get<RegistrySkill[]>('/registry/skills');

  return data;
}

/** Разрешения, которые Vetter подсвечивает пользователю. */
const DANGEROUS_PERMISSIONS = new Set(['network', 'shell']);

/** Разрешения, допустимые схемой манифеста Skill. */
const ALLOWED_PERMISSIONS = new Set([
  'network',
  'filesystem',
  'shell',
  'secrets',
  'hardware',
]);

/**
 * Локальная проверка карточки реестра: реестр отдаёт `permissions`, поэтому
 * предупреждение можно показать до установки, не дожидаясь ответа Vetter.
 */
export function getRegistryVetterReport(
  skill: RegistrySkill,
): VetterReport | null {
  const permissions = skill.permissions ?? [];
  const dangerous = permissions.filter((permission) =>
    DANGEROUS_PERMISSIONS.has(permission),
  );

  if (dangerous.length === 0) {
    return null;
  }

  return {
    dangers: [],
    warnings: [
      i18n.t('store.vetter.permissions', {
        permissions: dangerous.join(', '),
      }),
    ],
  };
}

/** Цена карточки в формате бейджа: реестр может отдавать `price` или `pricing`. */
export function getRegistryPricing(
  skill: RegistrySkill,
): SkillPricing | undefined {
  if (skill.pricing !== undefined) {
    return skill.pricing;
  }

  if (typeof skill.price !== 'number') {
    return undefined;
  }

  if (skill.price <= 0) {
    return { model: 'Free' };
  }

  // dzen-article продаётся за результат, даже если реестр отдал только price.
  if (skill.name.toLowerCase().startsWith('dzen')) {
    return {
      model: 'Pay-per-Outcome',
      price: skill.price,
      currency: 'RUB',
    };
  }

  return { model: 'Pay-per-Call', price: skill.price, currency: 'RUB' };
}

/**
 * Собирает `SKILL.md` из карточки реестра. Бэкенд принимает установку
 * манифестом, а реестр отдаёт только метаданные карточки. JSON — валидный
 * YAML, поэтому frontmatter формируется без ручного экранирования.
 */
function buildSkillFileContent(skill: RegistrySkill): string {
  const permissions = (skill.permissions ?? []).filter((permission) =>
    ALLOWED_PERMISSIONS.has(permission),
  );
  const manifest: Record<string, unknown> = {
    name: skill.name,
    version: skill.version ?? '1.0.0',
    description: (skill.description ?? skill.name).slice(0, 256),
    author: { name: skill.author ?? 'SkillWharf' },
    permissions,
  };
  const pricing = getRegistryPricing(skill);

  if (pricing !== undefined && pricing.model !== 'Free') {
    manifest.pricing = pricing;
  }

  return `---\n${JSON.stringify(manifest, null, 2)}\n---\n`;
}

function buildInstallBody(
  skill: RegistrySkill,
  ignoreWarnings: boolean,
): Record<string, unknown> {
  // Контракт установки по идентификатору (реестр отдаёт `id`).
  if (skill.id !== undefined) {
    return { skillId: skill.id, ignoreWarnings };
  }

  // Текущий контракт API: установка передаёт текст SKILL.md.
  return { fileContent: buildSkillFileContent(skill) };
}

export async function installRegistrySkill({
  skill,
  ignoreWarnings = false,
}: InstallRegistrySkillInput): Promise<InstallRegistrySkillResult> {
  const { data } = await api.post<unknown>(
    '/skills/install',
    buildInstallBody(skill, ignoreWarnings),
  );

  return { vetter: extractVetterReport(data) };
}

export function getStoreErrorMessage(
  error: unknown,
  fallbackKey: 'store.errors.load' | 'store.errors.install',
): string {
  if (isAxiosError(error)) {
    if (error.response === undefined) {
      return i18n.t('store.errors.network');
    }

    const { status } = error.response;

    if (status === 401) {
      return i18n.t('store.errors.sessionExpired');
    }

    if (status === 403) {
      return i18n.t('store.errors.adminOnly');
    }

    if (status === 404 && fallbackKey === 'store.errors.load') {
      return i18n.t('store.errors.notFound');
    }

    const data: unknown = error.response.data;

    if (isMessagePayload(data)) {
      return formatServerMessage(data.message);
    }

    return i18n.t(fallbackKey);
  }

  if (error instanceof Error && error.message !== '') {
    return error.message;
  }

  return i18n.t(fallbackKey);
}

import { fqdnSchema } from '@skillwharf/shared';
import { invalidRequestError } from '../common/api-error.js';

/**
 * Политика egress навыка. `allowlist` — точные FQDN-домены, к которым
 * разрешены исходящие соединения (ADR 0004, п.3). Пустой список означает
 * полный запрет сети.
 */
export interface EgressPolicy {
  readonly allowlist: readonly string[];
}

/** Итоговый сетевой план, который API передаёт sandbox-worker. */
export interface SandboxNetworkPlan {
  readonly network: 'bridge' | 'none';
  readonly egressAllowlist: readonly string[];
}

/**
 * Legacy-флаг в `env` запроса: раньше включал сеть контейнера. Сейчас сеть
 * задаётся только `EgressPolicy`: флаг по-прежнему вычищается из env и НЕ
 * влияет на план сети (deny by default).
 */
export const SANDBOX_NETWORK_FLAG = 'ALLOW_NETWORK';

/**
 * Legacy-переменная окружения API: раньше глобально включала сеть всем
 * вызовам песочницы. Оставлена только как имя для диагностики/уборки; на
 * сетевой план не влияет — иначе один env-флаг ломал бы deny by default.
 */
export const SANDBOX_ALLOW_NETWORK_ENV = 'SANDBOX_ALLOW_NETWORK';

/** Максимум доменов в allowlist (совпадает с `egressAllowlistSchema`). */
export const MAX_EGRESS_ALLOWLIST = 50;

/**
 * Нормализует домен: убирает пробелы, приводит к нижнему регистру и
 * проверяет `fqdnSchema` (без схемы, порта, пути и wildcard).
 *
 * Бросает `invalidRequestError` (HTTP 400, единый JSON): невалидный домен —
 * ошибка запроса, а не внутренняя ошибка.
 */
function normalizeDomain(value: unknown): string {
  if (typeof value !== 'string') {
    throw invalidRequestError(
      'egress.allowlist: каждый домен должен быть строкой',
    );
  }

  const normalized = value.trim().toLowerCase();
  const parsed = fqdnSchema.safeParse(normalized);

  if (!parsed.success) {
    throw invalidRequestError(
      `egress.allowlist: недопустимый домен "${value}" — ожидается FQDN ` +
        'в нижнем регистре без схемы, порта, пути и wildcard',
    );
  }

  return parsed.data;
}

/**
 * Валидирует и нормализует allowlist: FQDN по `fqdnSchema`, не более 50
 * уникальных доменов. Дубликаты схлопываются (порядок сохраняется), поэтому
 * повторение домена не является ошибкой.
 */
export function normalizeEgressAllowlist(
  rawAllowlist: readonly unknown[],
): string[] {
  if (!Array.isArray(rawAllowlist)) {
    throw invalidRequestError('egress.allowlist должен быть массивом строк');
  }

  const domains = new Set<string>();

  for (const item of rawAllowlist) {
    domains.add(normalizeDomain(item));
  }

  if (domains.size > MAX_EGRESS_ALLOWLIST) {
    throw invalidRequestError(
      `egress.allowlist: не более ${MAX_EGRESS_ALLOWLIST} доменов`,
    );
  }

  return [...domains];
}

/**
 * План сети для песочницы: deny by default.
 *
 * - нет политики/пустой allowlist → `network: 'none'`, egress запрещён;
 * - непустой allowlist → `bridge` + список доменов, к которым worker
 *   разрешит egress через iptables.
 *
 * Глобальный `SANDBOX_ALLOW_NETWORK` намеренно не читается: сеть включает
 * только явный allowlist (ADR 0004, п.3).
 */
export function planSandboxNetwork(egress?: EgressPolicy): SandboxNetworkPlan {
  const egressAllowlist = normalizeEgressAllowlist(egress?.allowlist ?? []);

  if (egressAllowlist.length === 0) {
    return { network: 'none', egressAllowlist: [] };
  }

  return { network: 'bridge', egressAllowlist };
}

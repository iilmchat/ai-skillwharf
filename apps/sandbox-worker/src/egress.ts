import { z } from 'zod';

/**
 * FQDN-aware egress worker-а (ADR 0004, п.3).
 *
 * Worker сам валидирует payload (defense-in-depth: API мог быть скомпрометирован)
 * и превращает allowlist в конфиг контейнера + правила iptables. Чистые
 * функции вынесены из `index.ts`, чтобы тестировать логику без Docker.
 */

/** Максимальная длина shell-кода (совпадает с лимитом API). */
export const MAX_CODE_LENGTH = 256 * 1024;

/** Максимум доменов в allowlist (совпадает с `egressAllowlistSchema` shared). */
export const MAX_EGRESS_ALLOWLIST = 50;

/** Пользователь, от которого выполняется код навыка после настройки egress. */
export const SANDBOX_USER = '65534:65534';

/** Путь к root-entrypoint с настройкой iptables внутри sandbox-образа. */
export const EGRESS_SETUP_PATH = '/usr/local/bin/sandbox-egress-setup.sh';

/** Env с JSON-массивом разрешённых FQDN для entrypoint-а. */
export const EGRESS_ALLOWLIST_ENV = 'SANDBOX_EGRESS_ALLOWLIST';

/** Env с кодом навыка (для диагностики; выполняется через Cmd). */
export const SANDBOX_CODE_ENV = 'SANDBOX_CODE';

/** Legacy-флаг, который не должен попадать в sandbox-контейнер. */
export const SANDBOX_NETWORK_FLAG = 'ALLOW_NETWORK';

/** Встроенный DNS-резолвер Docker в bridge-сети. */
export const DNS_RESOLVER_IP = '127.0.0.11';

/** Порты, разрешённые для egress (только HTTP/HTTPS). */
export const EGRESS_PORTS = [80, 443] as const;

/**
 * FQDN без схемы, порта, пути и wildcard.
 *
 * Зеркало `fqdnSchema` из `@skillwharf/shared`: worker не зависит от shared
 * пакета (в его prod-образ не попадает workspace-код), поэтому схема
 * продублирована. Синхронность проверяется тестами API.
 */
export const fqdnSchema = z
  .string()
  .max(253)
  .regex(
    /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/,
    'ожидается FQDN в нижнем регистре без схемы, порта и wildcard',
  );

/** FQDN-allowlist egress: только точные домены, без wildcard. */
export const egressAllowlistSchema = z
  .array(fqdnSchema)
  .max(MAX_EGRESS_ALLOWLIST);

export type SandboxNetwork = 'none' | 'bridge';

/** Валидированный payload `POST /execute`. */
export interface SandboxExecutePayload {
  readonly code: string;
  readonly env: Readonly<Record<string, string>>;
  readonly network: SandboxNetwork;
  readonly egressAllowlist: readonly string[];
}

const sandboxExecutePayloadSchema = z.object({
  code: z.string().min(1).max(MAX_CODE_LENGTH),
  env: z.record(z.string(), z.string()).default({}),
  network: z.enum(['none', 'bridge']).default('none'),
  egressAllowlist: egressAllowlistSchema.default([]),
});

/**
 * Валидирует payload через Zod. Бросает Error с человекочитаемым описанием
 * нарушений: worker отвечает на них HTTP 400 и не создаёт контейнер.
 */
export function parseExecutePayload(value: unknown): SandboxExecutePayload {
  const result = sandboxExecutePayloadSchema.safeParse(value);

  if (!result.success) {
    const details = result.error.issues
      .map((issue) => `${issue.path.join('.') || 'payload'}: ${issue.message}`)
      .join('; ');
    throw new Error(`некорректный payload: ${details}`);
  }

  return result.data;
}

/** true, если `code` превышает допустимый размер (для ответа 413). */
export function isCodeTooLong(value: unknown): boolean {
  if (typeof value !== 'object' || value === null || !('code' in value)) {
    return false;
  }

  return (
    typeof value.code === 'string' && value.code.length > MAX_CODE_LENGTH
  );
}

/**
 * Нормализует allowlist: trim, нижний регистр, удаление дубликатов и
 * повторная проверка FQDN. Нужна, когда allowlist приходит не из Zod-схемы
 * (например, из env entrypoint-а).
 */
export function normalizeEgressAllowlist(
  value: readonly string[],
): readonly string[] {
  const domains = new Set<string>();

  for (const item of value) {
    domains.add(item.trim().toLowerCase());
  }

  return egressAllowlistSchema.parse([...domains]);
}

/**
 * Эффективная сеть: bridge без allowlist принудительно превращается в none,
 * чтобы контейнер не оказался в сети без фильтра (deny by default).
 */
export function resolveEffectiveNetwork(payload: SandboxExecutePayload): {
  readonly network: SandboxNetwork;
  readonly egressAllowlist: readonly string[];
} {
  const egressAllowlist = normalizeEgressAllowlist(payload.egressAllowlist);

  if (payload.network === 'bridge' && egressAllowlist.length > 0) {
    return { network: 'bridge', egressAllowlist };
  }

  return { network: 'none', egressAllowlist: [] };
}

/** Runtime-параметры worker-а, не зависящие от конкретного запроса. */
export interface SandboxRuntimeConfig {
  readonly image: string;
  readonly securityOpts: readonly string[];
  readonly memoryLimitBytes: number;
  readonly nanoCpus: number;
}

/**
 * Конфиг для `docker.createContainer`. Без allowlist — прежнее поведение:
 * `network: none`, User 65534, CapDrop ALL, seccomp из `securityOpts`.
 * С allowlist — bridge и capabilities, нужные root-entrypoint-у:
 * `NET_ADMIN` для iptables, `SETUID`/`SETGID` для `su-exec` (сброс прав до
 * 65534 после настройки). Все остальные capabilities сняты, а после setuid
 * эффективный набор обнуляется ядром.
 */
export interface SandboxContainerConfig {
  readonly Image: string;
  readonly Cmd: string[];
  readonly Entrypoint?: string[];
  readonly User?: string;
  readonly Env: string[];
  readonly HostConfig: {
    readonly NetworkMode: SandboxNetwork;
    readonly ReadonlyRootfs: boolean;
    readonly CapDrop: string[];
    readonly CapAdd?: string[];
    readonly SecurityOpt: string[];
    readonly Tmpfs: Record<string, string>;
    readonly Memory: number;
    readonly NanoCpus: number;
  };
}

/** Capabilities root-entrypoint-а: iptables + su-exec. Больше ничего. */
export const EGRESS_CAPABILITIES = ['NET_ADMIN', 'SETUID', 'SETGID'] as const;

const RESERVED_ENV_KEYS = new Set<string>([
  SANDBOX_NETWORK_FLAG,
  EGRESS_ALLOWLIST_ENV,
  SANDBOX_CODE_ENV,
]);

function buildEnv(env: Readonly<Record<string, string>>): string[] {
  return Object.entries(env)
    .filter(([key]) => !RESERVED_ENV_KEYS.has(key))
    .map(([key, value]) => `${key}=${value}`);
}

/**
 * Собирает конфиг контейнера: сеть из payload, egress-env для entrypoint-а,
 * seccomp/privileges из runtime-настроек worker-а.
 */
export function buildContainerConfig(
  payload: SandboxExecutePayload,
  runtime: SandboxRuntimeConfig,
): SandboxContainerConfig {
  const { network, egressAllowlist } = resolveEffectiveNetwork(payload);
  const egressEnabled = network === 'bridge';
  const env = buildEnv(payload.env);

  if (egressEnabled) {
    env.push(`${EGRESS_ALLOWLIST_ENV}=${JSON.stringify(egressAllowlist)}`);
    env.push(`${SANDBOX_CODE_ENV}=${payload.code}`);
  }

  return {
    Image: runtime.image,
    Cmd: ['sh', '-c', payload.code],
    ...(egressEnabled ? { Entrypoint: [EGRESS_SETUP_PATH] } : {}),
    User: egressEnabled ? undefined : SANDBOX_USER,
    Env: env,
    HostConfig: {
      NetworkMode: network,
      ReadonlyRootfs: true,
      CapDrop: ['ALL'],
      ...(egressEnabled ? { CapAdd: [...EGRESS_CAPABILITIES] } : {}),
      SecurityOpt: [...runtime.securityOpts],
      // iptables пишет xtables-lock в /run; без tmpfs read-only rootfs ломает
      // настройку egress.
      Tmpfs: egressEnabled ? { '/tmp': '', '/run': '' } : { '/tmp': '' },
      Memory: runtime.memoryLimitBytes,
      NanoCpus: runtime.nanoCpus,
    },
  };
}

/** Резолвер FQDN → IP-адреса. В worker-е чистый, в entrypoint-е — getent/ip. */
export type HostResolver = (fqdn: string) => readonly string[];

/** План egress: что резолвилось, что нет и какие правила применять. */
export interface EgressSetupPlan {
  readonly allowlist: readonly string[];
  readonly resolved: Readonly<Record<string, readonly string[]>>;
  readonly unresolved: readonly string[];
  /** Упорядоченные команды iptables (ACCEPT, затем политики DROP). */
  readonly iptables: readonly string[];
  /** Упорядоченные команды ip6tables (ACCEPT, затем политики DROP). */
  readonly ip6tables: readonly string[];
}

function isIpv6(ip: string): boolean {
  return ip.includes(':');
}

/**
 * Чистый план настройки egress, зеркалящий `sandbox/egress-setup.sh`:
 * loopback + DNS 127.0.0.11, ACCEPT tcp/80,443 только для IP, в которые
 * резолвятся домены allowlist, затем политика OUTPUT/INPUT/FORWARD DROP.
 *
 * Нерезолвнутый домен не получает ни одного ACCEPT-правила (fail closed).
 * IPv6-правила собираются для найденных AAAA-адресов; в entrypoint-е ошибки
 * ip6tables не фатальны (residual risk).
 */
export function buildEgressSetup(
  allowlist: readonly string[],
  resolveHost: HostResolver,
): EgressSetupPlan {
  const normalized = [...new Set(allowlist.map((d) => d.trim().toLowerCase()))];
  const resolved: Record<string, readonly string[]> = {};
  const unresolved: string[] = [];
  const iptables: string[] = [
    'iptables -A INPUT -i lo -j ACCEPT',
    'iptables -A OUTPUT -o lo -j ACCEPT',
    `iptables -A OUTPUT -p udp -d ${DNS_RESOLVER_IP} --dport 53 -j ACCEPT`,
    `iptables -A OUTPUT -p tcp -d ${DNS_RESOLVER_IP} --dport 53 -j ACCEPT`,
  ];
  const ip6tables: string[] = [
    'ip6tables -A INPUT -i lo -j ACCEPT',
    'ip6tables -A OUTPUT -o lo -j ACCEPT',
  ];

  for (const domain of normalized) {
    const ips = [...new Set(resolveHost(domain).map((ip) => ip.trim()))].filter(
      (ip) => ip.length > 0,
    );

    if (ips.length === 0) {
      unresolved.push(domain);
      continue;
    }

    resolved[domain] = ips;

    for (const ip of ips) {
      const target = isIpv6(ip) ? ip6tables : iptables;
      const command = isIpv6(ip) ? 'ip6tables' : 'iptables';

      for (const port of EGRESS_PORTS) {
        target.push(
          `${command} -A OUTPUT -p tcp -d ${ip} --dport ${port} -j ACCEPT`,
        );
      }
    }
  }

  iptables.push(
    'iptables -A OUTPUT -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT',
    'iptables -A INPUT -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT',
    'iptables -P INPUT DROP',
    'iptables -P FORWARD DROP',
    'iptables -P OUTPUT DROP',
  );

  ip6tables.push(
    'ip6tables -A OUTPUT -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT',
    'ip6tables -A INPUT -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT',
    'ip6tables -P INPUT DROP',
    'ip6tables -P FORWARD DROP',
    'ip6tables -P OUTPUT DROP',
  );

  return { allowlist: normalized, resolved, unresolved, iptables, ip6tables };
}

import { resolve4, resolve6 } from 'node:dns/promises';
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

/**
 * UID, которому разрешён DNS. Только root-entrypoint резолвит allowlist до
 * сброса привилегий; коду под 65534 DNS недоступен (anti DNS-tunneling).
 */
export const DNS_ALLOWED_UID = 0;

/** Порт DNS; после настройки для не-root трафика явно DROP-ается. */
export const DNS_PORT = 53;

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

/** DNS-резолвер для ExtraHosts; в тестах подменяется. */
export interface EgressDnsResolver {
  readonly resolve4: (fqdn: string) => Promise<readonly string[]>;
  readonly resolve6: (fqdn: string) => Promise<readonly string[]>;
}

/** Резолвнутый allowlist-домен: ExtraHosts использует только IPv4. */
export interface ResolvedEgressHost {
  readonly fqdn: string;
  readonly addresses4: readonly string[];
  readonly addresses6: readonly string[];
}

/** Результат резолва allowlist в worker-е. */
export interface EgressHostsResolution {
  /** Домены с IPv4-адресами: для них строятся ExtraHosts. */
  readonly resolved: readonly ResolvedEgressHost[];
  /** Домены без IPv4 (DNS-ошибка/нет A-записи): ExtraHosts не строятся. */
  readonly unresolved: readonly string[];
  /** Домены, у которых есть только AAAA: Docker ExtraHosts не умеет IPv6. */
  readonly ipv6Only: readonly string[];
}

const defaultDnsResolver: EgressDnsResolver = {
  resolve4: (fqdn) => resolve4(fqdn),
  resolve6: (fqdn) => resolve6(fqdn),
};

/** Безопасный резолв: ошибка DNS не роняет запрос, домен просто пропускается. */
async function resolveAddresses(
  resolver: (fqdn: string) => Promise<readonly string[]>,
  fqdn: string,
  family: 4 | 6,
): Promise<string[]> {
  try {
    const addresses = await resolver(fqdn);

    return [
      ...new Set(
        addresses
          .map((address) => address.trim())
          .filter(
            (address) =>
              address.length > 0 &&
              (family === 6 ? address.includes(':') : !address.includes(':')),
          ),
      ),
    ];
  } catch {
    return [];
  }
}

/**
 * Резолвит домены egress-allowlist в IPv4/IPv6 (обе записи).
 *
 * Вызывается worker-ом ПЕРЕД `createContainer`, чтобы передать
 * `HostConfig.ExtraHosts`: Docker инжектит их в `/etc/hosts` даже при
 * `ReadonlyRootfs: true`, где entrypoint не может дописать файл.
 * Ошибка отдельного домена не фатальна — он пропускается (`unresolved`).
 */
export async function resolveEgressHosts(
  allowlist: readonly string[],
  resolver: EgressDnsResolver = defaultDnsResolver,
): Promise<EgressHostsResolution> {
  const domains = [
    ...new Set(
      allowlist.map((domain) => domain.trim().toLowerCase()).filter(Boolean),
    ),
  ];
  const resolved: ResolvedEgressHost[] = [];
  const unresolved: string[] = [];
  const ipv6Only: string[] = [];

  for (const fqdn of domains) {
    const [addresses4, addresses6] = await Promise.all([
      resolveAddresses(resolver.resolve4, fqdn, 4),
      resolveAddresses(resolver.resolve6, fqdn, 6),
    ]);

    if (addresses4.length === 0) {
      if (addresses6.length > 0) {
        ipv6Only.push(fqdn);
      } else {
        unresolved.push(fqdn);
      }
      continue;
    }

    resolved.push({ fqdn, addresses4, addresses6 });
  }

  return { resolved, unresolved, ipv6Only };
}

/**
 * Строит `HostConfig.ExtraHosts` (`<fqdn>:<ipv4>`) из резолвнутых доменов.
 *
 * Docker ExtraHosts поддерживает только IPv4; IPv6-адреса игнорируются.
 * Дубликаты FQDN схлопываются (первое вхождение), повторы IP убираются.
 */
export function buildExtraHosts(
  resolved: ReadonlyArray<Pick<ResolvedEgressHost, 'fqdn' | 'addresses4'>>,
): string[] {
  const entries: string[] = [];
  const seenFqdn = new Set<string>();

  for (const domain of resolved) {
    const fqdn = domain.fqdn.trim().toLowerCase();

    if (fqdn.length === 0 || seenFqdn.has(fqdn)) {
      continue;
    }

    seenFqdn.add(fqdn);

    for (const address of new Set(domain.addresses4)) {
      if (address.length > 0 && !address.includes(':')) {
        entries.push(`${fqdn}:${address}`);
      }
    }
  }

  return entries;
}

/**
 * Оставляет только ExtraHosts для доменов из allowlist (защита от подмены
 * hostname в конфиге) и только IPv4-формат `host:ip`.
 */
function filterExtraHosts(
  extraHosts: readonly string[],
  allowedDomains: readonly string[],
): string[] {
  const allowed = new Set(allowedDomains);
  const entries: string[] = [];
  const seen = new Set<string>();

  for (const entry of extraHosts) {
    const separator = entry.indexOf(':');

    if (separator <= 0) {
      continue;
    }

    const host = entry.slice(0, separator);
    const address = entry.slice(separator + 1);

    if (
      !allowed.has(host) ||
      address.length === 0 ||
      address.includes(':') ||
      seen.has(entry)
    ) {
      continue;
    }

    seen.add(entry);
    entries.push(entry);
  }

  return entries;
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
    /**
     * `<fqdn>:<ipv4>` для allowlist-доменов. Docker инжектит записи в
     * `/etc/hosts` даже при `ReadonlyRootfs: true` — это prod-путь резолва
     * разрешённых доменов без DNS (entrypoint-запись best-effort).
     */
    readonly ExtraHosts?: string[];
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
 * ExtraHosts (IPv4), seccomp/privileges из runtime-настроек worker-а.
 */
export function buildContainerConfig(
  payload: SandboxExecutePayload,
  runtime: SandboxRuntimeConfig,
  extraHosts: readonly string[] = [],
): SandboxContainerConfig {
  const { network, egressAllowlist } = resolveEffectiveNetwork(payload);
  const egressEnabled = network === 'bridge';
  const env = buildEnv(payload.env);
  const safeExtraHosts = egressEnabled
    ? filterExtraHosts(extraHosts, egressAllowlist)
    : [];

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
      ...(safeExtraHosts.length > 0 ? { ExtraHosts: safeExtraHosts } : {}),
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
  /**
   * Строки для `/etc/hosts` вида `<ip> <fqdn>` (IPv4 и IPv6), чтобы
   * разрешённые домены резолвились без DNS (коду под 65534 DNS запрещён).
   */
  readonly hosts: readonly string[];
  /** Упорядоченные команды iptables (ACCEPT, затем политики DROP). */
  readonly iptables: readonly string[];
  /** Упорядоченные команды ip6tables (ACCEPT, затем политики DROP). */
  readonly ip6tables: readonly string[];
}

function isIpv6(ip: string): boolean {
  return ip.includes(':');
}

/**
 * Строит записи `/etc/hosts` для резолвнутых доменов: `<ip> <fqdn>` для
 * каждого IPv4/IPv6-адреса. Порядок — как в `resolved` (домены и IP внутри
 * домена).
 */
export function buildHostsEntries(
  resolved: Readonly<Record<string, readonly string[]>>,
): string[] {
  const entries: string[] = [];

  for (const [domain, ips] of Object.entries(resolved)) {
    for (const ip of ips) {
      entries.push(`${ip} ${domain}`);
    }
  }

  return entries;
}

/**
 * Чистый план настройки egress, зеркалящий `sandbox/egress-setup.sh`:
 * loopback; DNS 127.0.0.11:53 только для root (`-m owner --uid-owner 0`),
 * остальным — явный DROP на оригинальный dport 53 (anti DNS-tunneling);
 * ACCEPT tcp/80,443 только для IP, в которые резолвятся домены allowlist;
 * записи `/etc/hosts` для резолвнутых доменов; затем политика
 * OUTPUT/INPUT/FORWARD DROP.
 *
 * DNS-правила используют `conntrack --ctorigdstport`, а не `--dport`: Docker
 * DNAT-ит 127.0.0.11:53 на локальный порт resolver-а, поэтому после NAT
 * `--dport 53` уже не совпадает. DROP DNS стоит до общего loopback-ACCEPT,
 * иначе loopback-правило пропустило бы DNS для всех.
 *
 * Нерезолвнутый домен не получает ни одного ACCEPT-правила и hosts-записи
 * (fail closed). IPv6-правила строятся всегда: entrypoint применяет их
 * строго (fail closed), если IPv6-стек присутствует, и пропускает с логом,
 * если IPv6 выключен.
 */
export function buildEgressSetup(
  allowlist: readonly string[],
  resolveHost: HostResolver,
): EgressSetupPlan {
  const normalized = [...new Set(allowlist.map((d) => d.trim().toLowerCase()))];
  const resolved: Record<string, readonly string[]> = {};
  const unresolved: string[] = [];
  const iptables: string[] = ['iptables -A INPUT -i lo -j ACCEPT'];
  const ip6tables: string[] = ['ip6tables -A INPUT -i lo -j ACCEPT'];

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
    // DNS: ACCEPT только для root-entrypoint. `--ctorigdst`/`--ctorigdstport`
    // смотрят на адрес до DNAT, которым Docker перенаправляет 127.0.0.11:53.
    `iptables -A OUTPUT -p udp -m conntrack --ctorigdst ${DNS_RESOLVER_IP} --ctorigdstport ${DNS_PORT} -m owner --uid-owner ${DNS_ALLOWED_UID} -j ACCEPT`,
    `iptables -A OUTPUT -p tcp -m conntrack --ctorigdst ${DNS_RESOLVER_IP} --ctorigdstport ${DNS_PORT} -m owner --uid-owner ${DNS_ALLOWED_UID} -j ACCEPT`,
    // Явный DROP DNS для всех остальных (в т.ч. к любым другим резолверам) —
    // до общего loopback-ACCEPT, чтобы тот не обходил запрет.
    `iptables -A OUTPUT -p udp -m conntrack --ctorigdstport ${DNS_PORT} -j DROP`,
    `iptables -A OUTPUT -p tcp -m conntrack --ctorigdstport ${DNS_PORT} -j DROP`,
    'iptables -A OUTPUT -o lo -j ACCEPT',
    'iptables -A OUTPUT -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT',
    'iptables -A INPUT -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT',
    'iptables -P INPUT DROP',
    'iptables -P FORWARD DROP',
    'iptables -P OUTPUT DROP',
  );

  ip6tables.push(
    `ip6tables -A OUTPUT -p udp -m conntrack --ctorigdst ::1 --ctorigdstport ${DNS_PORT} -m owner --uid-owner ${DNS_ALLOWED_UID} -j ACCEPT`,
    `ip6tables -A OUTPUT -p tcp -m conntrack --ctorigdst ::1 --ctorigdstport ${DNS_PORT} -m owner --uid-owner ${DNS_ALLOWED_UID} -j ACCEPT`,
    `ip6tables -A OUTPUT -p udp -m conntrack --ctorigdstport ${DNS_PORT} -j DROP`,
    `ip6tables -A OUTPUT -p tcp -m conntrack --ctorigdstport ${DNS_PORT} -j DROP`,
    'ip6tables -A OUTPUT -o lo -j ACCEPT',
    'ip6tables -A OUTPUT -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT',
    'ip6tables -A INPUT -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT',
    'ip6tables -P INPUT DROP',
    'ip6tables -P FORWARD DROP',
    'ip6tables -P OUTPUT DROP',
  );

  return {
    allowlist: normalized,
    resolved,
    unresolved,
    hosts: buildHostsEntries(resolved),
    iptables,
    ip6tables,
  };
}

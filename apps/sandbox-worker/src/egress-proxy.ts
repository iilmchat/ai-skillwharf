import { resolve4, resolve6 } from 'node:dns/promises';
import { request as httpRequest, type IncomingMessage, type ServerResponse } from 'node:http';
import { connect as netConnect, type Socket } from 'node:net';
import { z } from 'zod';
import {
  egressAllowlistSchema,
  fqdnSchema,
  type EgressDnsResolver,
} from './egress.js';

/**
 * SNI/Host egress-прокси (SEC-25.3, закрытие KI-028 и KI-042).
 *
 * Три независимых барьера:
 *   1. точное совпадение SNI (TLS ClientHello) или Host (HTTP) с allowlist;
 *   2. резолвинг FQDN перед подключением и pins соединения к проверенному IP;
 *   3. блокировка приватных/loopback/link-local/metadata диапазонов — защита
 *      от DNS rebinding и SSRF (169.254.169.254, 127.0.0.1, ::1 и т.д.).
 *
 * Чистые функции не требуют дружественной сети и покрыты unit-тестами;
 * `EgressForwardProxy` добавляет к ним реальные CONNECT/HTTP-хендлеры.
 */

const TLS_HANDSHAKE_RECORD = 0x16;
const TLS_CLIENT_HELLO = 0x01;
const TLS_EXTENSION_SERVER_NAME = 0x0000;
const TLS_SNI_HOST_NAME = 0x00;

const ipSchema = z.union([z.ipv4(), z.ipv6()]);

const hostPortSchema = z
  .string()
  .min(1)
  .max(253 + 6)
  .transform((value) => {
    const trimmed = value.trim();

    // CONNECT всегда приходит как `host:port`; IPv6-литералы в allowlist не
    // допускаются, поэтому квадратные скобки здесь не поддерживаются.
    const separator = trimmed.lastIndexOf(':');

    if (separator <= 0) {
      return { host: trimmed, port: NaN };
    }

    return {
      host: trimmed.slice(0, separator),
      port: Number(trimmed.slice(separator + 1)),
    };
  });

function requireBytes(buffer: Buffer, offset: number, length: number): void {
  if (offset < 0 || length < 0 || offset + length > buffer.length) {
    throw new Error('ClientHello: не хватает байт');
  }
}

function readUInt8(buffer: Buffer, offset: number): number {
  requireBytes(buffer, offset, 1);
  return buffer.readUInt8(offset);
}

function readUInt16(buffer: Buffer, offset: number): number {
  requireBytes(buffer, offset, 2);
  return buffer.readUInt16BE(offset);
}

function readUInt24(buffer: Buffer, offset: number): number {
  requireBytes(buffer, offset, 3);
  return buffer.readUIntBE(offset, 3);
}

/**
 * Достаёт server_name из TLS ClientHello (SNI extension 0x0000).
 *
 * Возвращает `undefined` на любую некорректную/неполную запись: вызывающий
 * обязан трактовать это как отказ. Имя проверяется той же Zod-схемой FQDN,
 * что и allowlist, поэтому IP-литерал, wildcard и неполный домен не пройдут.
 */
export function parseClientHelloSni(input: Uint8Array): string | undefined {
  try {
    const buffer = Buffer.from(input.buffer, input.byteOffset, input.byteLength);

    if (readUInt8(buffer, 0) !== TLS_HANDSHAKE_RECORD) {
      return undefined;
    }

    const recordLength = readUInt16(buffer, 3);

    if (recordLength < 4 || readUInt8(buffer, 5) !== TLS_CLIENT_HELLO) {
      return undefined;
    }

    const handshakeLength = readUInt24(buffer, 6);
    const handshakeEnd = 9 + handshakeLength;

    // 5 — начало handshake, 9 — начало тела ClientHello.
    if (handshakeEnd > 5 + recordLength || handshakeEnd > buffer.length) {
      return undefined;
    }

    let offset = 9;
    offset += 2; // client_version
    offset += 32; // random
    offset += 1 + readUInt8(buffer, offset); // session_id + its length
    offset += 2 + readUInt16(buffer, offset); // cipher_suites + its length
    offset += 1 + readUInt8(buffer, offset); // compression_methods + its length

    if (offset + 2 > handshakeEnd) {
      return undefined; // extensions отсутствуют
    }

    const extensionsLength = readUInt16(buffer, offset);
    offset += 2;
    const extensionsEnd = Math.min(offset + extensionsLength, handshakeEnd);

    while (offset + 4 <= extensionsEnd) {
      const type = readUInt16(buffer, offset);
      const length = readUInt16(buffer, offset + 2);
      const dataStart = offset + 4;
      const dataEnd = dataStart + length;

      if (dataEnd > extensionsEnd) {
        return undefined;
      }

      if (type === TLS_EXTENSION_SERVER_NAME) {
        let position = dataStart;
        const listLength = readUInt16(buffer, position);
        position += 2;

        if (position + listLength > dataEnd) {
          return undefined;
        }

        const listEnd = position + listLength;

        while (position + 3 <= listEnd) {
          const nameType = readUInt8(buffer, position);
          position += 1;
          const nameLength = readUInt16(buffer, position);
          position += 2;
          const nameEnd = position + nameLength;

          if (nameEnd > listEnd) {
            return undefined;
          }

          if (nameType === TLS_SNI_HOST_NAME && nameLength > 0) {
            const name = buffer.subarray(position, nameEnd).toString('utf8');
            const parsed = fqdnSchema.safeParse(name.toLowerCase());
            return parsed.success ? parsed.data : undefined;
          }

          position = nameEnd;
        }

        return undefined;
      }

      offset = dataEnd;
    }

    return undefined;
  } catch {
    return undefined;
  }
}

/**
 * Нормализует Host HTTP-запроса (`example.com:443` → `example.com`).
 * Возвращает `undefined` для IP, wildcard, схемы и не-FQDN — такой хост
 * не может быть разрешён через allowlist.
 */
export function parseHttpHost(value: string | undefined): string | undefined {
  if (!value) {
    return undefined;
  }

  const trimmed = value.trim();

  if (trimmed.includes(',') || trimmed.includes('/')) {
    return undefined; // несколько Host или попытка передать URL
  }

  const host = trimmed.startsWith('[')
    ? trimmed.slice(1, trimmed.indexOf(']'))
    : trimmed.split(':')[0];

  const parsed = fqdnSchema.safeParse(host.toLowerCase());

  return parsed.success ? parsed.data : undefined;
}

/** Достаёт Host из сырого блока HTTP-заголовков (регистр не важен). */
export function extractHttpHost(rawHeaders: string): string | undefined {
  for (const line of rawHeaders.split(/\r?\n/)) {
    const separator = line.indexOf(':');

    if (separator > 0 && line.slice(0, separator).trim().toLowerCase() === 'host') {
      return parseHttpHost(line.slice(separator + 1));
    }
  }

  return undefined;
}

/**
 * Точное совпадение домена со списком. Список тоже валидируется Zod:
 * подмена hostname через невалидную запись не приведёт к совпадению.
 */
export function isHostAllowed(
  host: string,
  allowlist: readonly string[],
): boolean {
  const parsedHost = fqdnSchema.safeParse(host.trim().toLowerCase());

  if (!parsedHost.success) {
    return false;
  }

  const parsedList = egressAllowlistSchema.safeParse(
    allowlist.map((domain) => domain.trim().toLowerCase()),
  );

  if (!parsedList.success) {
    return false;
  }

  return new Set(parsedList.data).has(parsedHost.data);
}

function ipv4ToNumber(ip: string): number {
  const parts = ip.split('.').map((part) => Number(part));

  return (
    ((parts[0] << 24) + (parts[1] << 16) + (parts[2] << 8) + parts[3]) >>> 0
  );
}

function isIpv4InRange(address: string, base: string, bits: number): boolean {
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;

  return (ipv4ToNumber(address) & mask) === (ipv4ToNumber(base) & mask);
}

const BLOCKED_IPV4_RANGES: ReadonlyArray<readonly [string, number]> = [
  ['0.0.0.0', 8], // "this network"
  ['10.0.0.0', 8], // RFC 1918
  ['100.64.0.0', 10], // CGNAT
  ['127.0.0.0', 8], // loopback
  ['169.254.0.0', 16], // link-local + cloud metadata (169.254.169.254)
  ['172.16.0.0', 12], // RFC 1918
  ['192.0.0.0', 24], // IETF protocol assignments
  ['192.168.0.0', 16], // RFC 1918
  ['198.18.0.0', 15], // benchmarking
  ['224.0.0.0', 4], // multicast
  ['240.0.0.0', 4], // reserved (включая 255.255.255.255)
];

function isBlockedIpv4(ip: string): boolean {
  return BLOCKED_IPV4_RANGES.some(([base, bits]) => isIpv4InRange(ip, base, bits));
}

function parseIpv6Groups(ip: string): number[] | undefined {
  const address = ip.split('%')[0];

  if (address === '::') {
    return Array.from({ length: 8 }, () => 0);
  }

  const doubleColon = address.indexOf('::');
  let left: string[];
  let right: string[];

  if (doubleColon >= 0) {
    if (address.indexOf('::', doubleColon + 2) >= 0) {
      return undefined;
    }

    left = address.slice(0, doubleColon).split(':').filter(Boolean);
    right = address.slice(doubleColon + 2).split(':').filter(Boolean);

    if (left.length + right.length > 7) {
      return undefined;
    }
  } else {
    left = address.split(':');
    right = [];

    if (left.length !== 8) {
      return undefined;
    }
  }

  const groups = [
    ...left,
    ...Array.from({ length: 8 - left.length - right.length }, () => '0'),
    ...right,
  ];

  if (groups.length !== 8) {
    return undefined;
  }

  const numbers: number[] = [];

  for (const group of groups) {
    if (!/^[0-9a-f]{1,4}$/i.test(group)) {
      return undefined;
    }

    numbers.push(Number.parseInt(group, 16));
  }

  return numbers;
}

function isBlockedIpv6(ip: string): boolean {
  const groups = parseIpv6Groups(ip);

  if (!groups) {
    return true; //fail closed на невалидный адрес
  }

  // IPv4-mapped (::ffff:127.0.0.1) проверяем по IPv4-правилам.
  if (
    groups[0] === 0 &&
    groups[1] === 0 &&
    groups[2] === 0 &&
    groups[3] === 0 &&
    groups[4] === 0 &&
    groups[5] === 0xffff
  ) {
    const mapped = `${groups[6] >> 8}.${groups[6] & 0xff}.${groups[7] >> 8}.${groups[7] & 0xff}`;

    return isBlockedIpv4(mapped);
  }

  if (groups.slice(0, 7).every((group) => group === 0) && (groups[7] === 0 || groups[7] === 1)) {
    return true; // :: и ::1
  }

  if ((groups[0] & 0xfe00) === 0xfc00) {
    return true; // fc00::/7 unique local
  }

  if ((groups[0] & 0xffc0) === 0xfe80) {
    return true; // fe80::/10 link-local
  }

  return false;
}

/**
 * Возвращает true для любого адреса, куда песочнице ходить нельзя: private,
 * loopback, link-local, metadata, multicast, невалидный адрес. Публичные
 * адреса (включая documentation-сеть 2001:db8::/32, используемую в тестах)
 * — false.
 */
export function isBlockedIpAddress(value: string): boolean {
  const parsed = ipSchema.safeParse(value.trim());

  if (!parsed.success) {
    return true;
  }

  return parsed.data.includes(':')
    ? isBlockedIpv6(parsed.data.toLowerCase())
    : isBlockedIpv4(parsed.data);
}

/** Ошибка авторизации egress: SNI/Host не в allowlist или небезопасный IP. */
export class UnsafeEgressTargetError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UnsafeEgressTargetError';
  }
}

export const defaultEgressDnsResolver: EgressDnsResolver = {
  resolve4: (fqdn) => resolve4(fqdn),
  resolve6: (fqdn) => resolve6(fqdn),
};

async function safeResolve(
  resolve: (fqdn: string) => Promise<readonly string[]>,
  fqdn: string,
): Promise<string[]> {
  try {
    const addresses = await resolve(fqdn);
    const result: string[] = [];

    for (const address of addresses) {
      const parsed = ipSchema.safeParse(address.trim());

      if (parsed.success) {
        result.push(parsed.data);
      }
    }

    return result;
  } catch {
    return []; // fail closed: DNS-ошибка не даёт зелёного света
  }
}

export interface EgressTargetAuthorization {
  readonly host: string;
  /** Проверенные публичные IP, к которым разрешено подключаться. */
  readonly addresses: readonly string[];
}

/**
 * Полная проверка исходящего соединения: точный Host + безопасный резолв.
 * Возвращает список IP, к которым можно подключаться (IP pinning), и бросает
 * `UnsafeEgressTargetError` при любом нарушении.
 */
export async function authorizeEgressHost(
  host: string,
  allowlist: readonly string[],
  resolver: EgressDnsResolver = defaultEgressDnsResolver,
): Promise<EgressTargetAuthorization> {
  const normalized = parseHttpHost(host);

  if (!normalized || !isHostAllowed(normalized, allowlist)) {
    throw new UnsafeEgressTargetError(`Host не в allowlist: ${host}`);
  }

  const [addresses4, addresses6] = await Promise.all([
    safeResolve(resolver.resolve4, normalized),
    safeResolve(resolver.resolve6, normalized),
  ]);
  const addresses = [...new Set([...addresses4, ...addresses6])];

  if (addresses.length === 0) {
    throw new UnsafeEgressTargetError(`FQDN не резолвится: ${normalized}`);
  }

  const blocked = addresses.filter(isBlockedIpAddress);

  if (blocked.length > 0) {
    throw new UnsafeEgressTargetError(
      `FQDN ${normalized} резолвится в запрещённый IP: ${blocked.join(', ')}`,
    );
  }

  const validated = z.array(ipSchema).min(1).safeParse(addresses);

  if (!validated.success) {
    throw new UnsafeEgressTargetError(`некорректные IP для ${normalized}`);
  }

  return { host: normalized, addresses: validated.data };
}

/**
 * Проверяет весь allowlist задачи до запуска контейнера. Используется
 * DockerSandboxProvider как барьер против DNS rebinding/SSRF через домен,
 * который резолвится в metadata или приватную сеть в момент выполнения.
 */
export async function validateEgressAllowlist(
  allowlist: readonly string[],
  resolver: EgressDnsResolver = defaultEgressDnsResolver,
): Promise<readonly EgressTargetAuthorization[]> {
  const parsed = egressAllowlistSchema.safeParse(
    allowlist.map((domain) => domain.trim().toLowerCase()),
  );

  if (!parsed.success) {
    throw new UnsafeEgressTargetError('некорректный egress-allowlist');
  }

  return Promise.all(parsed.data.map((host) => authorizeEgressHost(host, parsed.data, resolver)));
}

export interface EgressForwardProxyOptions {
  readonly allowlist: readonly string[];
  readonly resolver?: EgressDnsResolver;
  readonly connectTimeoutMs?: number;
}

/**
 * Встроенный forward-прокси. `authorize` — общая точка принятия решения для
 * CONNECT (TLS/SNI) и обычного HTTP (Host). Подключение всегда идёт к IP,
 * полученному при авторизации, а не повторно по имени — это убирает окно
 * DNS rebinding между проверкой и соединением.
 */
export class EgressForwardProxy {
  private readonly allowlist: readonly string[];
  private readonly resolver: EgressDnsResolver;
  private readonly connectTimeoutMs: number;

  constructor(options: EgressForwardProxyOptions) {
    const parsed = egressAllowlistSchema.safeParse(
      options.allowlist.map((domain) => domain.trim().toLowerCase()),
    );

    if (!parsed.success) {
      throw new Error('некорректный egress-allowlist прокси');
    }

    this.allowlist = [...new Set(parsed.data)];
    this.resolver = options.resolver ?? defaultEgressDnsResolver;
    this.connectTimeoutMs = options.connectTimeoutMs ?? 5_000;
  }

  get allowedHosts(): readonly string[] {
    return this.allowlist;
  }

  /** Проверка hostname без DNS — для быстрого отказа до резолва. */
  isAllowed(host: string): boolean {
    return isHostAllowed(host, this.allowlist);
  }

  authorize(host: string): Promise<EgressTargetAuthorization> {
    return authorizeEgressHost(host, this.allowlist, this.resolver);
  }

  /** Проверка всех доменов allowlist перед запуском песочницы. */
  validateAllowlist(): Promise<readonly EgressTargetAuthorization[]> {
    return validateEgressAllowlist(this.allowlist, this.resolver);
  }

  /** HTTP CONNECT: TLS-туннель с проверкой host:port и SNI из первого чанка. */
  async handleConnect(
    target: string,
    client: Socket,
    head: Buffer | undefined,
  ): Promise<void> {
    const parsed = hostPortSchema.safeParse(target);

    if (!parsed.success || !Number.isInteger(parsed.data.port) || (parsed.data.port !== 80 && parsed.data.port !== 443)) {
      client.end('HTTP/1.1 403 Forbidden\r\n\r\n');
      return;
    }

    const { host, port } = parsed.data;

    // CONNECT задаёт адрес туннеля, но внутри него клиент может прислать
    // ClientHello с другим server_name. Проверяем SNI из первого чанка,
    // если он уже есть (обычно TLS ClientHello приходит вместе с CONNECT).
    if (head && head.length > 0 && head[0] === TLS_HANDSHAKE_RECORD) {
      const sni = parseClientHelloSni(head);

      if (!sni || sni !== host) {
        client.end('HTTP/1.1 403 Forbidden\r\n\r\n');
        return;
      }
    }

    try {
      const authorization = await this.authorize(host);
      const upstream = netConnect({ host: authorization.addresses[0], port });

      upstream.setTimeout(this.connectTimeoutMs, () => upstream.destroy());
      upstream.once('connect', () => {
        client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
        if (head && head.length > 0) {
          upstream.write(head);
        }
        upstream.pipe(client);
        client.pipe(upstream);
      });
      upstream.once('error', () => client.destroy());
      client.once('error', () => upstream.destroy());
      client.once('close', () => upstream.destroy());
    } catch {
      client.end('HTTP/1.1 403 Forbidden\r\n\r\n');
    }
  }

  /** Обычный HTTP: проверка заголовка Host и forwarding на проверенный IP. */
  async handleRequest(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const host = parseHttpHost(request.headers.host);

    if (!host || !this.isAllowed(host)) {
      response.writeHead(403).end('Forbidden');
      return;
    }

    try {
      const authorization = await this.authorize(host);
      const upstream = httpRequest({
        host: authorization.addresses[0],
        port: 80,
        method: request.method,
        path: request.url,
        headers: { ...request.headers, host },
      });

      upstream.once('error', () => {
        if (!response.headersSent) {
          response.writeHead(502).end('Bad Gateway');
        } else {
          response.destroy();
        }
      });
      upstream.on('response', (downstream) => {
        response.writeHead(downstream.statusCode ?? 502, downstream.headers);
        downstream.pipe(response);
      });
      request.pipe(upstream);
    } catch {
      if (!response.headersSent) {
        response.writeHead(403).end('Forbidden');
      }
    }
  }
}

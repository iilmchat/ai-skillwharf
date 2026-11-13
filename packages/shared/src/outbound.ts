import { z } from "zod";

/**
 * Домены, которые разрешены для исходящих HTTP-запросов API и llm-worker.
 *
 * Список нужен для интеграций Sprint 18: Telegram Bot API, Google Workspace
 * OAuth/API, а также LLM-провайдеры, которые вызывает worker. Локальные
 * адреса (LM Studio, Ollama, compose-сервисы) считаются private и проходят
 * без allowlist, но только по http.
 */
export const DEFAULT_OUTBOUND_ALLOWLIST: readonly string[] = [
  "api.telegram.org",
  "www.googleapis.com",
  "sheets.googleapis.com",
  "docs.googleapis.com",
  "oauth2.googleapis.com",
  "sheets.googleapis.com",
  "docs.googleapis.com",
  "llm.api.cloud.yandex.net",
  "iam.api.cloud.yandex.net",
  "ngw.devices.sberbank.ru",
  "gigachat.devices.sberbank.ru",
];

/** FQDN или wildcard `*.example.com`. Порт и путь не входят в allowlist. */
export const outboundDomainSchema = z
  .string()
  .trim()
  .toLowerCase()
  .min(1)
  .max(253)
  .regex(
    /^(?:\*\.)?(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/,
    "ожидается FQDN или wildcard *.example.com",
  );

/** Ошибка egress-политики: домен или протокол не разрешён. */
export class OutboundHostNotAllowedError extends Error {
  constructor(
    readonly host: string,
    readonly reason: string,
  ) {
    super(`Egress запрещён для ${host}: ${reason}`);
    this.name = "OutboundHostNotAllowedError";
  }
}

/**
 * Разбирает `OUTBOUND_ALLOWLIST` (через запятую). Пустое значение — список
 * по умолчанию. Некорректный домен — ошибка конфигурации (fail closed),
 * чтобы опечатка не превращалась в «разрешено всё».
 */
export function parseOutboundAllowlist(
  raw: string | undefined,
): readonly string[] {
  const value = raw?.trim() ?? "";

  if (value === "") {
    return DEFAULT_OUTBOUND_ALLOWLIST;
  }

  const domains = new Set<string>();

  for (const entry of value.split(",")) {
    const parsed = outboundDomainSchema.safeParse(entry);

    if (!parsed.success) {
      throw new Error(
        `OUTBOUND_ALLOWLIST: некорректный домен "${entry.trim()}"`,
      );
    }

    domains.add(parsed.data);
  }

  return [...domains];
}

/** Хост URL без порта, в нижнем регистре и без завершающей точки. */
export function outboundHostFromUrl(rawUrl: string): string {
  let url: URL;

  try {
    url = new URL(rawUrl);
  } catch {
    throw new OutboundHostNotAllowedError(rawUrl, "некорректный URL");
  }

  return url.hostname.toLowerCase().replace(/\.$/, "");
}

/** Локальные/приватные адреса: dev-LLM и внутренние compose-сервисы. */
export function isPrivateOutboundHost(host: string): boolean {
  const normalized = host.toLowerCase().replace(/\.$/, "");

  if (
    normalized === "localhost" ||
    normalized === "::1" ||
    normalized === "host.docker.internal" ||
    normalized.endsWith(".local") ||
    normalized.endsWith(".internal")
  ) {
    return true;
  }

  const ipv4 = normalized.split(".");

  if (ipv4.length === 4 && ipv4.every((part) => /^\d{1,3}$/.test(part))) {
    const [a, b] = ipv4.map((part) => Number.parseInt(part, 10)) as [
      number,
      number,
      number,
      number,
    ];

    return (
      a === 10 ||
      a === 127 ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168)
    );
  }

  const lower = normalized.toLowerCase();

  if (!lower.includes(":")) {
    return false;
  }

  return (
    lower.startsWith("fc") ||
    lower.startsWith("fd") ||
    lower.startsWith("fe8") ||
    lower.startsWith("fe9") ||
    lower.startsWith("fea") ||
    lower.startsWith("feb")
  );
}

function matchesAllowlist(host: string, allowlist: readonly string[]): boolean {
  for (const entry of allowlist) {
    if (entry.startsWith("*.")) {
      const suffix = entry.slice(1);

      if (host.endsWith(suffix) && host.length > suffix.length) {
        return true;
      }

      continue;
    }

    if (host === entry) {
      return true;
    }
  }

  return false;
}

/**
 * Проверяет URL до сетевого вызова. Внешние запросы — только https и только
 * на домены из allowlist; локальные — http/https без allowlist.
 */
export function assertOutboundUrlAllowed(
  rawUrl: string,
  allowlist: readonly string[],
): void {
  let url: URL;

  try {
    url = new URL(rawUrl);
  } catch {
    throw new OutboundHostNotAllowedError(rawUrl, "некорректный URL");
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new OutboundHostNotAllowedError(url.hostname, "разрешены только http/https");
  }

  const host = url.hostname.toLowerCase().replace(/\.$/, "");

  if (isPrivateOutboundHost(host)) {
    return;
  }

  if (url.protocol !== "https:") {
    throw new OutboundHostNotAllowedError(host, "внешний трафик только по https");
  }

  if (!matchesAllowlist(host, allowlist)) {
    throw new OutboundHostNotAllowedError(host, "домена нет в OUTBOUND_ALLOWLIST");
  }
}

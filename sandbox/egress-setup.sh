#!/bin/sh
# Root-entrypoint для sandbox-контейнера с egress-allowlist (ADR 0004, п.3).
#
# Запускается только когда worker включил bridge, CapAdd NET_ADMIN/SETUID/SETGID
# и передал SANDBOX_EGRESS_ALLOWLIST (JSON-массив FQDN). Скрипт:
#   1. резолвит каждый FQDN allowlist-а (root, пока действует default-ACCEPT),
#      пишет `<ip> <fqdn>` в /etc/hosts (IPv4+IPv6) и разрешает TCP 80/443
#      только на найденные IP;
#   2. закрывает DNS-туннель: DNS 127.0.0.11:53 разрешён ТОЛЬКО root
#      (`-m owner --uid-owner 0`), не-root получает явный DROP на оригинальный
#      dport 53 (conntrack, т.к. Docker DNAT-ит resolver), потом loopback;
#   3. ставит политику INPUT/FORWARD/OUTPUT DROP (ESTABLISHED,RELATED — ACCEPT);
#   4. применяет ip6tables строго, если IPv6-стек присутствует (ошибка при
#      включённом IPv6 — fail closed, exit 1); без IPv6 — skip с логом;
#   5. сбрасывает привилегии и выполняет переданную команду от 65534:65534.
#
# Запись /etc/hosts — best-effort: при `read_only` rootfs Docker монтирует
# /etc/hosts только для чтения, поэтому ошибка логируется, а iptables-часть
# остаётся строгой (residual risk, см. sandbox/README.md).
# Пустой allowlist сюда попадать не должен: worker в этом случае принудительно
# ставит network none, поэтому скрипт завершается ошибкой (fail closed).
set -eu

ALLOWLIST_JSON="${SANDBOX_EGRESS_ALLOWLIST:-[]}"
SANDBOX_UID='65534'
SANDBOX_GID='65534'
DNS_RESOLVER_IP='127.0.0.11'
DNS_PORT='53'
HOSTS_FILE='/etc/hosts'

log() {
  echo "sandbox-egress: $*" >&2
}

fail() {
  log "$*"
  exit 1
}

# IPv6-стек присутствует, если ядро показывает хотя бы один адрес
# (/proc/net/if_inet6 непуст). Тогда ip6tables обязателен и строгий.
IPV6_AVAILABLE=0
if [ -r /proc/net/if_inet6 ] && [ -s /proc/net/if_inet6 ]; then
  IPV6_AVAILABLE=1
  log "IPv6 присутствует — применяю ip6tables строго (fail closed при ошибке)"
else
  log "IPv6 не обнаружен (/proc/net/if_inet6 отсутствует или пуст) — ip6tables пропущен"
fi

# Правило ip6tables: без IPv6 — no-op, с IPv6 — любая ошибка фатальна.
ip6_rule() {
  if [ "$IPV6_AVAILABLE" -eq 0 ]; then
    return 0
  fi

  if ! ip6tables "$@"; then
    fail "ip6tables $* завершился с ошибкой при включённом IPv6 — fail closed"
  fi
}

# Резолвит FQDN в IP-адреса. getent ставится пакетом musl-utils, bind-tools —
# fallback через nslookup (на случай урезанного образа).
resolve_hosts() {
  domain="$1"

  if command -v getent >/dev/null 2>&1; then
    getent ahosts "$domain" 2>/dev/null | awk '{print $1}' | sort -u
    return 0
  fi

  if command -v nslookup >/dev/null 2>&1; then
    nslookup "$domain" 2>/dev/null | awk '/^Address: / {print $2}' | sort -u
  fi
}

# Best-effort запись в /etc/hosts: код под 65534 не имеет DNS, поэтому
# разрешённые домены должны резолвиться через hosts. Ошибку только логируем.
HOSTS_WRITE_FAILED=0
append_host() {
  ip="$1"
  domain="$2"

  if printf '%s %s\n' "$ip" "$domain" >> "$HOSTS_FILE" 2>/dev/null; then
    return 0
  fi

  if [ "$HOSTS_WRITE_FAILED" -eq 0 ]; then
    log "не удалось записать $domain ($ip) в $HOSTS_FILE — вероятно, read-only rootfs (residual risk)"
  fi

  HOSTS_WRITE_FAILED=1
  return 0
}

if [ "$#" -eq 0 ]; then
  log "не передана команда для выполнения"
  exit 64
fi

if [ "$(id -u)" -ne 0 ]; then
  # Защита от запуска без прав: worker обязан передать root-entrypoint.
  log "entrypoint запущен не от root — настройка egress невозможна"
  exit 77
fi

if ! command -v iptables >/dev/null 2>&1; then
  log "iptables не найден в образе"
  exit 69
fi

if ! command -v jq >/dev/null 2>&1; then
  log "jq не найден в образе — не могу разобрать allowlist"
  exit 69
fi

if [ "$IPV6_AVAILABLE" -eq 1 ] && ! command -v ip6tables >/dev/null 2>&1; then
  fail "IPv6 включён, но ip6tables не найден в образе — fail closed"
fi

if ! printf '%s' "$ALLOWLIST_JSON" | jq -e 'type == "array"' >/dev/null 2>&1; then
  log "SANDBOX_EGRESS_ALLOWLIST не является JSON-массивом"
  exit 78
fi

ALLOWLIST_LENGTH="$(printf '%s' "$ALLOWLIST_JSON" | jq 'length')"

if [ "$ALLOWLIST_LENGTH" -eq 0 ]; then
  # Пустой allowlist должен был превратиться в network none на стороне worker-а.
  log "пустой allowlist при network bridge — fail closed"
  exit 78
fi

log "настраиваю egress для ${ALLOWLIST_LENGTH} домен(ов)"

# INPUT loopback можно разрешить сразу: он не участвует в DNS-фильтрации
# исходящего трафика.
iptables -A INPUT -i lo -j ACCEPT
ip6_rule -A INPUT -i lo -j ACCEPT

# Разрешаем TCP 80/443 только на IP, в которые резолвятся домены allowlist, и
# пишем эти IP в /etc/hosts. Нерезолвнутый домен не получает ни правила, ни
# hosts-записи (fail closed). Резолв идёт до установки DROP-политик: root-
# entrypoint — единственный, кому нужен DNS.
domains="$(printf '%s' "$ALLOWLIST_JSON" | jq -r '.[]')"
for domain in $domains; do
  [ -n "$domain" ] || continue

  ips="$(resolve_hosts "$domain")"

  if [ -z "$ips" ]; then
    log "домен $domain не резолвится — egress к нему запрещён"
    continue
  fi

  for ip in $ips; do
    append_host "$ip" "$domain"

    case "$ip" in
      *:*)
        ip6_rule -A OUTPUT -p tcp -d "$ip" --dport 80 -j ACCEPT
        ip6_rule -A OUTPUT -p tcp -d "$ip" --dport 443 -j ACCEPT
        ;;
      *)
        iptables -A OUTPUT -p tcp -d "$ip" --dport 80 -j ACCEPT
        iptables -A OUTPUT -p tcp -d "$ip" --dport 443 -j ACCEPT
        ;;
    esac
  done

  log "разрешён egress tcp/80,443 к $domain"
done

# DNS anti-tunneling. Порядок критичен:
#   1. ACCEPT DNS только для root (`-m owner --uid-owner 0`);
#   2. явный DROP DNS для всех остальных — на ОРИГИНАЛЬНЫЙ dport 53:
#      Docker DNAT-ит 127.0.0.11:53 на локальный порт resolver-а, поэтому
#      `--dport 53` после NAT уже не совпадает (нужен `--ctorigdstport`);
#   3. только теперь общий ACCEPT loopback — иначе `-o lo` пропустил бы DNS.
iptables -A OUTPUT -p udp -m conntrack --ctorigdst "$DNS_RESOLVER_IP" --ctorigdstport "$DNS_PORT" -m owner --uid-owner 0 -j ACCEPT
iptables -A OUTPUT -p tcp -m conntrack --ctorigdst "$DNS_RESOLVER_IP" --ctorigdstport "$DNS_PORT" -m owner --uid-owner 0 -j ACCEPT
iptables -A OUTPUT -p udp -m conntrack --ctorigdstport "$DNS_PORT" -j DROP
iptables -A OUTPUT -p tcp -m conntrack --ctorigdstport "$DNS_PORT" -j DROP
iptables -A OUTPUT -o lo -j ACCEPT

ip6_rule -A OUTPUT -p udp -m conntrack --ctorigdst ::1 --ctorigdstport "$DNS_PORT" -m owner --uid-owner 0 -j ACCEPT
ip6_rule -A OUTPUT -p tcp -m conntrack --ctorigdst ::1 --ctorigdstport "$DNS_PORT" -m owner --uid-owner 0 -j ACCEPT
ip6_rule -A OUTPUT -p udp -m conntrack --ctorigdstport "$DNS_PORT" -j DROP
ip6_rule -A OUTPUT -p tcp -m conntrack --ctorigdstport "$DNS_PORT" -j DROP
ip6_rule -A OUTPUT -o lo -j ACCEPT

# Ответы на исходящие соединения и политика deny by default.
iptables -A OUTPUT -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT
iptables -A INPUT -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT
iptables -P INPUT DROP
iptables -P FORWARD DROP
iptables -P OUTPUT DROP

ip6_rule -A OUTPUT -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT
ip6_rule -A INPUT -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT
ip6_rule -P INPUT DROP
ip6_rule -P FORWARD DROP
ip6_rule -P OUTPUT DROP

if [ "$HOSTS_WRITE_FAILED" -eq 1 ]; then
  log "часть доменов не попала в $HOSTS_FILE: код сможет обращаться к ним только по IP (residual risk)"
fi

# Не отдаём политику и код навыка в окружение исполняемого процесса.
unset SANDBOX_EGRESS_ALLOWLIST
unset SANDBOX_CODE

exec su-exec "$SANDBOX_UID:$SANDBOX_GID" "$@"

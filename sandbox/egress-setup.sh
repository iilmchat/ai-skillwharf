#!/bin/sh
# Root-entrypoint для sandbox-контейнера с egress-allowlist (ADR 0004, п.3).
#
# Запускается только когда worker включил bridge, CapAdd NET_ADMIN/SETUID/SETGID
# и передал SANDBOX_EGRESS_ALLOWLIST (JSON-массив FQDN). Скрипт:
#   1. оставляет доступ к loopback и DNS Docker (127.0.0.11:53);
#   2. резолвит каждый FQDN allowlist-а и разрешает TCP 80/443 только на
#      найденные IP;
#   3. ставит политику INPUT/FORWARD/OUTPUT DROP (ESTABLISHED,RELATED — ACCEPT);
#   4. сбрасывает привилегии и выполняет переданную команду от 65534:65534.
#
# IPv6: правила ip6tables применяются best-effort, их ошибки не фатальны
# (residual risk: на части ядер nf_tables/ip6tables недоступны, тогда IPv6
# трафик остаётся под политикой по умолчанию Docker). Пустой allowlist сюда
# попадать не должен: worker в этом случае принудительно ставит network none,
# поэтому скрипт завершается ошибкой (fail closed), если список пуст/битый.
set -eu

ALLOWLIST_JSON="${SANDBOX_EGRESS_ALLOWLIST:-[]}"
SANDBOX_UID='65534'
SANDBOX_GID='65534'

log() {
  echo "sandbox-egress: $*" >&2
}

# ip6tables может отсутствовать в образе/ядре: деградируем, но не падаем.
ip6_rule() {
  if command -v ip6tables >/dev/null 2>&1; then
    ip6tables "$@" 2>/dev/null || log "ip6tables $* завершился с ошибкой (residual risk)"
  else
    log "ip6tables недоступен — IPv6-правила не применены (residual risk)"
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

# Loopback и DNS Docker: без 127.0.0.11 не работает резолв имён.
iptables -A INPUT -i lo -j ACCEPT
iptables -A OUTPUT -o lo -j ACCEPT
iptables -A OUTPUT -p udp -d 127.0.0.11 --dport 53 -j ACCEPT
iptables -A OUTPUT -p tcp -d 127.0.0.11 --dport 53 -j ACCEPT

ip6_rule -A INPUT -i lo -j ACCEPT
ip6_rule -A OUTPUT -o lo -j ACCEPT

# Разрешаем TCP 80/443 только на IP, в которые резолвятся домены allowlist.
# Нерезолвнутый домен просто не получает правила (fail closed).
printf '%s' "$ALLOWLIST_JSON" | jq -r '.[]' | while IFS= read -r domain; do
  [ -n "$domain" ] || continue

  ips="$(resolve_hosts "$domain")"

  if [ -z "$ips" ]; then
    log "домен $domain не резолвится — egress к нему запрещён"
    continue
  fi

  for ip in $ips; do
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

# Не отдаём политику и код навыка в окружение исполняемого процесса.
unset SANDBOX_EGRESS_ALLOWLIST
unset SANDBOX_CODE

exec su-exec "$SANDBOX_UID:$SANDBOX_GID" "$@"

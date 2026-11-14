#!/usr/bin/env bash
# Pre-flight проверка staging-стенда перед передачей тестировщикам.
#
#   bash scripts/preflight-check.sh
#
# Возвращает exit 1, если хотя бы одна обязательная проверка провалилась:
# это условие для деплой-гейта и CI.
#
# Переменные:
#   API_URL        (default http://127.0.0.1:3001/api/v1)
#   GRAFANA_URL    (default http://127.0.0.1:3003)
#   EGRESS_HOST    (default https://api.telegram.org)
#   COMPOSE_FILES  (default "-f docker-compose.yml -f docker-compose.staging.yml")
set -uo pipefail

API_URL="${API_URL:-http://127.0.0.1:3001/api/v1}"
GRAFANA_URL="${GRAFANA_URL:-http://127.0.0.1:3003}"
EGRESS_HOST="${EGRESS_HOST:-https://api.telegram.org}"
COMPOSE_FILES="${COMPOSE_FILES:--f docker-compose.yml -f docker-compose.staging.yml}"

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT" || exit 1

FAILED=0
PASSED=0
SKIPPED=0

pass() { PASSED=$((PASSED + 1)); printf '  \033[32mPASS\033[0m  %s\n' "$1"; }
fail() { FAILED=$((FAILED + 1)); printf '  \033[31mFAIL\033[0m  %s\n' "$1"; }
skip() { SKIPPED=$((SKIPPED + 1)); printf '  \033[33mSKIP\033[0m  %s\n' "$1"; }

compose() {
  # shellcheck disable=SC2086
  docker compose $COMPOSE_FILES "$@"
}

container_state() { # $1 service → "status|health|exitCode", код 1 если контейнера нет
  local id
  id="$(compose ps -a -q "$1" 2>/dev/null | head -n 1)"
  [ -n "$id" ] || return 1
  docker inspect -f '{{.State.Status}}|{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}|{{.State.ExitCode}}' "$id"
}

echo "preflight: $API_URL"

# 1. API готов (проверяет БД и обязательные зависимости внутри).
health_body="$(curl -sS -m 10 -w '\n%{http_code}' "$API_URL/health/ready" 2>/dev/null || true)"
health_code="$(printf '%s' "$health_body" | tail -n 1)"
health_json="$(printf '%s' "$health_body" | sed '$d' | head -c 300)"

if [ "$health_code" = "200" ]; then
  pass "API /health/ready → 200"
else
  fail "API /health/ready → ${health_code:-нет ответа} ${health_json}"
fi

# 2. llm-worker запущен, healthy и видит Redis.
if worker_state="$(container_state llm-worker)"; then
  worker_health="$(printf '%s' "$worker_state" | cut -d'|' -f2)"
  worker_status="$(printf '%s' "$worker_state" | cut -d'|' -f1)"

  if [ "$worker_health" = "healthy" ]; then
    pass "контейнер llm-worker: healthy"
  else
    fail "контейнер llm-worker: status=${worker_status:-?} health=${worker_health:-none}"
  fi
else
  fail "контейнер llm-worker не найден (docker compose ps)"
fi

redis_ping="$(compose exec -T redis redis-cli ping 2>/dev/null | tr -d '\r' || true)"
if [ "$redis_ping" = "PONG" ]; then
  pass "redis: PONG"
else
  fail "redis не отвечает (${redis_ping:-нет ответа})"
fi

# BullMQ: воркер должен видеть очередь, поэтому спрашиваем его собственный readiness.
if compose exec -T llm-worker node -e '
  const c = new AbortController();
  const t = setTimeout(() => c.abort(), 5000);
  fetch("http://127.0.0.1:4100/v1/health/ready", { signal: c.signal })
    .then((r) => process.exit(r.ok ? 0 : 1))
    .catch(() => process.exit(1));
' >/dev/null 2>&1; then
  pass "llm-worker /v1/health/ready → ok (BullMQ + Redis доступны)"
else
  fail "llm-worker /v1/health/ready не отвечает: проверьте связь воркера с Redis"
fi

worker_errors="$(compose logs --no-color --tail 200 llm-worker 2>/dev/null | grep -cE 'ECONNREFUSED|Redis connection|MaxRetriesPerRequest' || true)"
if [ "${worker_errors:-0}" -eq 0 ]; then
  pass "в логах llm-worker нет ошибок подключения к Redis"
else
  fail "в последних 200 строках llm-worker ${worker_errors} ошибок подключения к Redis"
fi

# 3. Миграции завершились успешно.
if migrate_state="$(container_state db-migrate)"; then
  migrate_status="$(printf '%s' "$migrate_state" | cut -d'|' -f1)"
  migrate_code="$(printf '%s' "$migrate_state" | cut -d'|' -f3)"

  if [ "$migrate_status" = "exited" ] && [ "$migrate_code" = "0" ]; then
    pass "db-migrate: exited 0"
  else
    fail "db-migrate: status=${migrate_status:-?} exit=${migrate_code:-?}"
  fi
else
  fail "контейнер db-migrate не найден: миграции не запускались"
fi

# 4. Grafana — только если профиль monitoring поднят.
if grafana_state="$(container_state grafana)"; then
  grafana_code="$(curl -sS -o /dev/null -w '%{http_code}' -m 10 "$GRAFANA_URL/api/health" 2>/dev/null || true)"
  if [ "$grafana_code" = "200" ]; then
    pass "Grafana /api/health → 200"
  else
    fail "Grafana /api/health → ${grafana_code:-нет ответа}"
  fi
else
  skip "Grafana не запущена (профиль monitoring выключен)"
fi

# 5. Egress: из контейнера api должен быть выход в интернет.
if compose exec -T -e "PREFLIGHT_EGRESS_URL=$EGRESS_HOST" api node -e '
  const c = new AbortController();
  const t = setTimeout(() => c.abort(), 8000);
  fetch(process.env.PREFLIGHT_EGRESS_URL, { signal: c.signal })
    .then(() => { clearTimeout(t); process.exit(0); })
    .catch(() => process.exit(1));
' >/dev/null 2>&1; then
  pass "egress из api → $EGRESS_HOST доступен"
else
  fail "egress из api → $EGRESS_HOST недоступен (нужен выход в интернет)"
fi

echo
printf 'preflight: %d passed, %d failed, %d skipped\n' "$PASSED" "$FAILED" "$SKIPPED"

if [ "$FAILED" -gt 0 ]; then
  exit 1
fi

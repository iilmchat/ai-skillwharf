#!/usr/bin/env bash
#
# Проверка внешних коннекторов Sprint 19-23: Ozon, Wildberries, Midjourney,
# OCR (Smart Document Engine), Битрикс24 и МойСклад.
#
#   bash scripts/test-integrations.sh
#   bash scripts/test-integrations.sh --ozon --wb
#   bash scripts/test-integrations.sh --bitrix24 --moysklad
#
# Скрипт читает .env, но никогда не печатает значения ключей, webhook URL
# или тела ответов с персональными данными. Если ключи сервиса не заданы —
# проверка пропускается (SKIP). Если заданы — выполняется безопасный
# read-only HTTP-запрос; 401/403 и 5xx считаются ошибкой.
#
# Переопределяемые endpoint'ы (см. .env.example):
#   OZON_API_BASE_URL, OZON_API_TEST_PATH
#   WB_PRICING_API_BASE_URL, WB_API_TEST_PATH
#   MIDJOURNEY_BASE_URL, MIDJOURNEY_TEST_PATH, MIDJOURNEY_TEST_METHOD
#   OCR_API_URL, OCR_API_KEY, OCR_API_AUTH_HEADER, OCR_API_AUTH_PREFIX
#   BITRIX24_WEBHOOK_URL, MOYSKLAD_TOKEN, MOYSKLAD_BASE_URL
set -euo pipefail

cd "$(dirname "$0")/.."

if [[ -f .env ]]; then
  set -a
  # shellcheck disable=SC1091
  source .env
  set +a
fi

OZON_API_BASE_URL="${OZON_API_BASE_URL:-https://api-seller.ozon.ru}"
OZON_API_TEST_PATH="${OZON_API_TEST_PATH:-/v1/product/import/prices}"
WB_PRICING_API_BASE_URL="${WB_PRICING_API_BASE_URL:-https://discounts-prices-api.wildberries.ru}"
WB_API_TEST_PATH="${WB_API_TEST_PATH:-/ping}"
MIDJOURNEY_BASE_URL="${MIDJOURNEY_BASE_URL:-https://api.ttapi.io}"
MIDJOURNEY_TEST_PATH="${MIDJOURNEY_TEST_PATH:-/midjourney/v1/fetch?jobId=test}"
MIDJOURNEY_TEST_METHOD="${MIDJOURNEY_TEST_METHOD:-GET}"
OCR_API_URL="${OCR_API_URL:-}"
OCR_API_KEY="${OCR_API_KEY:-}"
OCR_API_AUTH_HEADER="${OCR_API_AUTH_HEADER:-Authorization}"
OCR_API_AUTH_PREFIX="${OCR_API_AUTH_PREFIX:-Bearer}"
BITRIX24_WEBHOOK_URL="${BITRIX24_WEBHOOK_URL:-}"
MOYSKLAD_TOKEN="${MOYSKLAD_TOKEN:-}"
MOYSKLAD_BASE_URL="${MOYSKLAD_BASE_URL:-https://api.moysklad.ru/api/remap/1.2}"
CURL_TIMEOUT="${INTEGRATIONS_CURL_TIMEOUT:-15}"

CHECK_OZON=1
CHECK_WB=1
CHECK_MIDJOURNEY=1
CHECK_OCR=1
CHECK_BITRIX24=1
CHECK_MOYSKLAD=1

usage() {
  cat <<'EOF'
Использование: bash scripts/test-integrations.sh [опции]

  --ozon          проверить только Ozon
  --wb            проверить только Wildberries
  --midjourney    проверить только Midjourney
  --ocr           проверить только OCR (Smart Document Engine)
  --bitrix24      проверить только Битрикс24 (Inbound Webhook)
  --moysklad      проверить только МойСклад (JSON API 1.2)
  -h, --help      показать справку

Без опций проверяются все сервисы, у которых заданы ключи.
EOF
}

if [[ $# -gt 0 ]]; then
  CHECK_OZON=0
  CHECK_WB=0
  CHECK_MIDJOURNEY=0
  CHECK_OCR=0
  CHECK_BITRIX24=0
  CHECK_MOYSKLAD=0

  for arg in "$@"; do
    case "$arg" in
      --ozon) CHECK_OZON=1 ;;
      --wb) CHECK_WB=1 ;;
      --midjourney) CHECK_MIDJOURNEY=1 ;;
      --ocr) CHECK_OCR=1 ;;
      --bitrix24) CHECK_BITRIX24=1 ;;
      --moysklad) CHECK_MOYSKLAD=1 ;;
      -h|--help) usage; exit 0 ;;
      *) echo "FAIL: неизвестная опция $arg" >&2; usage; exit 2 ;;
    esac
  done
fi

if ! command -v curl >/dev/null 2>&1; then
  echo "FAIL: curl не найден" >&2
  exit 1
fi

TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT

FAILED=0
PASSED=0
SKIPPED=0

url_join() {
  local base="${1%/}"
  local path="$2"

  if [[ -z "$path" ]]; then
    printf '%s' "$base"
  elif [[ "$path" == /* ]]; then
    printf '%s%s' "$base" "$path"
  else
    printf '%s/%s' "$base" "$path"
  fi
}

skip() {
  local name="$1"
  local missing="$2"
  echo "WARN $name: ключ не задан ($missing) — проверка пропущена"
  SKIPPED=$((SKIPPED + 1))
}

ok() {
  local name="$1"
  local detail="$2"
  echo "OK   $name: $detail"
  PASSED=$((PASSED + 1))
}

fail() {
  local name="$1"
  local detail="$2"
  echo "FAIL $name: $detail" >&2
  FAILED=$((FAILED + 1))
}

body_excerpt() {
  local file="$1"
  # Не печатаем тело целиком: в нём может быть echo ключа/токена.
  tr '\n' ' ' <"$file" | cut -c1-240
}

# Проверяет, что JSON-ответ содержит поле result. Секреты и тело не печатаем.
json_has_result() {
  local file="$1"

  if command -v jq >/dev/null 2>&1; then
    jq -e 'has("result")' "$file" >/dev/null 2>&1
    return
  fi

  if command -v python3 >/dev/null 2>&1; then
    python3 -c 'import json, sys; data = json.load(open(sys.argv[1], encoding="utf-8")); raise SystemExit(0 if "result" in data else 1)' "$file" >/dev/null 2>&1
    return
  fi

  grep -Eq '"result"[[:space:]]*:' "$file"
}

check_ozon() {
  if [[ $CHECK_OZON -eq 0 ]]; then
    return
  fi

  if [[ -z "${OZON_CLIENT_ID:-}" && -z "${OZON_API_KEY:-}" ]]; then
    skip "Ozon" "OZON_CLIENT_ID/OZON_API_KEY"
    return
  fi

  if [[ -z "${OZON_CLIENT_ID:-}" || -z "${OZON_API_KEY:-}" ]]; then
    fail "Ozon" "задан только один из OZON_CLIENT_ID/OZON_API_KEY"
    return
  fi

  local url body code
  url="$(url_join "$OZON_API_BASE_URL" "$OZON_API_TEST_PATH")"
  body="$TMP_DIR/ozon.json"

  code="$(curl -sS --max-time "$CURL_TIMEOUT" -o "$body" -w '%{http_code}' \
    -X POST "$url" \
    -H 'Content-Type: application/json' \
    -H "Client-Id: ${OZON_CLIENT_ID}" \
    -H "Api-Key: ${OZON_API_KEY}" \
    -d '{"prices":[]}' || true)"

  case "$code" in
    2??) ok "Ozon" "HTTP $code, endpoint ${OZON_API_TEST_PATH}" ;;
    400|422)
      ok "Ozon" "HTTP $code: ключ принят, тестовое тело отклонено без изменения цен"
      ;;
    401|403) fail "Ozon" "HTTP $code - ключи/права отклонены API" ;;
    000) fail "Ozon" "сеть/TLS недоступны (${OZON_API_BASE_URL})" ;;
    *) fail "Ozon" "HTTP $code: $(body_excerpt "$body")" ;;
  esac
}

check_wb() {
  if [[ $CHECK_WB -eq 0 ]]; then
    return
  fi

  if [[ -z "${WB_API_TOKEN:-}" ]]; then
    skip "Wildberries" "WB_API_TOKEN"
    return
  fi

  local url body code
  url="$(url_join "$WB_PRICING_API_BASE_URL" "$WB_API_TEST_PATH")"
  body="$TMP_DIR/wb.json"

  code="$(curl -sS --max-time "$CURL_TIMEOUT" -o "$body" -w '%{http_code}' \
    -X GET "$url" \
    -H "Authorization: ${WB_API_TOKEN}" || true)"

  case "$code" in
    2??) ok "Wildberries" "HTTP $code, endpoint ${WB_API_TEST_PATH}" ;;
    401|403) fail "Wildberries" "HTTP $code - токен/права отклонены API" ;;
    000) fail "Wildberries" "сеть/TLS недоступны (${WB_PRICING_API_BASE_URL})" ;;
    *) fail "Wildberries" "HTTP $code: $(body_excerpt "$body")" ;;
  esac
}

check_midjourney() {
  if [[ $CHECK_MIDJOURNEY -eq 0 ]]; then
    return
  fi

  if [[ -z "${MIDJOURNEY_API_KEY:-}" ]]; then
    skip "Midjourney" "MIDJOURNEY_API_KEY"
    return
  fi

  local url body code method
  method="$(printf '%s' "$MIDJOURNEY_TEST_METHOD" | tr '[:lower:]' '[:upper:]')"
  url="$(url_join "$MIDJOURNEY_BASE_URL" "$MIDJOURNEY_TEST_PATH")"
  body="$TMP_DIR/midjourney.json"

  if [[ "$method" == "POST" || "$method" == "PUT" || "$method" == "PATCH" ]]; then
    code="$(curl -sS --max-time "$CURL_TIMEOUT" -o "$body" -w '%{http_code}' \
      -X "$method" "$url" \
      -H 'Content-Type: application/json' \
      -H "Authorization: Bearer ${MIDJOURNEY_API_KEY}" \
      -d '{"prompt":"SkillWharf integration probe"}' || true)"
  else
    code="$(curl -sS --max-time "$CURL_TIMEOUT" -o "$body" -w '%{http_code}' \
      -X "$method" "$url" \
      -H "Authorization: Bearer ${MIDJOURNEY_API_KEY}" || true)"
  fi

  case "$code" in
    2??) ok "Midjourney" "HTTP $code, endpoint ${MIDJOURNEY_TEST_PATH}" ;;
    401|403) fail "Midjourney" "HTTP $code — API-ключ TTAPI отклонён" ;;
    404)
      # TTAPI на тестовый jobId отдаёт 404 — это валидный ответ, не 401.
      ok "Midjourney" "HTTP 404 на тестовый jobId — ключ принят, job не найден"
      ;;
    000) fail "Midjourney" "сеть/TLS недоступны (${MIDJOURNEY_BASE_URL})" ;;
    *) fail "Midjourney" "HTTP $code: $(body_excerpt "$body")" ;;
  esac
}

check_ocr() {
  if [[ $CHECK_OCR -eq 0 ]]; then
    return
  fi

  if [[ -z "${OCR_API_URL:-}" ]]; then
    skip "OCR" "OCR_API_URL (fallback: tesseract в sandbox-образе)"
    return
  fi

  local body code auth_value
  body="$TMP_DIR/ocr.json"

  if [[ -z "${OCR_API_KEY:-}" ]]; then
    # On-prem SDE может быть без авторизации; облачный API ответит 401.
    code="$(curl -sS --max-time "$CURL_TIMEOUT" -o "$body" -w '%{http_code}' \
      -X POST "$OCR_API_URL" \
      -H 'Content-Type: application/json' \
      -d '{"content":"","mimeType":"image/png","language":"ru"}' || true)"
  else
    if [[ -n "${OCR_API_AUTH_PREFIX:-}" ]]; then
      auth_value="${OCR_API_AUTH_PREFIX} ${OCR_API_KEY}"
    else
      auth_value="${OCR_API_KEY}"
    fi

    code="$(curl -sS --max-time "$CURL_TIMEOUT" -o "$body" -w '%{http_code}' \
      -X POST "$OCR_API_URL" \
      -H 'Content-Type: application/json' \
      -H "${OCR_API_AUTH_HEADER}: ${auth_value}" \
      -d '{"content":"","mimeType":"image/png","language":"ru"}' || true)"
  fi

  case "$code" in
    2??) ok "OCR" "HTTP $code, endpoint ${OCR_API_URL}" ;;
    400|422)
      ok "OCR" "HTTP $code: ключ принят, тестовое тело отклонено"
      ;;
    401|403) fail "OCR" "HTTP $code - ключ/права отклонены API" ;;
    000) fail "OCR" "сеть/TLS недоступны (${OCR_API_URL})" ;;
    *) fail "OCR" "HTTP $code: $(body_excerpt "$body")" ;;
  esac
}

check_bitrix24() {
  if [[ $CHECK_BITRIX24 -eq 0 ]]; then
    return
  fi

  if [[ -z "${BITRIX24_WEBHOOK_URL:-}" ]]; then
    skip "Битрикс24" "BITRIX24_WEBHOOK_URL"
    return
  fi

  local url body code
  # profile.json — безопасный read-only метод; сам webhook URL не печатаем.
  url="${BITRIX24_WEBHOOK_URL%/}/profile.json"
  body="$TMP_DIR/bitrix24.json"

  code="$(curl -sS --max-time "$CURL_TIMEOUT" -o "$body" -w '%{http_code}' \
    -X POST "$url" \
    -H 'Content-Type: application/json' \
    -d '{}' 2>/dev/null || true)"

  case "$code" in
    2??)
      if json_has_result "$body"; then
        ok "Битрикс24" "HTTP $code, profile.json, result получен"
      else
        fail "Битрикс24" "HTTP $code, но JSON без поля result"
      fi
      ;;
    401|403) fail "Битрикс24" "HTTP $code - вебхук/права отклонены API" ;;
    000) fail "Битрикс24" "сеть/TLS недоступны" ;;
    *) fail "Битрикс24" "HTTP $code" ;;
  esac
}

check_moysklad() {
  if [[ $CHECK_MOYSKLAD -eq 0 ]]; then
    return
  fi

  if [[ -z "${MOYSKLAD_TOKEN:-}" ]]; then
    skip "МойСклад" "MOYSKLAD_TOKEN"
    return
  fi

  local url body code
  url="$(url_join "$MOYSKLAD_BASE_URL" "/entity/organization?limit=1")"
  body="$TMP_DIR/moysklad.json"

  code="$(curl -sS --max-time "$CURL_TIMEOUT" -o "$body" -w '%{http_code}' \
    -X GET "$url" \
    -H "Authorization: Bearer ${MOYSKLAD_TOKEN}" 2>/dev/null || true)"

  case "$code" in
    2??) ok "МойСклад" "HTTP $code, organization?limit=1" ;;
    401|403) fail "МойСклад" "HTTP $code - токен/права отклонены API" ;;
    000) fail "МойСклад" "сеть/TLS недоступны" ;;
    *) fail "МойСклад" "HTTP $code" ;;
  esac
}

echo "== Проверка интеграций Sprint 19-23 =="
check_ozon
check_wb
check_midjourney
check_ocr
check_bitrix24
check_moysklad

echo "== Итог: OK=$PASSED FAIL=$FAILED SKIP=$SKIPPED =="

if [[ $FAILED -gt 0 ]]; then
  exit 1
fi

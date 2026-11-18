#!/usr/bin/env bash
#
# Restore-drill: скачивает последний offsite-дамп из S3, проверяет его
# SHA-256 (по .sha256-сайдкару), при необходимости расшифровывает и
# восстанавливает во временном контейнере postgres:17-alpine с сетью
# --network none. Контейнер не имеет отношения к боевому PostgreSQL и
# гарантированно удаляется по trap EXIT.
#
# Проверяются таблицы User и LedgerEntry, а также append-only-триггеры
# prevent_update_ledger / prevent_delete_ledger. Возвращает 0 только при успехе.
#
#   bash scripts/restore-drill.sh
#   BACKUP_ENCRYPTION_KEY=<passphrase> bash scripts/restore-drill.sh
#
# Требует настроенный offsite (BACKUP_S3_BUCKET и остальные BACKUP_S3_*),
# Docker и rclone в PATH. Локальные дампы не используются: проверяется
# именно offsite-копия. Образ по умолчанию — postgres:17-alpine; если дамп
# содержит расширение vector, задайте RESTORE_DRILL_IMAGE=pgvector/pgvector:pg17.
set -euo pipefail

cd "$(dirname "$0")/.."
script_dir="$(cd "$(dirname "$0")" && pwd)"

if [[ -f .env ]]; then
  set -a
  # shellcheck disable=SC1091
  source .env
  set +a
fi

# shellcheck source=scripts/lib/backup-s3.sh
source "${script_dir}/lib/backup-s3.sh"

: "${POSTGRES_DB:?POSTGRES_DB не задан (проверьте .env)}"

DRILL_CONTAINER=""
TMP_DIR=""

log() {
  printf '%s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*"
}

cleanup() {
  local status=$?
  trap - EXIT
  if [[ -n "$DRILL_CONTAINER" ]]; then
    docker rm -f "$DRILL_CONTAINER" >/dev/null 2>&1 || true
    log "Временный контейнер ${DRILL_CONTAINER} удалён."
  fi
  if [[ -n "$TMP_DIR" ]]; then
    rm -rf -- "$TMP_DIR"
  fi
  exit "$status"
}
trap cleanup EXIT

if ! backup_s3_enabled; then
  echo "ОШИБКА: offsite не настроен (BACKUP_S3_BUCKET пуст). Restore-drill невозможен." >&2
  exit 1
fi

backup_s3_validate
backup_s3_require_rclone
backup_s3_configure_rclone

if ! command -v sha256sum >/dev/null 2>&1; then
  echo "ОШИБКА: sha256sum не найден в PATH (нужен для проверки дампа)." >&2
  exit 1
fi

remote="$(backup_s3_remote)"

log "Ищу последний offsite-дамп ${POSTGRES_DB}-*.dump[.enc]."
if ! keys="$(rclone lsf "$remote" \
  --include "${POSTGRES_DB}-*.dump" \
  --include "${POSTGRES_DB}-*.dump.enc" 2>/dev/null)"; then
  echo "ОШИБКА: не удалось получить список объектов из ${BACKUP_S3_BUCKET}." >&2
  echo "Проверьте BACKUP_S3_* и доступность хранилища." >&2
  exit 1
fi

latest="$(printf '%s\n' "$keys" | sed '/^$/d' | sort | tail -n 1)"

if [[ -z "$latest" ]]; then
  echo "ОШИБКА: в ${BACKUP_S3_BUCKET} нет дампов ${POSTGRES_DB}-*.dump[.enc]." >&2
  exit 1
fi

TMP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/skillwharf-restore-drill.XXXXXX")"
dump_file="${TMP_DIR}/${latest}"

log "Скачиваю ${latest}."
if ! rclone copyto "${remote}${latest}" "$dump_file" --stats-one-line; then
  echo "ОШИБКА: не удалось скачать ${latest} из S3." >&2
  exit 1
fi

if [[ ! -s "$dump_file" ]]; then
  echo "ОШИБКА: скачанный дамп пуст." >&2
  exit 1
fi

# Проверка SHA-256 по сайдкару, который пишет upload-backup.sh. Для старых
# бэкапов без сайдкара — предупреждение и продолжение (обратная совместимость).
if rclone copyto "${remote}${latest}.sha256" "${TMP_DIR}/sha.txt" >/dev/null 2>&1; then
  expected_sha="$(awk '{print $1}' "${TMP_DIR}/sha.txt")"
  actual_sha="$(sha256sum "$dump_file" | awk '{print $1}')"
  if [[ ! "$expected_sha" =~ ^[0-9a-f]{64}$ ]]; then
    echo "ОШИБКА: некорректный SHA-256 в сайдкаре ${latest}.sha256." >&2
    exit 1
  fi
  if [[ "$actual_sha" != "$expected_sha" ]]; then
    echo "ОШИБКА: SHA-256 дампа не совпал (s3=${expected_sha}, local=${actual_sha})." >&2
    exit 1
  fi
  log "SHA-256 дампа подтверждён: ${actual_sha}"
else
  log "ПРЕДУПРЕЖДЕНИЕ: сайдкар ${latest}.sha256 не найден — проверка суммы пропущена."
fi

restore_file="$dump_file"
if [[ "$latest" == *.enc ]]; then
  if [[ -z "${BACKUP_ENCRYPTION_KEY:-}" ]]; then
    echo "ОШИБКА: дамп зашифрован, но BACKUP_ENCRYPTION_KEY не задан." >&2
    exit 1
  fi
  if ! command -v openssl >/dev/null 2>&1; then
    echo "ОШИБКА: openssl не найден в PATH (нужен для расшифровки дампа)." >&2
    exit 1
  fi
  export BACKUP_ENCRYPTION_KEY
  restore_file="${TMP_DIR}/restored.dump"
  log "Расшифровываю дамп (AES-256-CBC/PBKDF2, iter=100000)."
  if ! openssl enc -d -aes-256-cbc -pbkdf2 -iter 100000 \
    -in "$dump_file" -out "$restore_file" \
    -pass env:BACKUP_ENCRYPTION_KEY; then
    echo "ОШИБКА: не удалось расшифровать дамп (неверный ключ или повреждённые данные)." >&2
    exit 1
  fi
  if [[ ! -s "$restore_file" ]]; then
    echo "ОШИБКА: расшифрованный дамп пуст." >&2
    exit 1
  fi
fi

# Временный инстанс PostgreSQL: свои фиксированные креды, ни одного порта
# на хост и --network none. Боевой postgres не задействован никак.
DRILL_IMAGE="${RESTORE_DRILL_IMAGE:-postgres:17-alpine}"
DRILL_CONTAINER="skillwharf-restore-drill-$$-$(date -u +%s)"
log "Поднимаю изолированный контейнер ${DRILL_CONTAINER} (${DRILL_IMAGE}, --network none)."
if ! docker run --rm -d --name "$DRILL_CONTAINER" --network none \
  -e POSTGRES_USER=drill \
  -e POSTGRES_PASSWORD=drill \
  -e POSTGRES_DB=drill \
  "$DRILL_IMAGE" >/dev/null; then
  echo "ОШИБКА: не удалось запустить временный контейнер PostgreSQL." >&2
  exit 1
fi

ready=0
for _ in $(seq 1 60); do
  if docker exec "$DRILL_CONTAINER" pg_isready -U drill -d drill >/dev/null 2>&1; then
    ready=1
    break
  fi
  sleep 1
done
if ((ready == 0)); then
  echo "ОШИБКА: временный PostgreSQL не стал доступен за 60 с." >&2
  exit 1
fi

log "Восстанавливаю дамп во временный PostgreSQL."
if ! docker exec -i "$DRILL_CONTAINER" pg_restore \
  --username drill \
  --dbname drill \
  --no-owner \
  --no-privileges \
  --exit-on-error < "$restore_file"; then
  echo "ОШИБКА: pg_restore завершился с ошибкой." >&2
  exit 1
fi

drill_psql() {
  docker exec -i "$DRILL_CONTAINER" psql \
    --username drill \
    --dbname drill \
    -v ON_ERROR_STOP=1 \
    -At \
    -c "$1"
}

log "Проверяю User, LedgerEntry и append-only-триггеры."
if ! user_count="$(drill_psql 'SELECT count(*) FROM "User";')"; then
  echo "ОШИБКА: sanity-запрос к таблице User не выполнился." >&2
  exit 1
fi

if ! ledger_count="$(drill_psql 'SELECT count(*) FROM "LedgerEntry";')"; then
  echo "ОШИБКА: sanity-запрос к таблице LedgerEntry не выполнился." >&2
  exit 1
fi

trigger_query="SELECT count(*) FROM pg_trigger
  WHERE tgrelid = '\"LedgerEntry\"'::regclass
    AND NOT tgisinternal
    AND tgname IN ('prevent_update_ledger', 'prevent_delete_ledger');"
if ! trigger_count="$(drill_psql "$trigger_query")"; then
  echo "ОШИБКА: не удалось проверить append-only-триггеры LedgerEntry." >&2
  exit 1
fi

user_count="$(printf '%s' "$user_count" | tr -d '[:space:]')"
ledger_count="$(printf '%s' "$ledger_count" | tr -d '[:space:]')"
trigger_count="$(printf '%s' "$trigger_count" | tr -d '[:space:]')"

if ! [[ "$user_count" =~ ^[0-9]+$ && "$ledger_count" =~ ^[0-9]+$ && "$trigger_count" =~ ^[0-9]+$ ]]; then
  echo "ОШИБКА: sanity-запросы вернули нечисловой результат (User=${user_count}, LedgerEntry=${ledger_count}, triggers=${trigger_count})." >&2
  exit 1
fi

if [[ "$trigger_count" != "2" ]]; then
  echo "ОШИБКА: ожидались 2 append-only-триггера на LedgerEntry, найдено ${trigger_count}." >&2
  exit 1
fi

log "OK: User=${user_count}, LedgerEntry=${ledger_count}, append-only triggers=${trigger_count} (за ${SECONDS} с)."
log "Restore-drill успешно завершён для ${latest}."

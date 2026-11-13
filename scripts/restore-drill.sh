#!/usr/bin/env bash
#
# Restore-drill: скачивает последний offsite-дамп из S3, восстанавливает его
# во временную БД на том же PostgreSQL, проверяет наличие таблиц User и
# LedgerEntry и удаляет временную БД. Возвращает 0 только при успехе.
#
#   bash scripts/restore-drill.sh
#
# Требует настроенный offsite (BACKUP_S3_BUCKET и остальные BACKUP_S3_*),
# запущенный контейнер postgres и rclone в PATH. Локальные дампы не
# используются: проверяется именно offsite-копия.
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

: "${POSTGRES_USER:?POSTGRES_USER не задан (проверьте .env)}"
: "${POSTGRES_DB:?POSTGRES_DB не задан (проверьте .env)}"

DRILL_DB=""
TMP_DIR=""

log() {
  printf '%s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*"
}

drop_drill_db() {
  if [[ -z "$DRILL_DB" ]]; then
    return
  fi

  if docker compose exec -T postgres psql \
    --username "$POSTGRES_USER" \
    --dbname postgres \
    -v ON_ERROR_STOP=1 \
    -c "DROP DATABASE IF EXISTS \"${DRILL_DB}\" WITH (FORCE)" >/dev/null 2>&1; then
    log "Временная БД ${DRILL_DB} удалена."
  else
    log "ПРЕДУПРЕЖДЕНИЕ: не удалось удалить временную БД ${DRILL_DB}; удалите её вручную."
  fi
}

cleanup() {
  local status=$?
  trap - EXIT
  drop_drill_db
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

remote="$(backup_s3_remote)"

log "Ищу последний offsite-дамп ${POSTGRES_DB}-*.dump."
if ! keys="$(rclone lsf "$remote" --include "${POSTGRES_DB}-*.dump" 2>/dev/null)"; then
  echo "ОШИБКА: не удалось получить список объектов из ${BACKUP_S3_BUCKET}." >&2
  echo "Проверьте BACKUP_S3_* и доступность хранилища." >&2
  exit 1
fi

latest="$(printf '%s\n' "$keys" | sed '/^$/d' | sort | tail -n 1)"

if [[ -z "$latest" ]]; then
  echo "ОШИБКА: в ${BACKUP_S3_BUCKET} нет дампов ${POSTGRES_DB}-*.dump." >&2
  exit 1
fi

TMP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/skillwharf-restore-drill.XXXXXX")"
dump_file="${TMP_DIR}/latest.dump"

log "Скачиваю ${latest}."
if ! rclone copyto "${remote}${latest}" "$dump_file" --stats-one-line; then
  echo "ОШИБКА: не удалось скачать ${latest} из S3." >&2
  exit 1
fi

if [[ ! -s "$dump_file" ]]; then
  echo "ОШИБКА: скачанный дамп пуст." >&2
  exit 1
fi

DRILL_DB="drill_$(date -u +%Y%m%d_%H%M%S)_$$"

if ! [[ "$DRILL_DB" =~ ^[a-z0-9_]+$ ]]; then
  echo "ОШИБКА: недопустимое имя временной БД: ${DRILL_DB}" >&2
  exit 1
fi

log "Создаю временную БД ${DRILL_DB}."
if ! docker compose exec -T postgres psql \
  --username "$POSTGRES_USER" \
  --dbname postgres \
  -v ON_ERROR_STOP=1 \
  -c "CREATE DATABASE \"${DRILL_DB}\"" >/dev/null; then
  echo "ОШИБКА: не удалось создать временную БД ${DRILL_DB}." >&2
  exit 1
fi

log "Восстанавливаю дамп во временную БД."
if ! docker compose exec -T postgres pg_restore \
  --username "$POSTGRES_USER" \
  --dbname "$DRILL_DB" \
  --no-owner \
  --no-privileges \
  --exit-on-error < "$dump_file"; then
  echo "ОШИБКА: pg_restore завершился с ошибкой. Временная БД будет удалена." >&2
  exit 1
fi

query_count() {
  docker compose exec -T postgres psql \
    --username "$POSTGRES_USER" \
    --dbname "$DRILL_DB" \
    -v ON_ERROR_STOP=1 \
    -At \
    -c "$1"
}

log "Проверяю наличие User и LedgerEntry."
if ! user_count="$(query_count 'SELECT count(*) FROM "User";')"; then
  echo "ОШИБКА: sanity-запрос к таблице User не выполнился." >&2
  exit 1
fi

if ! ledger_count="$(query_count 'SELECT count(*) FROM "LedgerEntry";')"; then
  echo "ОШИБКА: sanity-запрос к таблице LedgerEntry не выполнился." >&2
  exit 1
fi

user_count="$(printf '%s' "$user_count" | tr -d '[:space:]')"
ledger_count="$(printf '%s' "$ledger_count" | tr -d '[:space:]')"

if ! [[ "$user_count" =~ ^[0-9]+$ && "$ledger_count" =~ ^[0-9]+$ ]]; then
  echo "ОШИБКА: sanity-запросы вернули нечисловой результат (User=${user_count}, LedgerEntry=${ledger_count})." >&2
  exit 1
fi

log "OK: User=${user_count}, LedgerEntry=${ledger_count}."
log "Restore-drill успешно завершён для ${latest}."

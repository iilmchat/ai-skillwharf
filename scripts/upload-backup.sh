#!/usr/bin/env bash
#
# Выгрузка готового локального дампа в S3-совместимое хранилище.
# Обычно вызывается из backup-db.sh, но можно запускать вручную:
#
#   bash scripts/upload-backup.sh --file backups/skillwharf_db-20261113-020000.dump
#   bash scripts/upload-backup.sh --file ... --keep-days 30
#
# Без BACKUP_S3_BUCKET скрипт ничего не делает и возвращает 0: offsite —
# опциональная функция, локальные бэкапы должны работать как раньше.
# При ошибке S3/rclone локальный файл не удаляется; возвращается код 1.
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

BACKUP_FILE=""
KEEP_DAYS_ARG=""

usage() {
  cat <<'EOF'
Использование: bash scripts/upload-backup.sh --file PATH [опции]

  --file PATH      локальный .dump (обязательно)
  --keep-days N    retention offsite; по умолчанию BACKUP_S3_KEEP_DAYS
                   или BACKUP_KEEP_DAYS (14)
  -h, --help       показать эту справку

Offsite выключен, если BACKUP_S3_BUCKET пуст. Остальные параметры:
BACKUP_S3_ENDPOINT, BACKUP_S3_REGION, BACKUP_S3_ACCESS_KEY,
BACKUP_S3_SECRET_KEY, BACKUP_S3_PREFIX.
EOF
}

while (($# > 0)); do
  case "$1" in
    --file)
      BACKUP_FILE="${2:?--file требует значение}"
      shift 2
      ;;
    --file=*)
      BACKUP_FILE="${1#*=}"
      shift
      ;;
    --keep-days)
      KEEP_DAYS_ARG="${2:?--keep-days требует значение}"
      shift 2
      ;;
    --keep-days=*)
      KEEP_DAYS_ARG="${1#*=}"
      shift
      ;;
    -h | --help)
      usage
      exit 0
      ;;
    *)
      echo "ОШИБКА: неизвестный аргумент: $1" >&2
      usage >&2
      exit 2
      ;;
  esac
done

if [[ -z "$BACKUP_FILE" ]]; then
  echo "ОШИБКА: не указан --file с локальным дампом." >&2
  usage >&2
  exit 2
fi

: "${POSTGRES_DB:?POSTGRES_DB не задан (проверьте .env)}"

if [[ ! -f "$BACKUP_FILE" ]]; then
  echo "ОШИБКА: файл дампа не найден: ${BACKUP_FILE}" >&2
  exit 1
fi

if [[ ! -s "$BACKUP_FILE" ]]; then
  echo "ОШИБКА: файл дампа пуст: ${BACKUP_FILE}" >&2
  exit 1
fi

if ! backup_s3_enabled; then
  echo "Offsite выключен: BACKUP_S3_BUCKET не задан. Локальный дамп остаётся на месте."
  exit 0
fi

backup_s3_validate
backup_s3_require_rclone
backup_s3_configure_rclone

REMOTE_BASE="$(backup_s3_remote)"
REMOTE_FILE="${REMOTE_BASE}$(basename "$BACKUP_FILE")"
S3_KEEP_DAYS="${BACKUP_S3_KEEP_DAYS:-${KEEP_DAYS_ARG:-${BACKUP_KEEP_DAYS:-14}}}"

echo "Выгружаю ${BACKUP_FILE} → s3://${BACKUP_S3_BUCKET}/$(backup_s3_prefix)$(basename "$BACKUP_FILE")"

if ! rclone copyto "$BACKUP_FILE" "$REMOTE_FILE" --stats-one-line; then
  echo "ОШИБКА: rclone не смог выгрузить дамп в S3." >&2
  echo "Локальный дамп сохранён: ${BACKUP_FILE}" >&2
  exit 1
fi

if ! rclone lsf "$REMOTE_FILE" >/dev/null 2>&1; then
  echo "ОШИБКА: дамп выгружен, но объект не найден в S3." >&2
  echo "Локальный дамп сохранён: ${BACKUP_FILE}" >&2
  exit 1
fi

echo "Offsite-копия готова: s3://${BACKUP_S3_BUCKET}/$(backup_s3_prefix)$(basename "$BACKUP_FILE")"

if ! backup_s3_prune "$S3_KEEP_DAYS"; then
  echo "ОШИБКА: offsite-копия создана, но retention не применился." >&2
  exit 1
fi

#!/usr/bin/env bash
#
# Бэкап PostgreSQL через pg_dump. Запуск из любого места:
#
#   bash scripts/backup-db.sh
#   bash scripts/backup-db.sh --keep-days 30 --keep-min 10
#   bash scripts/backup-db.sh --skip-prune
#
# Переменные берутся из .env в корне репозитория (POSTGRES_USER, POSTGRES_DB).
# Каталог можно переопределить: BACKUP_DIR=/mnt/backups bash scripts/backup-db.sh
#
# Проверка места: перед дампом скрипт требует BACKUP_MIN_FREE_MB (по умолчанию
# 512) свободных мегабайт в BACKUP_DIR. Дамп пишется во временный .partial,
# проверяется на непустоту и только затем переименовывается. После успешного
# бэкапа запускается ротация (scripts/rotate-backups.sh).
#
# Формат custom (-Fc) восстанавливается через pg_restore, см.
# docs/operations/Deployment-Runbook.md.
set -euo pipefail

cd "$(dirname "$0")/.."
script_dir="$(cd "$(dirname "$0")" && pwd)"

if [[ -f .env ]]; then
  set -a
  # shellcheck disable=SC1091
  source .env
  set +a
fi

: "${POSTGRES_USER:?POSTGRES_USER не задан (проверьте .env)}"
: "${POSTGRES_DB:?POSTGRES_DB не задан (проверьте .env)}"

BACKUP_DIR="${BACKUP_DIR:-backups}"
KEEP_DAYS="${BACKUP_KEEP_DAYS:-14}"
KEEP_MIN="${BACKUP_KEEP_MIN:-7}"
MIN_FREE_MB="${BACKUP_MIN_FREE_MB:-512}"
SKIP_PRUNE=0

usage() {
  cat <<'EOF'
Использование: bash scripts/backup-db.sh [опции]

  --keep-days N   хранить бэкапы N дней (BACKUP_KEEP_DAYS, по умолчанию 14)
  --keep-min N    оставлять минимум N последних дампов (BACKUP_KEEP_MIN, 7)
  --skip-prune    не запускать ротацию после успешного бэкапа
  -h, --help      показать эту справку

Переменные: POSTGRES_USER, POSTGRES_DB, BACKUP_DIR, BACKUP_MIN_FREE_MB.
Dry-run ротации: bash scripts/rotate-backups.sh --dry-run
EOF
}

while (($# > 0)); do
  case "$1" in
    --keep-days)
      KEEP_DAYS="${2:?--keep-days требует значение}"
      shift 2
      ;;
    --keep-days=*)
      KEEP_DAYS="${1#*=}"
      shift
      ;;
    --keep-min)
      KEEP_MIN="${2:?--keep-min требует значение}"
      shift 2
      ;;
    --keep-min=*)
      KEEP_MIN="${1#*=}"
      shift
      ;;
    --skip-prune)
      SKIP_PRUNE=1
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

if ! [[ "$KEEP_DAYS" =~ ^[0-9]+$ && "$KEEP_MIN" =~ ^[0-9]+$ ]]; then
  echo "ОШИБКА: --keep-days и --keep-min должны быть целыми числами >= 0" >&2
  exit 2
fi
if ! [[ "$MIN_FREE_MB" =~ ^[0-9]+$ ]]; then
  echo "ОШИБКА: BACKUP_MIN_FREE_MB должен быть целым числом >= 0" >&2
  exit 2
fi

mkdir -p "$BACKUP_DIR"

# df -Pk печатает доступные килобайты во второй строке (POSIX-формат).
available_kb="$(df -Pk "$BACKUP_DIR" 2>/dev/null | awk 'NR == 2 { print $4 }')"
if ! [[ "$available_kb" =~ ^[0-9]+$ ]]; then
  echo "ОШИБКА: не удалось определить свободное место в ${BACKUP_DIR} (df)." >&2
  echo "Бэкап не создан." >&2
  exit 1
fi

required_kb=$((MIN_FREE_MB * 1024))
if ((available_kb < required_kb)); then
  available_mb=$((available_kb / 1024))
  echo "ОШИБКА: недостаточно свободного места в ${BACKUP_DIR}: доступно ${available_mb} МБ, требуется минимум ${MIN_FREE_MB} МБ." >&2
  echo "Бэкап не создан. Освободите место или уменьшите BACKUP_MIN_FREE_MB осознанно." >&2
  exit 1
fi

timestamp="$(date +%Y%m%d-%H%M%S)"
target="$BACKUP_DIR/${POSTGRES_DB}-${timestamp}.dump"
partial="${target}.partial"

cleanup() {
  rm -f -- "$partial"
}
trap cleanup EXIT

echo "Создаю бэкап ${POSTGRES_DB} → ${target} (свободно $((available_kb / 1024)) МБ)"

if ! docker compose exec -T postgres pg_dump \
  --username "$POSTGRES_USER" \
  --dbname "$POSTGRES_DB" \
  --format=custom \
  > "$partial"; then
  echo "ОШИБКА: pg_dump завершился с ошибкой. Бэкап не создан, временный файл удалён." >&2
  echo "Проверьте, что контейнер postgres запущен и доступен: docker compose ps postgres" >&2
  exit 1
fi

if [[ ! -s "$partial" ]]; then
  echo "ОШИБКА: pg_dump создал пустой файл. Бэкап не создан, временный файл удалён." >&2
  exit 1
fi

mv -f -- "$partial" "$target"
trap - EXIT

echo "Готово: ${target} ($(du -h "$target" | cut -f1))"

if ((SKIP_PRUNE == 0)); then
  bash "${script_dir}/rotate-backups.sh" \
    --db "$POSTGRES_DB" \
    --backup-dir "$BACKUP_DIR" \
    --keep-days "$KEEP_DAYS" \
    --keep-min "$KEEP_MIN"
fi

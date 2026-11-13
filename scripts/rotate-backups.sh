#!/usr/bin/env bash
#
# Ротация дампов PostgreSQL. Удаляет только устаревшие бэкапы и всегда
# оставляет не меньше BACKUP_KEEP_MIN последних успешных дампов.
#
#   bash scripts/rotate-backups.sh
#   bash scripts/rotate-backups.sh --keep-days 30 --keep-min 10
#   bash scripts/rotate-backups.sh --dry-run   # или -DryRun
#
# Переменные окружения (можно задать в .env):
#   POSTGRES_DB        — имя БД, часть имени файла (обязательно);
#   BACKUP_DIR         — каталог с дампами (по умолчанию backups);
#   BACKUP_KEEP_DAYS   — хранить последние N дней (по умолчанию 14);
#   BACKUP_KEEP_MIN    — минимум последних дампов (по умолчанию 7).
#
# Успешным считается файл "${POSTGRES_DB}-YYYYMMDD-HHMMSS.dump": backup-db.sh
# пишет во временный .partial и переименовывает только после проверки pg_dump.
set -euo pipefail

cd "$(dirname "$0")/.."

if [[ -f .env ]]; then
  set -a
  # shellcheck disable=SC1091
  source .env
  set +a
fi

: "${POSTGRES_DB:?POSTGRES_DB не задан (проверьте .env)}"

BACKUP_DIR="${BACKUP_DIR:-backups}"
KEEP_DAYS="${BACKUP_KEEP_DAYS:-14}"
KEEP_MIN="${BACKUP_KEEP_MIN:-7}"
DRY_RUN=0

usage() {
  cat <<'EOF'
Использование: bash scripts/rotate-backups.sh [опции]

  --keep-days N   хранить бэкапы N дней (BACKUP_KEEP_DAYS, по умолчанию 14)
  --keep-min N    оставлять минимум N последних дампов (BACKUP_KEEP_MIN, 7)
  --backup-dir P  каталог с дампами (BACKUP_DIR, по умолчанию backups)
  --db NAME       имя БД для шаблона файлов (POSTGRES_DB)
  --dry-run       показать удаления без изменения файлов (алиас -DryRun)
  -h, --help      показать эту справку
EOF
}

log() {
  printf '%s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*"
}

while (($# > 0)); do
  case "$1" in
    --dry-run | -DryRun | --dryrun | -n)
      DRY_RUN=1
      shift
      ;;
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
    --backup-dir)
      BACKUP_DIR="${2:?--backup-dir требует значение}"
      shift 2
      ;;
    --backup-dir=*)
      BACKUP_DIR="${1#*=}"
      shift
      ;;
    --db)
      POSTGRES_DB="${2:?--db требует значение}"
      shift 2
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

if ! [[ "$KEEP_DAYS" =~ ^[0-9]+$ ]]; then
  echo "ОШИБКА: BACKUP_KEEP_DAYS/--keep-days должен быть целым числом >= 0" >&2
  exit 2
fi
if ! [[ "$KEEP_MIN" =~ ^[0-9]+$ ]]; then
  echo "ОШИБКА: BACKUP_KEEP_MIN/--keep-min должен быть целым числом >= 0" >&2
  exit 2
fi

if [[ ! -d "$BACKUP_DIR" ]]; then
  log "Каталог ${BACKUP_DIR} не существует — удалять нечего."
  exit 0
fi

# Имена содержат YYYYMMDD-HHMMSS, поэтому обычная сортировка даёт порядок
# от новых к старым. В выборку попадают только дампы текущей БД.
backups=()
while IFS= read -r backup_file; do
  backups+=("$backup_file")
done < <(
  find "$BACKUP_DIR" -maxdepth 1 -type f -name "${POSTGRES_DB}-*.dump" -print | sort -r
)

total="${#backups[@]}"
log "Найдено дампов ${POSTGRES_DB}: ${total}; keep-days=${KEEP_DAYS}, keep-min=${KEEP_MIN}, dry-run=${DRY_RUN}."

if ((total <= KEEP_MIN)); then
  log "Удалять нечего: количество дампов не превышает минимум ${KEEP_MIN}."
  exit 0
fi

file_mtime() {
  if stat -c %Y "$1" >/dev/null 2>&1; then
    stat -c %Y "$1"
  else
    stat -f %m "$1"
  fi
}

now="$(date +%s)"
deleted=0
kept=0

for ((i = 0; i < total; i++)); do
  file="${backups[$i]}"

  if ((i < KEEP_MIN)); then
    kept=$((kept + 1))
    continue
  fi

  mtime="$(file_mtime "$file")"
  age_days=$(((now - mtime) / 86400))

  if ((age_days <= KEEP_DAYS)); then
    kept=$((kept + 1))
    continue
  fi

  size="$(du -h "$file" | cut -f1)"
  if ((DRY_RUN == 1)); then
    log "DRY-RUN: будет удалён ${file} (возраст ${age_days} дн., ${size})."
  else
    rm -f -- "$file"
    log "Удалён ${file} (возраст ${age_days} дн., ${size})."
  fi
  deleted=$((deleted + 1))
done

if ((DRY_RUN == 1)); then
  log "DRY-RUN завершён: к удалению ${deleted}, останется ${kept}."
else
  log "Ротация завершена: удалено ${deleted}, оставлено ${kept}."
fi

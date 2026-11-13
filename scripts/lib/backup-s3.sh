#!/usr/bin/env bash
#
# Общие функции для offsite-бэкапов в S3-совместимое хранилище через rclone.
# Подключается из backup-db.sh/upload-backup.sh/restore-drill.sh.
#
# Переменные (см. .env.example):
#   BACKUP_S3_ENDPOINT     — endpoint MinIO/другого S3 (пусто — AWS S3);
#   BACKUP_S3_BUCKET       — bucket; пусто — offsite выключен;
#   BACKUP_S3_REGION       — регион (по умолчанию us-east-1);
#   BACKUP_S3_ACCESS_KEY   — access key (можно не задавать при IAM-роли);
#   BACKUP_S3_SECRET_KEY   — secret key;
#   BACKUP_S3_PREFIX       — префикс ключей внутри bucket (по умолчанию пусто);
#   BACKUP_S3_KEEP_DAYS    — retention offsite (по умолчанию BACKUP_KEEP_DAYS).
#
# Секреты передаются rclone через переменные окружения, а не аргументы
# командной строки, чтобы не попадать в список процессов.

backup_s3_enabled() {
  [[ -n "${BACKUP_S3_BUCKET:-}" ]]
}

backup_s3_prefix() {
  local prefix="${BACKUP_S3_PREFIX:-}"
  prefix="${prefix#/}"

  if [[ -n "$prefix" && "$prefix" != */ ]]; then
    prefix="${prefix}/"
  fi

  printf '%s' "$prefix"
}

# Возвращает remote:path с завершающим слэшем (префикс может быть пустым).
backup_s3_remote() {
  printf 'skillwharf_backup:%s/%s' "${BACKUP_S3_BUCKET}" "$(backup_s3_prefix)"
}

backup_s3_validate() {
  local errors=0

  if [[ -z "${BACKUP_S3_BUCKET:-}" ]]; then
    echo "ОШИБКА: BACKUP_S3_BUCKET не задан, offsite-выгрузка невозможна." >&2
    errors=$((errors + 1))
  fi

  if [[ -n "${BACKUP_S3_ACCESS_KEY:-}" && -z "${BACKUP_S3_SECRET_KEY:-}" ]]; then
    echo "ОШИБКА: задан BACKUP_S3_ACCESS_KEY без BACKUP_S3_SECRET_KEY." >&2
    errors=$((errors + 1))
  fi

  if [[ -z "${BACKUP_S3_ACCESS_KEY:-}" && -n "${BACKUP_S3_SECRET_KEY:-}" ]]; then
    echo "ОШИБКА: задан BACKUP_S3_SECRET_KEY без BACKUP_S3_ACCESS_KEY." >&2
    errors=$((errors + 1))
  fi

  ((errors == 0))
}

backup_s3_require_rclone() {
  if ! command -v rclone >/dev/null 2>&1; then
    echo "ОШИБКА: rclone не найден в PATH, offsite-выгрузка невозможна." >&2
    echo "Установите rclone (https://rclone.org/install/) или очистите BACKUP_S3_BUCKET." >&2
    return 1
  fi
}

backup_s3_configure_rclone() {
  export RCLONE_CONFIG_SKILLWHARF_BACKUP_TYPE=s3

  # Быстрый и предсказуемый отказ: cron не должен висеть минутами, если S3
  # недоступен. 60s — таймаут неактивности, а не всего большого дампа.
  export RCLONE_CONTIMEOUT=10s
  export RCLONE_TIMEOUT=60s
  export RCLONE_RETRIES=2
  export RCLONE_LOW_LEVEL_RETRIES=2

  if [[ -n "${BACKUP_S3_ENDPOINT:-}" ]]; then
    # MinIO и другие S3-совместимые хранилища требуют path-style запросов.
    export RCLONE_CONFIG_SKILLWHARF_BACKUP_PROVIDER=Other
    export RCLONE_CONFIG_SKILLWHARF_BACKUP_ENDPOINT="${BACKUP_S3_ENDPOINT}"
    export RCLONE_CONFIG_SKILLWHARF_BACKUP_FORCE_PATH_STYLE=true
  else
    export RCLONE_CONFIG_SKILLWHARF_BACKUP_PROVIDER=AWS
  fi

  export RCLONE_CONFIG_SKILLWHARF_BACKUP_REGION="${BACKUP_S3_REGION:-us-east-1}"

  if [[ -n "${BACKUP_S3_ACCESS_KEY:-}" ]]; then
    export RCLONE_CONFIG_SKILLWHARF_BACKUP_ACCESS_KEY_ID="${BACKUP_S3_ACCESS_KEY}"
    export RCLONE_CONFIG_SKILLWHARF_BACKUP_SECRET_ACCESS_KEY="${BACKUP_S3_SECRET_KEY}"
  fi
}

# Удаляет только ${POSTGRES_DB}-*.dump старше keep_days. Свежий дамп,
# загруженный только что, не попадает под условие.
backup_s3_prune() {
  local keep_days="${1:-${BACKUP_S3_KEEP_DAYS:-${BACKUP_KEEP_DAYS:-14}}}"
  local remote
  local output

  if ! [[ "$keep_days" =~ ^[0-9]+$ ]]; then
    echo "ОШИБКА: BACKUP_S3_KEEP_DAYS должен быть целым числом >= 0." >&2
    return 1
  fi

  if ((keep_days == 0)); then
    echo "Retention offsite отключён (BACKUP_S3_KEEP_DAYS=0)."
    return 0
  fi

  remote="$(backup_s3_remote)"

  echo "Ротация offsite: удаляю ${POSTGRES_DB}-*.dump старше ${keep_days} дн."
  if ! output="$(rclone delete "$remote" \
    --include "${POSTGRES_DB}-*.dump" \
    --min-age "${keep_days}d" \
    --stats-one-line 2>&1)"; then
    echo "ОШИБКА: не удалось применить retention в ${BACKUP_S3_BUCKET}." >&2
    printf '%s\n' "$output" >&2
    return 1
  fi

  if [[ -n "$output" ]]; then
    printf '%s\n' "$output"
  fi
}

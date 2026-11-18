#!/usr/bin/env bash
#
# Выгрузка готового локального дампа в S3-совместимое хранилище.
# Обычно вызывается из backup-db.sh, но можно запускать вручную:
#
#   bash scripts/upload-backup.sh --file backups/skillwharf_db-20261113-020000.dump
#   bash scripts/upload-backup.sh --file ... --keep-days 30
#   BACKUP_ENCRYPTION_KEY=<passphrase> bash scripts/upload-backup.sh --file ...
#
# Без BACKUP_S3_BUCKET скрипт ничего не делает и возвращает 0: offsite —
# опциональная функция, локальные бэкапы должны работать как раньше.
# При ошибке S3/rclone локальный файл не удаляется; возвращается код 1.
#
# если задан BACKUP_ENCRYPTION_KEY, дамп шифруется на клиенте
# (openssl enc -aes-256-cbc -pbkdf2 -iter 100000) и в S3 уходит .enc-файл.
# Для загруженного объекта всегда пишется .sha256-сайдкар и после выгрузки
# объект скачивается повторно для сверки контрольной суммы. SSE-S3 (AES256)
# включается для всех объектов по умолчанию.
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
TMP_DIR=""
ENCRYPT_KEY_USED=0

usage() {
  cat <<'EOF'
Использование: bash scripts/upload-backup.sh --file PATH [опции]

  --file PATH      локальный .dump (обязательно)
  --keep-days N    retention offsite; по умолчанию BACKUP_S3_KEEP_DAYS
                   или BACKUP_KEEP_DAYS (14)
  -h, --help       показать эту справку

Offsite выключен, если BACKUP_S3_BUCKET пуст. Остальные параметры:
BACKUP_S3_ENDPOINT, BACKUP_S3_REGION, BACKUP_S3_ACCESS_KEY,
BACKUP_S3_SECRET_KEY, BACKUP_S3_PREFIX. Клиентское шифрование включается
переменной BACKUP_ENCRYPTION_KEY (передаётся openssl через env, не в argv).
EOF
}

cleanup() {
  local status=$?
  trap - EXIT
  if [[ -n "$TMP_DIR" ]]; then
    rm -rf -- "$TMP_DIR"
  fi
  exit "$status"
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

if ! command -v sha256sum >/dev/null 2>&1; then
  echo "ОШИБКА: sha256sum не найден в PATH (нужен для проверки offsite-копии)." >&2
  exit 1
fi

TMP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/skillwharf-upload.XXXXXX")"
trap cleanup EXIT

# Локальный файл, который уйдёт в S3: либо исходный дамп, либо его
# зашифрованная копия. Шифруем во временном каталоге, чтобы в backups/ не
# оставалось .enc-файлов, не попадающих под локальную ротацию.
UPLOAD_FILE="$BACKUP_FILE"
if [[ -n "${BACKUP_ENCRYPTION_KEY:-}" ]]; then
  if ! command -v openssl >/dev/null 2>&1; then
    echo "ОШИБКА: openssl не найден в PATH (нужен при BACKUP_ENCRYPTION_KEY)." >&2
    exit 1
  fi
  # openssl -pass env: читает ключ из окружения, а не из argv.
  export BACKUP_ENCRYPTION_KEY
  ENCRYPT_KEY_USED=1
  UPLOAD_FILE="${TMP_DIR}/$(basename "$BACKUP_FILE").enc"
  if ! openssl enc -aes-256-cbc -pbkdf2 -iter 100000 -salt \
    -in "$BACKUP_FILE" -out "$UPLOAD_FILE" \
    -pass env:BACKUP_ENCRYPTION_KEY; then
    echo "ОШИБКА: не удалось зашифровать дамп (openssl enc)." >&2
    exit 1
  fi
  if [[ ! -s "$UPLOAD_FILE" ]]; then
    echo "ОШИБКА: зашифрованный дамп пуст." >&2
    exit 1
  fi
fi

REMOTE_BASE="$(backup_s3_remote)"
REMOTE_NAME="$(basename "$UPLOAD_FILE")"
REMOTE_FILE="${REMOTE_BASE}${REMOTE_NAME}"
REMOTE_SHA_FILE="${REMOTE_FILE}.sha256"
S3_KEEP_DAYS="${BACKUP_S3_KEEP_DAYS:-${KEEP_DAYS_ARG:-${BACKUP_KEEP_DAYS:-14}}}"

LOCAL_SHA="$(sha256sum "$UPLOAD_FILE" | awk '{print $1}')"
printf '%s  %s\n' "$LOCAL_SHA" "$REMOTE_NAME" > "${TMP_DIR}/checksum.sha256"

if ((ENCRYPT_KEY_USED)); then
  echo "Выгружаю (зашифровано AES-256-CBC/PBKDF2) ${BACKUP_FILE} → s3://${BACKUP_S3_BUCKET}/$(backup_s3_prefix)${REMOTE_NAME}"
else
  echo "Выгружаю ${BACKUP_FILE} → s3://${BACKUP_S3_BUCKET}/$(backup_s3_prefix)${REMOTE_NAME}"
fi

if ! rclone copyto "$UPLOAD_FILE" "$REMOTE_FILE" \
  --s3-server-side-encryption AES256 --stats-one-line; then
  echo "ОШИБКА: rclone не смог выгрузить дамп в S3." >&2
  echo "Локальный дамп сохранён: ${BACKUP_FILE}" >&2
  exit 1
fi

if ! rclone copyto "${TMP_DIR}/checksum.sha256" "$REMOTE_SHA_FILE" \
  --s3-server-side-encryption AES256 --stats-one-line; then
  echo "ОШИБКА: дамп выгружен, но не удалось загрузить .sha256-сайдкар." >&2
  echo "Локальный дамп сохранён: ${BACKUP_FILE}" >&2
  exit 1
fi

if ! rclone lsf "$REMOTE_FILE" >/dev/null 2>&1; then
  echo "ОШИБКА: дамп выгружен, но объект не найден в S3." >&2
  echo "Локальный дамп сохранён: ${BACKUP_FILE}" >&2
  exit 1
fi

# Проверка контрольной суммы после загрузки: скачиваем объект обратно и
# сравниваем SHA-256 с посчитанным до выгрузки (защита от повреждений при
# передаче и тихого искажения на стороне хранилища).
if ! rclone copyto "$REMOTE_FILE" "${TMP_DIR}/verify.bin" --stats-one-line; then
  echo "ОШИБКА: не удалось скачать объект из S3 для проверки SHA-256." >&2
  exit 1
fi
REMOTE_SHA="$(sha256sum "${TMP_DIR}/verify.bin" | awk '{print $1}')"
if [[ "$REMOTE_SHA" != "$LOCAL_SHA" ]]; then
  echo "ОШИБКА: SHA-256 не совпал (local=${LOCAL_SHA}, s3=${REMOTE_SHA})." >&2
  exit 1
fi

echo "SHA-256 подтверждён: ${LOCAL_SHA}"
echo "Offsite-копия готова: s3://${BACKUP_S3_BUCKET}/$(backup_s3_prefix)${REMOTE_NAME}"

if ! backup_s3_prune "$S3_KEEP_DAYS"; then
  echo "ОШИБКА: offsite-копия создана, но retention не применился." >&2
  exit 1
fi

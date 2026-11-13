#!/usr/bin/env bash
#
# Бэкап PostgreSQL через pg_dump. Запуск из любого места:
#
#   bash scripts/backup-db.sh
#
# Переменные берутся из .env в корне репозитория (POSTGRES_USER, POSTGRES_DB).
# Каталог можно переопределить: BACKUP_DIR=/mnt/backups bash scripts/backup-db.sh
#
# Формат custom (-Fc) восстанавливается через pg_restore, см.
# docs/operations/Deployment-Runbook.md.
set -euo pipefail

cd "$(dirname "$0")/.."

if [[ -f .env ]]; then
  set -a
  # shellcheck disable=SC1091
  source .env
  set +a
fi

: "${POSTGRES_USER:?POSTGRES_USER не задан (проверьте .env)}"
: "${POSTGRES_DB:?POSTGRES_DB не задан (проверьте .env)}"

BACKUP_DIR="${BACKUP_DIR:-backups}"
mkdir -p "$BACKUP_DIR"

timestamp="$(date +%Y%m%d-%H%M%S)"
target="$BACKUP_DIR/${POSTGRES_DB}-${timestamp}.dump"

echo "Создаю бэкап ${POSTGRES_DB} → ${target}"

docker compose exec -T postgres pg_dump \
  --username "$POSTGRES_USER" \
  --dbname "$POSTGRES_DB" \
  --format=custom \
  > "$target"

echo "Готово: ${target} ($(du -h "$target" | cut -f1))"

#!/bin/sh
set -e

# Миграции выполняет one-shot сервис db-migrate (KI-007): API-реплики не
# должны запускать prisma migrate deploy параллельно. Compose стартует API
# только после service_completed_successfully для db-migrate.
echo "Starting the application..."
exec node dist/main

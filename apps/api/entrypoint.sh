#!/bin/sh
set -e

# В runtime-образе нет npm/npx (см. KI-001), поэтому используем Prisma CLI,
# установленный в /usr/local/bin/prisma на стадии tools.
echo "Running database migrations..."
prisma migrate deploy

echo "Starting the application..."
exec node dist/main

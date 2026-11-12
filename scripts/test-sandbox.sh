# Проверка изоляции sandbox-контейнера.
# MVP: обычный Docker-контейнер как заглушка, production — Firecracker/gVisor.
set -euo pipefail

COMPOSE_FILE="${COMPOSE_FILE:-docker-compose.sandbox.yml}"
SERVICE="sandbox-runner"

cd "$(dirname "$0")/.."

if ! docker info >/dev/null 2>&1; then
  echo "FAIL: Docker недоступен (docker info завершился с ошибкой)" >&2
  exit 1
fi

run() {
  docker compose -f "$COMPOSE_FILE" run --rm -T "$SERVICE" "$@"
}

echo "==> 1. Запуск в песочнице"
run sh -c "echo 'Hello from Sandbox'"

echo "==> 2. Корневая файловая система только для чтения"
if run sh -c 'touch /sandbox-write-probe' >/dev/null 2>&1; then
  echo "FAIL: запись в / разрешена, read_only не работает" >&2
  exit 1
fi
echo "OK: запись в / запрещена"

echo "==> 3. tmpfs /tmp доступен для записи"
run sh -c 'echo ok > /tmp/sandbox-write-probe && cat /tmp/sandbox-write-probe'

echo "OK: все проверки песочницы пройдены"

# Проверка изоляции sandbox-контейнера.
# MVP: обычный Docker-контейнер как заглушка, production — Firecracker/gVisor.
set -euo pipefail

COMPOSE_FILE="${COMPOSE_FILE:-docker-compose.sandbox.yml}"
SERVICE="sandbox-runner"
SANDBOX_IMAGE="${SANDBOX_IMAGE:-skillwharf-sandbox:latest}"

cd "$(dirname "$0")/.."

# Git Bash/MSYS автоматически переписывает POSIX-пути в аргументах docker.exe
# (например, seccomp=/c/... → C:/...). Для Linux-контейнеров это ломает
# аргументы, поэтому отключаем конвертацию и приводим путь профиля сами.
if [ -n "${MSYSTEM:-}" ]; then
  export MSYS2_ARG_CONV_EXCL='*'
  export MSYS_NO_PATHCONV=1
fi

SECCOMP_PROFILE="${SECCOMP_PROFILE:-$PWD/sandbox/seccomp-profile.json}"

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

SERVER_ARCH="$(docker version --format '{{.Server.Arch}}' 2>/dev/null || true)"

if [ ! -f "$SECCOMP_PROFILE" ]; then
  echo "FAIL: seccomp-профиль не найден: $SECCOMP_PROFILE" >&2
  exit 1
fi

# Docker CLI читает seccomp-профиль как файл. В Git Bash путь нужно привести
# к Windows-виду, иначе MSYS-преобразование ломает аргумент.
if command -v cygpath >/dev/null 2>&1; then
  SECCOMP_PROFILE_ARG="$(cygpath -w "$SECCOMP_PROFILE")"
else
  SECCOMP_PROFILE_ARG="$SECCOMP_PROFILE"
fi

if [ "$SERVER_ARCH" != "amd64" ] && [ "$SERVER_ARCH" != "x86_64" ]; then
  echo "SKIP: seccomp-профиль рассчитан на linux/amd64 (Docker: ${SERVER_ARCH:-unknown})"
else
  if ! docker image inspect "$SANDBOX_IMAGE" >/dev/null 2>&1; then
    docker compose -f "$COMPOSE_FILE" build "$SERVICE"
  fi

  # Повторяет HostConfig из apps/sandbox-worker/src/index.ts.
  sandbox_run() {
    docker run --rm --network none --read-only --cap-drop ALL \
      --user 65534:65534 --tmpfs /tmp \
      --memory 128m --cpus 0.5 \
      --security-opt no-new-privileges:true \
      --security-opt "seccomp=$SECCOMP_PROFILE_ARG" \
      "$SANDBOX_IMAGE" "$@"
  }

  echo "==> 4. bash, curl, jq, gh и Python работают под seccomp-профилем"
  sandbox_run sh -c 'set -e; bash --version >/dev/null; curl --version >/dev/null; jq --version >/dev/null; gh --version >/dev/null; python3 -c "import json, ssl, subprocess, threading; print(json.dumps([1, 2, 3]))"; echo "OK: утилиты песочницы работают"'

  echo "==> 5. Опасные сисколлы заблокированы"
  sandbox_run python3 -c '
import ctypes
import errno
import sys

libc = ctypes.CDLL(None, use_errno=True)
checks = {
    "ptrace": 101,
    "mount": 165,
    "unshare": 272,
    "keyctl": 250,
    "perf_event_open": 298,
    "personality": 135,
    "bpf": 321,
    "userfaultfd": 323,
}
failed = []
for name, number in checks.items():
    ctypes.set_errno(0)
    result = libc.syscall(number, 0, 0, 0, 0, 0, 0)
    error = ctypes.get_errno()
    if result != -1 or error != errno.EPERM:
        failed.append(f"{name}: rc={result} errno={error}")
if failed:
    print("FAIL: " + ", ".join(failed))
    sys.exit(1)
print("OK: ptrace/mount/unshare/keyctl/perf_event_open/personality/bpf/userfaultfd запрещены")
'

  echo "==> 5a. clone не создаёт новые namespace"
  sandbox_run python3 -c '
import ctypes
import errno
import os
import sys

libc = ctypes.CDLL(None, use_errno=True)
libc.clone.restype = ctypes.c_int
libc.clone.argtypes = [
    ctypes.c_void_p,
    ctypes.c_void_p,
    ctypes.c_int,
    ctypes.c_void_p,
]

CALLBACK = ctypes.CFUNCTYPE(ctypes.c_int, ctypes.c_void_p)
stack = ctypes.create_string_buffer(1024 * 1024)
top = ctypes.c_void_p(ctypes.addressof(stack) + len(stack))


def child(_argument):
    os._exit(0)


callback = CALLBACK(child)
ctypes.set_errno(0)
result = libc.clone(
    ctypes.cast(callback, ctypes.c_void_p),
    top,
    0x10000000,
    None,
)
error = ctypes.get_errno()
if result != -1 or error != errno.EPERM:
    print(f"FAIL: clone(CLONE_NEWUSER) rc={result} errno={error}")
    sys.exit(1)
print("OK: clone с CLONE_NEWUSER запрещён")
'

  echo "==> 6. Node.js (V8) и worker_threads работают под seccomp-профилем"
  docker run --rm --network none --read-only --cap-drop ALL \
    --user 65534:65534 --tmpfs /tmp \
    --security-opt no-new-privileges:true \
    --security-opt "seccomp=$SECCOMP_PROFILE_ARG" \
    node:24-alpine node -e 'const { Worker } = require("node:worker_threads"); const worker = new Worker("require(\"node:worker_threads\").parentPort.postMessage(\"worker-ok\")", { eval: true }); worker.on("message", (message) => console.log("OK: node-ok", [1, 2, 3].map((value) => value * 2).join(","), message)); worker.on("error", (error) => { console.error(error); process.exit(1); });'
fi

echo "==> 7. Egress-фильтр (iptables + su-exec + entrypoint) собран в образе"
run sh -c 'command -v iptables >/dev/null && command -v su-exec >/dev/null && test -x /usr/local/bin/sandbox-egress-setup.sh && echo "OK: iptables, su-exec и sandbox-egress-setup.sh на месте"'

echo "OK: все проверки песочницы пройдены"

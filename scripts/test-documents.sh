#!/usr/bin/env bash
#
# Smoke-тест документов в sandbox-образе: tesseract (OCR-fallback),
# poppler-utils (PDF) и pandoc (DOCX).
#
#   bash scripts/test-documents.sh
#
# Образ собирается из sandbox/Dockerfile (тот же, что использует
# sandbox-worker). Контейнер запускается с ограничениями навыка: read-only
# rootfs, uid 65534, tmpfs /tmp, без сети, 128 МБ памяти и seccomp-профиль
# (если доступен).
set -euo pipefail

SANDBOX_IMAGE="${SANDBOX_IMAGE:-skillwharf-sandbox:latest}"
FIXTURE="scripts/fixtures/document-smoke.py"

cd "$(dirname "$0")/.."

# Git Bash/MSYS: не конвертировать POSIX-пути в Windows-пути для docker.exe.
if [ -n "${MSYSTEM:-}" ]; then
  export MSYS2_ARG_CONV_EXCL='*'
  export MSYS_NO_PATHCONV=1
fi

if ! docker info >/dev/null 2>&1; then
  echo "FAIL: Docker недоступен (docker info завершился с ошибкой)" >&2
  exit 1
fi

if [ ! -f "$FIXTURE" ]; then
  echo "FAIL: нет fixture $FIXTURE" >&2
  exit 1
fi

echo "==> Сборка sandbox-образа ($SANDBOX_IMAGE)"
docker build -t "$SANDBOX_IMAGE" ./sandbox >/dev/null

SECCOMP_PROFILE="${SECCOMP_PROFILE:-$PWD/sandbox/seccomp-profile.json}"
SECCOMP_ARGS=()

SERVER_ARCH="$(docker version --format '{{.Server.Arch}}' 2>/dev/null || true)"

if [ -f "$SECCOMP_PROFILE" ] && { [ "$SERVER_ARCH" = "amd64" ] || [ "$SERVER_ARCH" = "x86_64" ]; }; then
  if command -v cygpath >/dev/null 2>&1; then
    SECCOMP_PROFILE="$(cygpath -w "$SECCOMP_PROFILE")"
  fi

  SECCOMP_ARGS=(--security-opt "seccomp=$SECCOMP_PROFILE")
else
  echo "WARN: seccomp-профиль не применяется (архитектура ${SERVER_ARCH:-unknown})"
fi

FIXTURE_PATH="$PWD/$FIXTURE"

if command -v cygpath >/dev/null 2>&1; then
  FIXTURE_PATH="$(cygpath -w "$FIXTURE_PATH")"
fi

echo "==> Документы под ограничениями sandbox"
docker run --rm \
  --network none \
  --read-only \
  --cap-drop ALL \
  --user 65534:65534 \
  --tmpfs /tmp \
  --memory 128m \
  --cpus 0.5 \
  --security-opt no-new-privileges:true \
  "${SECCOMP_ARGS[@]}" \
  -v "$FIXTURE_PATH:/fixtures/document-smoke.py:ro" \
  "$SANDBOX_IMAGE" \
  python3 /fixtures/document-smoke.py

echo "OK: проверка документов завершена"

#!/usr/bin/env bash
# Записывает секрет в env-файл стенда, не показывая значение на экране.
#
#   ./scripts/set-env-secret.sh YOOKASSA_SECRET_KEY /opt/skillwharf/.env
#
# Значение читается скрытым вводом (в терминале) или из stdin (в скриптах).
# Файл остаётся 600, старое значение заменяется, дубликаты не появляются.
set -uo pipefail

KEY="${1:-}"
TARGET="${2:-/opt/skillwharf/.env}"

if [ -z "$KEY" ]; then
  echo "usage: $0 <ENV_KEY> [env-file]" >&2
  exit 1
fi

if [ ! -f "$TARGET" ]; then
  echo "нет файла $TARGET" >&2
  exit 1
fi

if [ -t 0 ]; then
  printf 'Введите %s (ввод скрыт): ' "$KEY" >&2
  IFS= read -rs VALUE
  printf '\n' >&2
else
  IFS= read -r VALUE
fi

if [ -z "${VALUE:-}" ]; then
  echo "пустое значение — ничего не записано" >&2
  exit 1
fi

TMP="$(mktemp)"
trap 'rm -f "$TMP"' EXIT

grep -v "^${KEY}=" "$TARGET" > "$TMP" || true
printf '%s=%s\n' "$KEY" "$VALUE" >> "$TMP"
install -m 600 "$TMP" "$TARGET"

echo "записано: $KEY (длина ${#VALUE}) -> $TARGET"

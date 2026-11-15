#!/usr/bin/env bash
# Заливает статическую сборку лендинга на хостинг витрины по FTP.
#
#   bash scripts/upload-landing.sh [каталог]
#
# По умолчанию берётся apps/web/dist-landing (собирается `pnpm build:landing`).
# Параметры подключения — в .ftp-hosting.env в корне репозитория (в git не
# попадает): FTP_HOST, FTP_USER, FTP_PASSWORD, FTP_PATH, FTP_PORT, FTP_TLS.
#
# Зависимости: bash, curl. Работает и из WSL, и из Git Bash.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENVF="${REPO_ROOT}/.ftp-hosting.env"
SRC="${1:-${REPO_ROOT}/apps/web/dist-landing}"

if [ ! -f "$ENVF" ]; then
  echo "нет ${ENVF} — заполните параметры FTP по образцу .ftp-hosting.env" >&2
  exit 1
fi

if [ ! -f "${SRC}/index.html" ]; then
  echo "нет ${SRC}/index.html — сначала соберите витрину:" >&2
  echo "  VITE_APP_URL=https://app.skillwharf.ru pnpm --filter web build:landing" >&2
  exit 1
fi

# shellcheck disable=SC1090
set -a; . <(sed -e 's/\r$//' "$ENVF"); set +a

: "${FTP_HOST:?задайте FTP_HOST}"
: "${FTP_USER:?задайте FTP_USER}"
: "${FTP_PASSWORD:?задайте FTP_PASSWORD}"

OPTS=(--silent --show-error --max-time 60 --ftp-create-dirs
      --user "${FTP_USER}:${FTP_PASSWORD}")
[ "${FTP_TLS:-no}" = "yes" ] && OPTS+=(--ssl-reqd)
BASE="ftp://${FTP_HOST}:${FTP_PORT:-21}${FTP_PATH:-/www/skillwharf.ru}"

echo "витрина: ${SRC}"
echo "куда:    ${FTP_HOST}${FTP_PATH:-/www/skillwharf.ru}"
echo

(cd "$SRC" && find . -type f | sed 's|^\./||') | while read -r rel; do
  curl "${OPTS[@]}" -T "${SRC}/${rel}" "${BASE}/${rel}" >/dev/null
  printf '  ok  %s\n' "$rel"
done

echo
echo "готово. Проверка: curl -sS https://skillwharf.ru/ | head -5"

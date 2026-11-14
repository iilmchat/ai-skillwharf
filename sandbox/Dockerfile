# syntax=docker/dockerfile:1

# Образ для выполнения навыков, которым нужны внешние API:
# curl — HTTP-запросы, jq — разбор JSON, gh — GitHub CLI, bash — скрипты навыков.
#
# iptables/su-exec — per-container egress-фильтр (ADR 0004, п.3): worker
# поднимает bridge + NET_ADMIN и запускает root-entrypoint, который разрешает
# только IP из FQDN-allowlist, ставит DROP-политику и сбрасывает права до 65534.
# musl-utils — getent для резолва allowlist, bind-tools — fallback (nslookup).
#
# Документы (Sprint 20): tesseract-ocr — локальный OCR-fallback, когда нет
# ключа облачного SDE; poppler-utils — pdftotext/pdfinfo/pdftoppm для PDF;
# pandoc — генерация DOCX из Markdown/HTML. LibreOffice не ставим: +578 МБ
# на образ ради конвертации, которая не нужна для DOCX.
FROM alpine:3.20

RUN apk add --no-cache \
    curl \
    jq \
    github-cli \
    bash \
    python3 \
    py3-pip \
    iptables \
    su-exec \
    musl-utils \
    bind-tools \
    tesseract-ocr \
    tesseract-ocr-data-rus \
    tesseract-ocr-data-eng \
    poppler-utils \
    pandoc-cli \
    font-dejavu

# fontconfig (pdftoppm/pandoc) пишет кэш шрифтов в $XDG_CACHE_HOME; rootfs
# read-only, поэтому кэш направляем в tmpfs /tmp, иначе pdftoppm сыплет
# «Fontconfig error: No writable cache directories».
ENV XDG_CACHE_HOME=/tmp/.cache

COPY egress-setup.sh /usr/local/bin/sandbox-egress-setup.sh
RUN chmod 0755 /usr/local/bin/sandbox-egress-setup.sh

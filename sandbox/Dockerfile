# syntax=docker/dockerfile:1

# Образ для выполнения навыков, которым нужны внешние API:
# curl — HTTP-запросы, jq — разбор JSON, gh — GitHub CLI, bash — скрипты навыков.
#
# iptables/su-exec — per-container egress-фильтр (ADR 0004, п.3): worker
# поднимает bridge + NET_ADMIN и запускает root-entrypoint, который разрешает
# только IP из FQDN-allowlist, ставит DROP-политику и сбрасывает права до 65534.
# musl-utils — getent для резолва allowlist, bind-tools — fallback (nslookup).
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
    bind-tools

COPY egress-setup.sh /usr/local/bin/sandbox-egress-setup.sh
RUN chmod 0755 /usr/local/bin/sandbox-egress-setup.sh

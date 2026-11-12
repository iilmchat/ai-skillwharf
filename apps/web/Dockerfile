# syntax=docker/dockerfile:1

# --- Stage 1: сборка статики ---
FROM node:24-alpine AS builder

ENV npm_config_fetch_retries=5 \
    npm_config_fetch_timeout=120000

RUN npm install --global pnpm@12.18.0
WORKDIR /app

# Контекст сборки — корень репозитория: pnpm workspace и lockfile лежат там.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/web/package.json ./apps/web/package.json
COPY packages/shared/package.json ./packages/shared/package.json
RUN pnpm install --frozen-lockfile

COPY packages/shared ./packages/shared
COPY apps/web ./apps/web

# Vite вшивает базовый URL API на этапе сборки. WebSocket идёт на тот же
# origin (window.location.origin), поэтому отдельная переменная не нужна.
ARG VITE_API_URL=/api/v1
ENV VITE_API_URL=${VITE_API_URL}

RUN pnpm --filter web build

# --- Stage 2: раздача статики и прокси на API ---
FROM caddy:2-alpine AS runner

COPY apps/web/Caddyfile /etc/caddy/Caddyfile
COPY --from=builder /app/apps/web/dist /usr/share/caddy

EXPOSE 80

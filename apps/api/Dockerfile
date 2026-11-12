# syntax=docker/dockerfile:1

# --- Stage 1: сборка ---
FROM node:24-alpine AS builder

# Сеть до registry нестабильна: pnpm ретраит загрузки дольше дефолта.
ENV npm_config_fetch_retries=5 \
    npm_config_fetch_timeout=120000

RUN npm install --global pnpm@12.18.0
WORKDIR /app

# Манифесты воркспейса копируем отдельно: слой кэшируется, пока не менялись зависимости.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/api/package.json ./apps/api/package.json
COPY packages/shared/package.json ./packages/shared/package.json
RUN pnpm install --frozen-lockfile

# KI-002: исходники shared-пакета нужны, если API импортирует @skillwharf/shared.
COPY packages/shared ./packages/shared
COPY apps/api ./apps/api

# openssl нужен Prisma, чтобы определить версию OpenSSL (иначе выберется движок под libssl1.1).
RUN apk add --no-cache openssl

# Скрипт build сам генерирует Prisma Client: без него nest build не найдёт типы.
RUN pnpm --filter api build

# KI-001: изолированная папка только с production-зависимостями вместо всего node_modules.
RUN pnpm --filter api deploy --prod /prod/api

# `deploy` пересоздаёт node_modules из store и теряет сгенерированный клиент —
# генерируем Prisma Client ещё раз уже в изолированной папке.
RUN cd /prod/api && /app/apps/api/node_modules/.bin/prisma generate --schema prisma/schema.prisma

# --- Stage 2: Prisma CLI для миграций ---
# В рантайм нужен только `prisma migrate deploy`; pnpm и npm туда не попадают.
FROM node:24-alpine AS tools

# openssl нужен и здесь: без него Prisma CLI скачает движок под libssl1.1
# и в рантайме попытается перекачать его под openssl-3 (нужна запись в node_modules).
RUN apk add --no-cache openssl \
  && npm install --global --no-fund --no-audit prisma@5.22.0 \
  && npm cache clean --force

# --- Stage 3: рантайм ---
FROM alpine:3.24 AS runner

ENV NODE_ENV=production

# openssl нужен Prisma-движку, libstdc++/libgcc — самому бинарнику node.
RUN apk add --no-cache openssl libstdc++ ca-certificates

# Берём только node из официального образа: npm, yarn и corepack в рантайме не нужны.
COPY --from=node:24-alpine /usr/local/bin/node /usr/local/bin/node
COPY --from=tools /usr/local/lib/node_modules/prisma /usr/local/lib/node_modules/prisma
RUN ln -s ../lib/node_modules/prisma/build/index.js /usr/local/bin/prisma

WORKDIR /app

# Только production-зависимости + собранное приложение + схема и миграции Prisma.
COPY --from=builder /prod/api/package.json ./package.json
COPY --from=builder /prod/api/node_modules ./node_modules
COPY --from=builder /prod/api/dist ./dist
COPY --from=builder /prod/api/prisma ./prisma

RUN addgroup -S -g 1001 appuser \
  && adduser -S -u 1001 -G appuser appuser

USER appuser
EXPOSE 3000
CMD ["node", "dist/main"]

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

# Prisma Client генерируется до компиляции TypeScript: без него nest build не найдёт типы.
RUN cd apps/api && npx prisma generate

# Прогреваем schema-engine под openssl-3 в read-only node_modules рантайма:
# иначе `db:migrate` попытается скачать движок в контейнере и упрётся в права.
RUN cd apps/api && npx prisma migrate diff --from-empty --to-schema-datamodel prisma/schema.prisma --script > /dev/null

RUN pnpm --filter api build

# --- Stage 2: рантайм ---
FROM node:24-alpine AS runner

ENV NODE_ENV=production

# Prisma-движку нужен OpenSSL: без пакета openssl alpine-образ не определяет
# версию OpenSSL и Prisma пытается загрузить движок под libssl.so.1.1.
RUN apk add --no-cache openssl

RUN npm install --global pnpm@12.18.0
WORKDIR /app

# Берём node_modules из builder: там уже есть сгенерированный Prisma Client,
# prisma CLI (нужен для `pnpm run db:migrate`) и нативные модули под alpine.
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/apps ./apps
COPY --from=builder /app/packages ./packages
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./

RUN addgroup -S -g 1001 appuser \
  && adduser -S -u 1001 -G appuser appuser

USER appuser
WORKDIR /app/apps/api
EXPOSE 3000
CMD ["node", "dist/main"]

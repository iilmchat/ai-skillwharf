# syntax=docker/dockerfile:1

# --- Stage 1: сборка ---
FROM node:24-alpine AS builder

RUN npm install --global pnpm@12.18.0
WORKDIR /app

# Манифесты воркспейса копируем отдельно: слой кэшируется, пока не менялись зависимости.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/api/package.json ./apps/api/package.json
RUN pnpm install --frozen-lockfile

COPY apps/api ./apps/api
RUN pnpm --filter api build

# --- Stage 2: рантайм ---
FROM node:24-alpine AS runner

ENV NODE_ENV=production
RUN npm install --global pnpm@12.18.0
WORKDIR /app

# В рантайм ставим только production-зависимости.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/api/package.json ./apps/api/package.json
RUN pnpm install --prod --frozen-lockfile

COPY --from=builder /app/apps/api/dist ./apps/api/dist

RUN addgroup -S -g 1001 appuser \
  && adduser -S -u 1001 -G appuser appuser

USER appuser
WORKDIR /app/apps/api
EXPOSE 3000
CMD ["node", "dist/main"]

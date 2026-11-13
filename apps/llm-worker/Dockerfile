# syntax=docker/dockerfile:1

# --- Stage 1: сборка ---
FROM node:24-alpine AS builder

ENV npm_config_fetch_retries=5 \
    npm_config_fetch_timeout=120000

RUN npm install --global pnpm@12.18.0
WORKDIR /app

# Манифесты воркспейса отдельно: слой кэшируется, пока не менялись зависимости.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/llm-worker/package.json ./apps/llm-worker/package.json
RUN pnpm install --frozen-lockfile

COPY apps/llm-worker ./apps/llm-worker
RUN pnpm --filter llm-worker build
RUN pnpm --filter llm-worker deploy --prod /prod/llm-worker

# --- Stage 2: рантайм ---
FROM node:24-alpine AS runner

ENV NODE_ENV=production

# CA-сертификаты нужны для HTTPS-запросов к LLM-провайдерам.
RUN apk add --no-cache ca-certificates

WORKDIR /app
COPY --from=builder /prod/llm-worker/package.json ./package.json
COPY --from=builder /prod/llm-worker/node_modules ./node_modules
COPY --from=builder /prod/llm-worker/dist ./dist

RUN addgroup -S -g 1001 appuser \
  && adduser -S -u 1001 -G appuser appuser

USER appuser
EXPOSE 4100
CMD ["node", "dist/main.js"]

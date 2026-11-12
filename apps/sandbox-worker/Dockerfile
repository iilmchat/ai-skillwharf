# syntax=docker/dockerfile:1

# --- Stage 1: сборка ---
FROM node:24-alpine AS builder

ENV npm_config_fetch_retries=5 \
    npm_config_fetch_timeout=120000

RUN npm install --global pnpm@12.18.0
WORKDIR /app

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/sandbox-worker/package.json ./apps/sandbox-worker/package.json
RUN pnpm install --frozen-lockfile

COPY apps/sandbox-worker ./apps/sandbox-worker
RUN pnpm --filter sandbox-worker build
RUN pnpm --filter sandbox-worker deploy --prod /prod/sandbox-worker

# --- Stage 2: рантайм ---
FROM node:24-alpine AS runner

ENV NODE_ENV=production

WORKDIR /app
COPY --from=builder /prod/sandbox-worker/package.json ./package.json
COPY --from=builder /prod/sandbox-worker/node_modules ./node_modules
COPY --from=builder /prod/sandbox-worker/dist ./dist

# Worker — привилегированный компонент: доступ к docker.sock требует прав
# root (GID сокета зависит от хоста). API при этом остаётся непривилегированным.
EXPOSE 4000
CMD ["node", "dist/index.js"]

FROM node:24-alpine

ENV NODE_ENV=production \
    PORT=5007

WORKDIR /app
COPY server.mjs ./server.mjs

USER node
EXPOSE 5007

CMD ["node", "server.mjs"]

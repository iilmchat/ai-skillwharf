FROM node:24-alpine

ENV NODE_ENV=production \
    PORT=5006

WORKDIR /app
COPY server.mjs ./server.mjs

USER node
EXPOSE 5006

CMD ["node", "server.mjs"]

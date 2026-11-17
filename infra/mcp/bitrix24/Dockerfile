FROM node:24-alpine

ENV NODE_ENV=production \
    PORT=5003

WORKDIR /app
COPY server.mjs ./server.mjs

USER node
EXPOSE 5003

CMD ["node", "server.mjs"]

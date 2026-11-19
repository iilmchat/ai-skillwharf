FROM node:24-alpine

ENV NODE_ENV=production \
    PORT=5005

WORKDIR /app
COPY server.mjs ./server.mjs

USER node
EXPOSE 5005

CMD ["node", "server.mjs"]

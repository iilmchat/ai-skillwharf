FROM node:24-alpine

ENV NODE_ENV=production \
    PORT=5004

WORKDIR /app
COPY server.mjs ./server.mjs

USER node
EXPOSE 5004

CMD ["node", "server.mjs"]

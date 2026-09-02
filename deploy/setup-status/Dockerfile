FROM node:22-alpine

WORKDIR /app
COPY deploy/setup-status/server.mjs ./server.mjs
COPY deploy/setup-status/public ./public

ENV PORT=9091
EXPOSE 9091
USER node
CMD ["node", "server.mjs"]

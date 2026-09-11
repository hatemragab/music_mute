FROM node:24-alpine AS build

WORKDIR /app

COPY dashboard/package.json dashboard/package-lock.json ./
RUN npm ci

COPY dashboard/index.html dashboard/tsconfig*.json dashboard/vite.config.ts dashboard/vite-environment.ts ./
COPY dashboard/public ./public
COPY dashboard/src ./src
RUN npm run build

FROM node:24-alpine AS production

ENV APP_ENV=production \
    NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=80 \
    VITE_APP_BASE_PATH=/

WORKDIR /app

RUN apk add --no-cache libcap \
    && setcap 'cap_net_bind_service=+ep' /usr/local/bin/node \
    && apk del libcap

COPY --from=build --chown=node:node /app/dist ./dist
COPY --chown=node:node dashboard/server.mjs ./server.mjs

USER node

EXPOSE 80

CMD ["node", "server.mjs"]

# syntax=docker/dockerfile:1.10
FROM node:24-alpine AS build

WORKDIR /app

COPY dashboard/package.json dashboard/package-lock.json ./
RUN npm ci

COPY dashboard/index.html dashboard/tsconfig*.json dashboard/vite.config.ts dashboard/vite-environment.ts ./
COPY dashboard/public ./public
COPY dashboard/src ./src
ARG SENTRY_RELEASE
RUN --mount=type=secret,id=sentry_auth_token,env=SENTRY_AUTH_TOKEN \
    if [ -n "${SENTRY_AUTH_TOKEN:-}" ]; then \
      test -n "$SENTRY_RELEASE"; \
    fi; \
    SENTRY_RELEASE="$SENTRY_RELEASE" npm run build

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

COPY dashboard/package.json dashboard/package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts

COPY --from=build --chown=node:node /app/dist ./dist
COPY --chown=node:node dashboard/server.mjs ./server.mjs
COPY --chown=node:node dashboard/server-sentry.mjs ./server-sentry.mjs

USER node

EXPOSE 80

CMD ["node", "server.mjs"]

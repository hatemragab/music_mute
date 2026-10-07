# syntax=docker/dockerfile:1.10
FROM node:24-alpine AS build

WORKDIR /app

COPY dashboard/package.json dashboard/package-lock.json ./
COPY dashboard/index.html dashboard/tsconfig*.json dashboard/vite.config.ts dashboard/vite-environment.ts ./
COPY dashboard/public ./public
COPY dashboard/src ./src
ARG SENTRY_RELEASE
# Resolve the optional secret before the long install, then expose it only to
# the build. This avoids needing a new BuildKit session lookup after npm ci.
RUN --mount=type=secret,id=sentry_auth_token \
    set -eu; \
    npm ci --ignore-scripts; \
    if [ -s /run/secrets/sentry_auth_token ]; then \
      test -n "${SENTRY_RELEASE:-}"; \
      IFS= read -r SENTRY_AUTH_TOKEN < /run/secrets/sentry_auth_token || test -n "${SENTRY_AUTH_TOKEN:-}"; \
      export SENTRY_AUTH_TOKEN; \
    fi; \
    SENTRY_RELEASE="${SENTRY_RELEASE:-}" npm run build

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

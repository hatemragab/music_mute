# syntax=docker/dockerfile:1.10
FROM node:24.21.0-bookworm-slim AS build

WORKDIR /app

COPY backend/package.json backend/pnpm-lock.yaml backend/.npmrc ./
RUN corepack enable \
    && corepack install --global pnpm@10.14.0 \
    && pnpm install --frozen-lockfile

COPY backend/nest-cli.json backend/tsconfig*.json ./
COPY backend/src ./src
ARG SENTRY_RELEASE
RUN --mount=type=secret,id=sentry_auth_token,env=SENTRY_AUTH_TOKEN \
    pnpm run build \
    && if [ -n "${SENTRY_AUTH_TOKEN:-}" ]; then \
      test -n "$SENTRY_RELEASE"; \
      pnpm exec sentry-cli sourcemaps inject dist; \
      pnpm exec sentry-cli sourcemaps upload \
        --org vchat-9f --project musicmute-backend \
        --release "$SENTRY_RELEASE" --validate --wait dist; \
      find dist -name '*.map' -delete; \
    fi

FROM node:24.21.0-bookworm-slim AS apk-verifier

ENV ANDROID_SDK_ROOT=/opt/android-sdk

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        ca-certificates \
        curl \
        openjdk-17-jre-headless \
        unzip \
    && rm -rf /var/lib/apt/lists/*

COPY backend/scripts/install-apk-verifier.sh /tmp/install-apk-verifier.sh
RUN sh /tmp/install-apk-verifier.sh \
    && rm /tmp/install-apk-verifier.sh

FROM node:24.21.0-bookworm-slim AS production

ARG SENTRY_RELEASE

ENV APP_ENV=production \
    NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=80 \
    ANDROID_SDK_ROOT=/opt/android-sdk \
    APK_AAPT2_PATH=/opt/android-sdk/build-tools/35.0.0/aapt2 \
    APK_APKSIGNER_PATH=/opt/android-sdk/build-tools/35.0.0/apksigner \
    APK_MAX_MIN_SDK=26
ENV SENTRY_RELEASE=${SENTRY_RELEASE}

WORKDIR /app

COPY backend/package.json backend/pnpm-lock.yaml backend/.npmrc ./
RUN corepack enable \
    && corepack install --global pnpm@10.14.0 \
    && pnpm install --prod --frozen-lockfile \
    && pnpm store prune
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        ca-certificates \
        libcap2-bin \
        ffmpeg \
        openjdk-17-jre-headless \
    && setcap 'cap_net_bind_service=+ep' /usr/local/bin/node \
    && rm -rf /var/lib/apt/lists/*

COPY --from=apk-verifier --chown=root:root /opt/android-sdk /opt/android-sdk
COPY --from=build --chown=node:node /app/dist ./dist
COPY --chown=node:node backend/config/worker-installation-catalog.json ./config/worker-installation-catalog.json

ENV WORKER_INSTALLATION_CATALOG_PATH=/app/config/worker-installation-catalog.json

USER node

EXPOSE 80

CMD ["node", "dist/main.js"]

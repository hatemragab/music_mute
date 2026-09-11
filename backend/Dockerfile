FROM node:24-alpine AS build

WORKDIR /app

COPY backend/package.json backend/package-lock.json backend/.npmrc ./
RUN npm ci

COPY backend/nest-cli.json backend/tsconfig*.json ./
COPY backend/src ./src
RUN npm run build

FROM node:24-alpine AS production

ENV APP_ENV=production \
    NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=80

WORKDIR /app

COPY backend/package.json backend/package-lock.json backend/.npmrc ./
RUN npm ci --omit=dev && npm cache clean --force
RUN apk add --no-cache libcap \
    && setcap 'cap_net_bind_service=+ep' /usr/local/bin/node \
    && apk del libcap

COPY --from=build --chown=node:node /app/dist ./dist

USER node

EXPOSE 80

CMD ["node", "dist/main.js"]

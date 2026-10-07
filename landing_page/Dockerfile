FROM node:24-alpine AS build
WORKDIR /workspace/landing_page
COPY landing_page/package.json landing_page/package-lock.json ./
RUN npm ci --ignore-scripts
COPY landing_page/index.html landing_page/tsconfig.json landing_page/vite.config.ts ./
COPY landing_page/ar ./ar
COPY landing_page/public ./public
COPY landing_page/src ./src
RUN npm run build

FROM node:24-alpine
ENV NODE_ENV=production HOST=0.0.0.0 PORT=3000
WORKDIR /app
COPY --from=build --chown=node:node /workspace/landing_page/dist ./dist
COPY --chown=node:node landing_page/server.mjs ./server.mjs
USER node
EXPOSE 3000
CMD ["node", "server.mjs"]

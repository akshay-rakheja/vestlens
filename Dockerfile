# syntax=docker/dockerfile:1.7
# Read-only portfolio API + MCP endpoint + browser dashboard, self-hosted.
# Targets: `production` (the app) and `migrator` (applies Prisma migrations, then exits).
# Legacy simulator packages are never copied.

FROM node:22-bookworm-slim AS api-builder

RUN apt-get update \
    && apt-get install -y --no-install-recommends openssl \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app/packages/api

COPY packages/api/package.json packages/api/package-lock.json ./
RUN npm ci --ignore-scripts --no-audit --no-fund

COPY packages/api/prisma ./prisma
RUN npm run prisma:generate

COPY packages/api/tsconfig.json ./
COPY packages/api/src ./src
# Test files and synthetic fixtures are type-checked but not shipped.
RUN npm run typecheck \
    && ./node_modules/.bin/tsc \
    && find dist -name "*.test.js" -delete

FROM api-builder AS migrator

ENV NODE_ENV=production
USER node
CMD ["./node_modules/.bin/prisma", "migrate", "deploy", "--schema", "prisma/schema.prisma"]

FROM node:22-bookworm-slim AS api-runtime-dependencies

WORKDIR /app/packages/api

COPY packages/api/package.json packages/api/package-lock.json ./
RUN npm pkg delete devDependencies \
    && npm ci --omit=dev --ignore-scripts --no-audit --no-fund

COPY --from=api-builder /app/packages/api/node_modules/@prisma/client ./node_modules/@prisma/client
COPY --from=api-builder /app/packages/api/node_modules/.prisma ./node_modules/.prisma

FROM node:22-bookworm-slim AS web-builder

# Nothing instance-specific is baked in: the dashboard talks to the origin that served it.
WORKDIR /app/packages/web

COPY packages/web/package.json packages/web/package-lock.json ./
RUN npm ci --ignore-scripts --no-audit --no-fund

COPY packages/web/ ./
RUN npm run build

FROM node:22-bookworm-slim AS widgets-builder

WORKDIR /app/packages/widgets

COPY packages/widgets/package.json packages/widgets/package-lock.json packages/widgets/.npmrc ./
RUN npm ci --ignore-scripts --legacy-peer-deps --no-audit --no-fund

COPY packages/widgets/ ./
RUN npm run typecheck && npm run build

FROM node:22-bookworm-slim AS production

RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates openssl \
    && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production
ENV PORT=8080
# Inside the container the server listens on all interfaces; Compose publishes the port on 127.0.0.1 only.
ENV HOST=0.0.0.0
ENV WEB_DIST_DIRECTORY=/app/packages/web/dist
ENV WIDGETS_DIST_DIRECTORY=/app/packages/widgets/dist

WORKDIR /app/packages/api

COPY --from=api-runtime-dependencies /app/packages/api/node_modules ./node_modules
COPY --from=api-builder /app/packages/api/dist ./dist
COPY --from=api-builder /app/packages/api/prisma ./prisma
COPY --from=web-builder /app/packages/web/dist /app/packages/web/dist
COPY --from=widgets-builder /app/packages/widgets/dist /app/packages/widgets/dist

RUN chown -R node:node /app
USER node

EXPOSE 8080

CMD ["node", "dist/server.js"]

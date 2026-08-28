# Build stage
FROM node:24-alpine AS builder

WORKDIR /app

RUN apk add --no-cache python3 make g++

COPY package.json package-lock.json ./
COPY backend/package.json ./backend/package.json
COPY frontend/package.json ./frontend/package.json
COPY packages/domain/package.json ./packages/domain/package.json

RUN npm ci --workspace backend --workspace @excalidash/domain --include-workspace-root && \
    npm cache clean --force

COPY backend/prisma ./backend/prisma/
RUN sed -i '/datasource db {/,/}/ s/provider = env("[^"]*")/provider = "sqlite"/; /datasource db {/,/}/ s/provider = "[^"]*"/provider = "sqlite"/' backend/prisma/schema.prisma
RUN npm exec --workspace backend -- prisma generate

COPY packages/domain ./packages/domain
COPY backend/tsconfig.json ./backend/tsconfig.json
COPY backend/src ./backend/src
RUN npm run build:domain && npm run build --workspace backend

FROM node:24-alpine

RUN apk add --no-cache openssl su-exec poppler-utils ghostscript imagemagick && \
    addgroup -g 1001 -S nodejs && \
    adduser -S nodejs -u 1001

WORKDIR /app

COPY package.json package-lock.json ./
COPY backend/package.json ./backend/package.json
COPY frontend/package.json ./frontend/package.json
COPY packages/domain/package.json ./packages/domain/package.json

RUN apk add --no-cache --virtual .build-deps python3 make g++ && \
    npm ci --omit=dev --workspace backend --workspace @excalidash/domain --include-workspace-root && \
    npm cache clean --force && \
    apk del .build-deps

COPY backend/prisma ./prisma/
COPY backend/prisma ./prisma_template/
COPY --from=builder /app/backend/dist ./dist
COPY --from=builder /app/packages/domain/dist ./packages/domain/dist
COPY --from=builder /app/backend/src/generated ./dist/generated

RUN mkdir -p /app/uploads /app/prisma

COPY backend/docker-entrypoint.sh ./
RUN chmod +x docker-entrypoint.sh

EXPOSE 8000
ENTRYPOINT ["./docker-entrypoint.sh"]

# Build stage
FROM node:24-alpine AS builder

WORKDIR /app

# Native build deps for modules that may compile from source (e.g., better-sqlite3 on arm64)
RUN apk add --no-cache python3 make g++

# Copy workspace manifests first for a cacheable targeted install.
COPY package.json package-lock.json ./
COPY backend/package.json ./backend/package.json
COPY frontend/package.json ./frontend/package.json
COPY packages/domain/package.json ./packages/domain/package.json

# Install dependencies
RUN npm ci --workspace backend --workspace @excalidash/domain --include-workspace-root && \
    npm cache clean --force

# Copy prisma schema
COPY backend/prisma ./backend/prisma/

# Set default provider for build-time Prisma generation (runtime can override via DATABASE_PROVIDER)
RUN sed -i '/datasource db {/,/}/ s/provider = env("[^"]*")/provider = "sqlite"/; /datasource db {/,/}/ s/provider = "[^"]*"/provider = "sqlite"/' backend/prisma/schema.prisma

# Generate Prisma Client at build time (for TypeScript compilation)
# Runtime will regenerate if DATABASE_PROVIDER differs
RUN npm exec --workspace backend -- prisma generate

# Copy source code
COPY packages/domain ./packages/domain
COPY backend/tsconfig.json ./backend/tsconfig.json
COPY backend/src ./backend/src

# Build TypeScript
RUN npm run build:domain && npm run build --workspace backend

# Production stage
FROM node:24-alpine

# Install runtime packages and create non-root user
# poppler-utils renders PDF pages. ImageMagick decodes untrusted remote link
# art in a short-lived, resource-limited process and re-encodes it without
# metadata before the application serves it.
RUN apk add --no-cache openssl su-exec poppler-utils ghostscript imagemagick && \
    addgroup -g 1001 -S nodejs && \
    adduser -S nodejs -u 1001

WORKDIR /app

# Install only the backend runtime and its private domain workspace.
COPY package.json package-lock.json ./
COPY backend/package.json ./backend/package.json
COPY frontend/package.json ./frontend/package.json
COPY packages/domain/package.json ./packages/domain/package.json

# Install production dependencies only
RUN apk add --no-cache --virtual .build-deps python3 make g++ && \
    npm ci --omit=dev --workspace backend --workspace @excalidash/domain --include-workspace-root && \
    npm cache clean --force && \
    apk del .build-deps

# Copy prisma schema and migrations for runtime and hydration template
COPY backend/prisma ./prisma/
COPY backend/prisma ./prisma_template/

# Copy built application from builder
COPY --from=builder /app/backend/dist ./dist
COPY --from=builder /app/packages/domain/dist ./packages/domain/dist

# Copy the generated Prisma Client from builder (will be regenerated at runtime if provider changes)
COPY --from=builder /app/backend/src/generated ./dist/generated

# Create necessary directories (ownership will be set in entrypoint)
RUN mkdir -p /app/uploads /app/prisma

# Copy and set permissions for entrypoint script
COPY backend/docker-entrypoint.sh ./
RUN chmod +x docker-entrypoint.sh

# REMOVED: USER nodejs (We must stay root to fix permissions in entrypoint)

EXPOSE 8000

ENTRYPOINT ["./docker-entrypoint.sh"]

# Build stage
FROM node:24-alpine AS builder

WORKDIR /app

# The frontend consumes the private domain workspace. Copy manifests first so
# dependency installation remains cacheable without copying either source tree.
COPY package.json package-lock.json ./
COPY frontend/package.json ./frontend/package.json
COPY backend/package.json ./backend/package.json
COPY packages/domain/package.json ./packages/domain/package.json
# frontend's postinstall exposes the pinned Excalidraw command-palette seam.
COPY frontend/scripts/expose-excalidraw-command-palette.mjs ./frontend/scripts/expose-excalidraw-command-palette.mjs

RUN npm ci --workspace frontend --workspace @excalidash/domain --include-workspace-root && \
    npm cache clean --force

COPY packages/domain/ ./packages/domain/
COPY frontend/ ./frontend/
COPY VERSION ./VERSION

# Build arguments
ARG VITE_APP_VERSION
ARG VITE_APP_BUILD_LABEL
ENV VITE_APP_VERSION=$VITE_APP_VERSION
ENV VITE_APP_BUILD_LABEL=$VITE_APP_BUILD_LABEL

# Build the application
RUN npm run build:frontend

# Production stage
FROM nginx:alpine

# Copy nginx config template (will be processed at runtime)
COPY frontend/nginx.conf.template /etc/nginx/nginx.conf.template

# Copy entrypoint script
COPY frontend/docker-entrypoint.sh /docker-entrypoint.sh
RUN chmod +x /docker-entrypoint.sh

# Copy built application from builder
COPY --from=builder /app/frontend/dist /usr/share/nginx/html

EXPOSE 80

# Use custom entrypoint to process nginx config template
ENTRYPOINT ["/docker-entrypoint.sh"]
CMD ["nginx", "-g", "daemon off;"]

# Build stage
FROM node:24-alpine AS builder

WORKDIR /app/frontend

# Copy package files first for better caching.
#
# `postinstall` runs `prepare:excalidraw`, which executes
# `scripts/expose-excalidraw-command-palette.mjs` -- so that script has to be
# in the image before `npm ci`, not after. Copying only package*.json here made
# the image unbuildable the moment that postinstall hook was added: `npm ci`
# failed with `Cannot find module .../scripts/expose-excalidraw-command-palette.mjs`.
# It went unnoticed because image publishing had been skipped all day (its
# `Tests`-on-main trigger was red), so nothing had built the frontend since.
COPY frontend/package*.json ./
COPY frontend/scripts ./scripts

# Install dependencies
RUN npm ci && npm cache clean --force

# Copy source code and config files
COPY frontend/ ./
COPY VERSION ../VERSION

# The repo-root scripts, not just VERSION.
#
# `npm run build` runs `typecheck`, which since the notification facade landed
# is `node ../scripts/notification-boundary.cjs && tsc -b`. Copying only VERSION
# left that guard missing and the build died with
# `Cannot find module /app/scripts/notification-boundary.cjs`. This is the
# builder stage of a multi-stage build, so nothing here reaches the shipped image.
COPY scripts ../scripts

# Build arguments
ARG VITE_APP_VERSION
ARG VITE_APP_BUILD_LABEL
ENV VITE_APP_VERSION=$VITE_APP_VERSION
ENV VITE_APP_BUILD_LABEL=$VITE_APP_BUILD_LABEL

# Build the application
RUN npm run build

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

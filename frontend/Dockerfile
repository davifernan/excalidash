# Build stage
FROM node:24-alpine AS builder

WORKDIR /app

COPY package.json package-lock.json ./
COPY frontend/package.json ./frontend/package.json
COPY backend/package.json ./backend/package.json
COPY packages/domain/package.json ./packages/domain/package.json
COPY frontend/scripts ./frontend/scripts

RUN npm ci --workspace frontend --workspace @excalidash/domain --include-workspace-root && \
    npm cache clean --force

COPY packages/domain/ ./packages/domain/
COPY frontend/ ./frontend/
COPY VERSION ./VERSION
COPY scripts ./scripts

ARG VITE_APP_VERSION
ARG VITE_APP_BUILD_LABEL
# NIL-649: defaults to unset, i.e. "false" once vite.config.ts stringifies it.
# Only the built-image E2E smoke job (docker-compose.e2e-smoke.yml) passes
# "true" here -- a real published image never does, so the E2E test harness
# never ships to a user's instance.
ARG VITE_E2E_HARNESS_ENABLED
ENV VITE_APP_VERSION=$VITE_APP_VERSION
ENV VITE_APP_BUILD_LABEL=$VITE_APP_BUILD_LABEL
ENV VITE_E2E_HARNESS_ENABLED=$VITE_E2E_HARNESS_ENABLED

RUN npm run build:frontend

FROM nginx:alpine

COPY frontend/nginx.conf.template /etc/nginx/nginx.conf.template
COPY frontend/docker-entrypoint.sh /docker-entrypoint.sh
RUN chmod +x /docker-entrypoint.sh
COPY --from=builder /app/frontend/dist /usr/share/nginx/html

EXPOSE 80
ENTRYPOINT ["/docker-entrypoint.sh"]
CMD ["nginx", "-g", "daemon off;"]

#!/bin/sh
# Alpine-based image uses /bin/sh (busybox ash), not bash
set -e

# Set default backend URL if not provided (host:port format, no protocol)
export BACKEND_URL="${BACKEND_URL:-backend:8000}"
export ERROR_TRACKER_DSN="${ERROR_TRACKER_DSN:-}"

echo "Configuring nginx with BACKEND_URL: ${BACKEND_URL}"

# This image is published once and configured at runtime. Vite variables alone
# cannot carry an operator's DSN into an already-built image, so write the one
# deliberately public Sentry-compatible ingest credential before nginx starts.
# Restrict it to URL-safe characters so an env value cannot break out of the JS
# string and become executable content.
case "$ERROR_TRACKER_DSN" in
  *[!A-Za-z0-9:/?._@%+=~-]*)
    echo "ERROR: ERROR_TRACKER_DSN contains characters that are not valid in a DSN URL" >&2
    exit 1
    ;;
esac

# Replace only our custom placeholder and preserve nginx runtime vars like $http_upgrade
ESCAPED_BACKEND_URL=$(printf '%s\n' "$BACKEND_URL" | sed 's/[\/&]/\\&/g')
sed "s/__BACKEND_URL__/${ESCAPED_BACKEND_URL}/g" /etc/nginx/nginx.conf.template > /etc/nginx/nginx.conf

printf 'window.__EXCALIDASH_RUNTIME_CONFIG__ = { errorTrackerDsn: "%s" };\n' \
  "$ERROR_TRACKER_DSN" > /usr/share/nginx/html/runtime-config.js

# Validate the generated nginx configuration before starting
echo "Validating nginx configuration..."
if ! nginx -t -c /etc/nginx/nginx.conf; then
    echo "ERROR: nginx configuration validation failed" >&2
    exit 1
fi

# Execute the main command (nginx)
exec "$@"

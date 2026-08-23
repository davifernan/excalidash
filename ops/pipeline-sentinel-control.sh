#!/usr/bin/env bash

set -euo pipefail

if [[ $(id -u) -ne 0 ]]; then
  echo "Run this command as root." >&2
  exit 1
fi

pause_file=${SENTINEL_PAUSE_FILE:-/var/lib/excalidash-pipeline-sentinel/mutations-paused}
command=${1:-status}

case "$command" in
  pause)
    install -o claude -g claude -m 0600 /dev/null "$pause_file"
    systemctl start excalidash-pipeline-sentinel.service
    echo "Sentinel is active in observe-only mode."
    ;;
  resume)
    rm -f "$pause_file"
    systemctl enable --now excalidash-pipeline-sentinel.timer
    systemctl start excalidash-pipeline-sentinel.service
    echo "Sentinel mutations resumed."
    ;;
  status)
    if [[ -e "$pause_file" ]]; then
      echo "mode=observe-only"
    else
      echo "mode=live"
    fi
    systemctl is-enabled excalidash-pipeline-sentinel.timer
    systemctl is-active excalidash-pipeline-sentinel.timer
    ;;
  *)
    echo "Usage: excalidash-pipeline-sentinel-control {pause|resume|status}" >&2
    exit 2
    ;;
esac

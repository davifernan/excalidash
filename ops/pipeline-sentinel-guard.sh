#!/usr/bin/env bash

set -euo pipefail

systemctl_bin=${SYSTEMCTL_BIN:-systemctl}
state_file=${SENTINEL_STATE_FILE:-/var/lib/excalidash-pipeline-sentinel/state.json}
maximum_state_age=${SENTINEL_MAXIMUM_STATE_AGE_SECONDS:-420}
now_epoch=${SENTINEL_NOW_EPOCH:-$(date +%s)}

if ! "$systemctl_bin" is-enabled --quiet excalidash-pipeline-sentinel.timer; then
  "$systemctl_bin" enable excalidash-pipeline-sentinel.timer
  echo "sentinel-guard action=enable-timer"
fi

if ! "$systemctl_bin" is-active --quiet excalidash-pipeline-sentinel.timer; then
  "$systemctl_bin" start excalidash-pipeline-sentinel.timer
  echo "sentinel-guard action=start-timer"
fi

state_age=$maximum_state_age
if [[ -e "$state_file" ]]; then
  state_mtime=$(stat -c %Y "$state_file")
  state_age=$((now_epoch - state_mtime))
fi

if (( state_age >= maximum_state_age )); then
  "$systemctl_bin" reset-failed excalidash-pipeline-sentinel.service || true
  "$systemctl_bin" start excalidash-pipeline-sentinel.service
  echo "sentinel-guard action=start-scan state_age_seconds=$state_age"
fi

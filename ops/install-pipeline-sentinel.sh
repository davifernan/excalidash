#!/usr/bin/env bash

set -euo pipefail

if [[ $(id -u) -ne 0 ]]; then
  echo "Run this installer as root." >&2
  exit 1
fi

repo_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
unit_root=/etc/systemd/system

install -m 0644 \
  "$repo_root/ops/systemd/excalidash-pipeline-sentinel.service" \
  "$unit_root/excalidash-pipeline-sentinel.service"
install -m 0644 \
  "$repo_root/ops/systemd/excalidash-pipeline-sentinel.timer" \
  "$unit_root/excalidash-pipeline-sentinel.timer"
install -m 0644 \
  "$repo_root/ops/systemd/excalidash-pipeline-sentinel-guard.service" \
  "$unit_root/excalidash-pipeline-sentinel-guard.service"
install -m 0644 \
  "$repo_root/ops/systemd/excalidash-pipeline-sentinel-guard.timer" \
  "$unit_root/excalidash-pipeline-sentinel-guard.timer"
install -m 0755 \
  "$repo_root/ops/pipeline-sentinel-guard.sh" \
  /usr/local/sbin/excalidash-pipeline-sentinel-guard
install -m 0755 \
  "$repo_root/ops/pipeline-sentinel-control.sh" \
  /usr/local/sbin/excalidash-pipeline-sentinel-control

systemctl daemon-reload
systemctl enable --now excalidash-pipeline-sentinel.timer
systemctl enable --now excalidash-pipeline-sentinel-guard.timer
systemctl start excalidash-pipeline-sentinel.service

systemctl --no-pager --full status excalidash-pipeline-sentinel.timer
systemctl --no-pager --full status excalidash-pipeline-sentinel-guard.timer

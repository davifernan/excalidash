#!/usr/bin/env bash

set -euo pipefail

if [[ $(id -u) -ne 0 ]]; then
  echo "Run this installer as root." >&2
  exit 1
fi

repo_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
unit_root=/etc/systemd/system

install -m 0644 \
  "$repo_root/ops/systemd/excalidash-deployment-drift.service" \
  "$unit_root/excalidash-deployment-drift.service"
install -m 0644 \
  "$repo_root/ops/systemd/excalidash-deployment-drift.timer" \
  "$unit_root/excalidash-deployment-drift.timer"

systemctl daemon-reload
systemctl enable --now excalidash-deployment-drift.timer
systemctl start excalidash-deployment-drift.service

systemctl --no-pager --full status excalidash-deployment-drift.timer

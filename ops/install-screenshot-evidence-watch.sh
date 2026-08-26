#!/usr/bin/env bash

set -euo pipefail

if [[ $(id -u) -ne 0 ]]; then
  echo "Run this installer as root." >&2
  exit 1
fi

repo_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
unit_root=/etc/systemd/system

install -m 0644 \
  "$repo_root/ops/systemd/excalidash-screenshot-evidence.service" \
  "$unit_root/excalidash-screenshot-evidence.service"
install -m 0644 \
  "$repo_root/ops/systemd/excalidash-screenshot-evidence.timer" \
  "$unit_root/excalidash-screenshot-evidence.timer"

systemctl daemon-reload
systemctl enable --now excalidash-screenshot-evidence.timer
systemctl start excalidash-screenshot-evidence.service

systemctl --no-pager --full status excalidash-screenshot-evidence.timer

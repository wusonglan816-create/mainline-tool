#!/usr/bin/env bash
set -euo pipefail

PROJECT_DIR="/home/wsl/Work_space/mainline-tool"

bash "$PROJECT_DIR/stop-mainline-tool.sh" || true
sleep 1
bash "$PROJECT_DIR/start-mainline-tool.sh"

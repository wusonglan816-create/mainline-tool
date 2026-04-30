#!/usr/bin/env bash
set -euo pipefail

PROJECT_DIR="/home/wsl/Work_space/mainline-tool"

cd "$PROJECT_DIR"

nohup npm run server >/tmp/mainline-tool-backend.log 2>&1 &
nohup npm run dev -- --host 0.0.0.0 >/tmp/mainline-tool-frontend.log 2>&1 &

echo "Mainline Tool started."
echo "Backend log: /tmp/mainline-tool-backend.log"
echo "Frontend log: /tmp/mainline-tool-frontend.log"

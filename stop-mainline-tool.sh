#!/usr/bin/env bash
set -euo pipefail

PROJECT_DIR="/home/wsl/Work_space/mainline-tool"

pgrep -af "$PROJECT_DIR" | grep -E 'vite|server.js' | awk '{print $1}' | xargs -r kill

echo "Mainline Tool stop signal sent."

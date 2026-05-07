#!/usr/bin/env bash
set -euo pipefail

PROJECT_DIR="/home/wsl/Work_space/mainline-tool"

PIDS_TO_KILL=()

while IFS= read -r pid; do
  [[ -n "$pid" ]] || continue

  cmdline="$(tr '\0' ' ' <"/proc/$pid/cmdline" 2>/dev/null || true)"
  cwd="$(readlink -f "/proc/$pid/cwd" 2>/dev/null || true)"

  if [[ "$cmdline" =~ (vite|server\.js|npm\ run\ server|npm\ run\ dev) ]] && [[ "$cwd" == "$PROJECT_DIR" || "$cmdline" == *"$PROJECT_DIR"* ]]; then
    PIDS_TO_KILL+=("$pid")
  fi
done < <(pgrep -f 'vite|server\.js|npm run server|npm run dev' || true)

if [[ "${#PIDS_TO_KILL[@]}" -gt 0 ]]; then
  kill "${PIDS_TO_KILL[@]}"
fi

echo "Mainline Tool stop signal sent."

@echo off
setlocal

set "WSL_PROJECT_DIR=/home/wsl/Work_space/mainline-tool"

echo Stopping Mainline Tool backend and frontend...
wsl.exe bash -lc "PROJECT_DIR='%WSL_PROJECT_DIR%'; pgrep -af \"$PROJECT_DIR\" | grep -E \"vite|server.js\" | awk '{print \$1}' | xargs -r kill"

echo Stop command sent.
pause

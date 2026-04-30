@echo off
setlocal

set "WSL_PROJECT_DIR=/home/wsl/Work_space/mainline-tool"

echo Starting Mainline Tool backend...
start "Mainline Tool Backend" cmd /k wsl.exe bash -lc "cd %WSL_PROJECT_DIR% && npm run server"

echo Starting Mainline Tool frontend...
start "Mainline Tool Frontend" cmd /k wsl.exe bash -lc "cd %WSL_PROJECT_DIR% && npm run dev -- --host 0.0.0.0"

echo.
echo Backend: http://localhost:3001
echo Frontend: http://localhost:5173
echo.
echo If Vite chooses another port, use the frontend terminal output.
pause

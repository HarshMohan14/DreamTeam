@echo off
setlocal
cd /d "%~dp0"
title Dream Team - local dev server

where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo  Node.js is not installed on this computer.
  echo  Install Node.js 22.13 or newer from https://nodejs.org and run this file again.
  echo.
  pause
  exit /b 1
)

for /f "tokens=1,2 delims=v." %%a in ('node -v') do (set NODE_MAJOR=%%a& set NODE_MINOR=%%b)
echo Using Node %NODE_MAJOR%.%NODE_MINOR%
if %NODE_MAJOR% LSS 22 goto oldnode
if %NODE_MAJOR% EQU 22 if %NODE_MINOR% LSS 13 goto oldnode
goto nodeok
:oldnode
echo.
echo  This app needs Node.js 22.13 or newer. Please update from https://nodejs.org
echo.
pause
exit /b 1
:nodeok

if not exist node_modules\vite (
  echo.
  echo Installing dependencies - first run only, takes a minute...
  call npm install
  if errorlevel 1 (
    echo.
    echo  npm install failed - see the messages above.
    pause
    exit /b 1
  )
)

if not exist .env if exist .env.example (
  echo Creating .env for local testing...
  powershell -NoProfile -Command "(Get-Content .env.example) -replace '^GOOGLE_CLIENT_ID=.*','GOOGLE_CLIENT_ID=' | Set-Content .env"
)

echo.
echo  Starting Dream Team...
echo    App:    http://localhost:5173
echo    Server: http://localhost:8787
echo  Close this window (or press Ctrl+C) to stop the app.
echo.
start "" /min cmd /c "timeout /t 8 /nobreak >nul & start http://localhost:5173"
call npm run dev
pause

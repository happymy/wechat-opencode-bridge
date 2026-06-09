@echo off
cd /d %~dp0
set "SCRIPT_DIR=%CD%"

echo ==========================================
echo   Starting all services...
echo ==========================================
echo.

echo [1/4] Starting OpenCode Web Server (Official Web UI) on port 4096...
start "opencode-web" pwsh -NoLogo -Command "$env:OPENCODE_SERVER_PASSWORD='opencode'; opencode web --hostname 0.0.0.0 --port 4096"

echo  Waiting for port 4096...
:wait_4096
timeout /t 2 /nobreak >nul
netstat -an | findstr ":4096 " | findstr LISTENING >nul 2>&1
if errorlevel 1 goto wait_4096
echo  [OK] OpenCode Web Server is ready.
echo.

echo [2/4] Starting pk-opencode-webui (Third-party Web UI) on port 2048...
start "pk-opencode-webui" pwsh -NoLogo -Command "cd '%SCRIPT_DIR%\pk-opencode-webui\app-prefixable'; $env:PORT='2048'; $env:API_AUTH_USERNAME='opencode'; $env:API_AUTH_PASSWORD='opencode'; bun run dev"

echo  Waiting for port 2048...
:wait_2048
timeout /t 2 /nobreak >nul
netstat -an | findstr ":2048 " | findstr LISTENING >nul 2>&1
if errorlevel 1 goto wait_2048
echo  [OK] pk-opencode-webui is ready.
echo.

echo [3/4] Starting WeChat bridge...
call npx wechat-acp@latest stop >nul 2>&1
start "wechat-bridge" pwsh -NoLogo -Command "npx -y wechat-acp@latest --agent 'node wechat-adapter.js' --cwd '%SCRIPT_DIR%'"

echo  Waiting for WeChat login...
:wait_wechat
timeout /t 3 /nobreak >nul
if exist "%USERPROFILE%\.wechat-acp\token.json" (
  echo  [OK] WeChat bridge is logged in.
) else (
  echo  Please scan the QR code in the new terminal window...
  goto wait_wechat
)
echo.

echo [4/4] Starting terminal attach...
start "opencode-tui" pwsh -NoLogo -Command "$env:OPENCODE_SERVER_PASSWORD='opencode'; opencode attach http://localhost:4096 -c"
echo  [OK] Terminal TUI attached.
echo.

echo ==========================================
echo  All services started successfully!
echo ==========================================
echo.
echo  Official Web UI:     http://localhost:4096
echo  Username: opencode
echo  Password: opencode
echo.
echo  pk-opencode-webui:   http://localhost:2048
echo  (no auth needed - connects to 4096 as API backend)
echo.
echo  Terminal TUI:        attached to same server
echo  WeChat bot:          shares sessions with all UIs
echo.
echo  Stop all:            stop-all.bat
echo.

pause

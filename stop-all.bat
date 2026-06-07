@echo off
cd /d %~dp0

echo ==========================================
echo   Stopping all services...
echo ==========================================
echo.

echo [1/6] Stopping WeChat bridge (graceful)...
call npx wechat-acp@latest stop 2>nul
timeout /t 2 /nobreak >nul

echo  Killing any remaining wechat-acp node processes...
wmic process where "name='node.exe'" get ProcessId,CommandLine 2>nul | findstr /i "wechat-acp wechat-adapter" >nul 2>&1
if not errorlevel 1 (
  for /f "tokens=1" %%p in ('wmic process where "name='node.exe'" get ProcessId,CommandLine 2^>nul ^| findstr /i "wechat-acp wechat-adapter"') do (
    taskkill /f /pid %%p >nul 2>&1
  )
)
echo  [OK] WeChat bridge stopped.
echo.

echo [2/6] Stopping opencode processes...
taskkill /f /fi "WINDOWTITLE eq opencode-web" >nul 2>&1
taskkill /f /fi "WINDOWTITLE eq opencode-tui" >nul 2>&1
taskkill /f /im opencode.exe >nul 2>&1
echo  [OK] opencode processes stopped.
echo.

echo [3/6] Stopping bun (pk-opencode-webui)...
taskkill /f /fi "WINDOWTITLE eq pk-opencode-webui" >nul 2>&1
taskkill /f /im bun.exe >nul 2>&1
echo  [OK] bun processes stopped.
echo.

echo [4/6] Freeing port 4096...
for /f "tokens=5" %%p in ('netstat -ano ^| findstr ":4096 " ^| findstr LISTENING') do (
  echo  Killing PID %%p on port 4096
  taskkill /f /pid %%p >nul 2>&1
)
echo  [OK] Port 4096 freed.
echo.

echo [5/6] Freeing port 2048...
for /f "tokens=5" %%p in ('netstat -ano ^| findstr ":2048 " ^| findstr LISTENING') do (
  echo  Killing PID %%p on port 2048
  taskkill /f /pid %%p >nul 2>&1
)
echo  [OK] Port 2048 freed.
echo.

echo [6/6] Cleaning up WeChat temp files...
del "%USERPROFILE%\.wechat-acp\sync-buf.json" 2>nul
echo  [OK] Cleanup done.
echo.

echo ==========================================
echo  All services stopped
echo ==========================================
echo.
echo  Run start-all.bat to restart.
echo.

pause

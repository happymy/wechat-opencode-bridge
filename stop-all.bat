@echo off
cd /d %~dp0

echo ==========================================
echo   Stopping all services...
echo ==========================================
echo.

echo [1/7] Stopping opencode processes (force kill process tree)...
taskkill /f /im opencode.exe /t >nul 2>&1
timeout /t 1 /nobreak >nul
taskkill /f /im opencode.exe /t >nul 2>&1
echo  [OK] opencode processes stopped.

echo  Cleaning up orphaned pwsh console windows...
taskkill /fi "WINDOWTITLE eq opencode-web" /f >nul 2>&1
taskkill /fi "WINDOWTITLE eq opencode-tui" /f >nul 2>&1
echo  [OK] Console windows cleaned.
echo.

echo [2/7] Stopping bun (pk-opencode-webui)...
taskkill /f /fi "WINDOWTITLE eq pk-opencode-webui" >nul 2>&1
taskkill /f /im bun.exe >nul 2>&1
echo  [OK] bun/pk-opencode-webui stopped.
echo.

echo [3/7] Cleaning up orphaned MCP child processes...
taskkill /f /im uvx.exe >nul 2>&1
for /f "skip=1 tokens=*" %%p in ('wmic process where "name='node.exe'" get ProcessId 2^>nul') do (
  for /f "tokens=*" %%q in ("%%p") do if not "%%q"=="" (
    wmic process where "ProcessId=%%q" get CommandLine /format:value 2>nul | findstr /i "mcp" >nul
    if not errorlevel 1 taskkill /f /pid %%q >nul 2>&1
  )
)
taskkill /f /im docker.exe >nul 2>&1
echo  [OK] Orphaned MCP processes cleaned.
echo.

echo [4/7] Freeing port 4096...
set "PORT=4096"
set "MAX_RETRIES=10"
set "RETRY_COUNT=0"

:retry_port
set /a RETRY_COUNT+=1
if %RETRY_COUNT% gtr %MAX_RETRIES% (
  echo  [WARN] Port 4096 still occupied after %MAX_RETRIES% attempts.
  goto :port_force
)
for /f "tokens=5" %%p in ('netstat -ano ^| findstr ":4096 " ^| findstr LISTENING') do (
  echo  PID %%p is listening on port 4096, force killing...
  taskkill /f /t /pid %%p >nul 2>&1
  timeout /t 2 /nobreak >nul
  goto retry_port
)
echo  [OK] Port 4096 is free.
goto :port_done

:port_force
echo  Trying to kill any process via image name...
taskkill /f /im opencode.exe /t >nul 2>&1
timeout /t 2 /nobreak >nul
for /f "tokens=5" %%p in ('netstat -ano ^| findstr ":4096 " ^| findstr LISTENING') do (
  echo  [WARN] Port 4096 STILL held by PID %%p. This may require admin rights.
)
:port_done
echo.

echo [5/7] Freeing port 2048...
for /f "tokens=5" %%p in ('netstat -ano ^| findstr ":2048 " ^| findstr LISTENING') do (
  taskkill /f /t /pid %%p >nul 2>&1
)
echo  [OK] Port 2048 freed.
echo.

echo [6/7] Stopping WeChat bridge...
call npx wechat-acp@latest stop 2>nul
timeout /t 2 /nobreak >nul

echo  Killing any remaining wechat-acp node processes...
for /f "skip=1 tokens=*" %%p in ('wmic process where "name='node.exe'" get ProcessId 2^>nul') do (
  for /f "tokens=*" %%q in ("%%p") do if not "%%q"=="" (
    wmic process where "ProcessId=%%q" get CommandLine /format:value 2>nul | findstr /i "wechat-acp wechat-adapter" >nul
    if not errorlevel 1 taskkill /f /pid %%q >nul 2>&1
  )
)
echo  [OK] WeChat bridge stopped.
echo.

echo [7/7] Cleaning up stale files...
del "%USERPROFILE%\.wechat-acp\sync-buf.json" 2>nul
if exist "%LOCALAPPDATA%\opencode\opencode.db-wal" (
  echo  Cleaning stale SQLite WAL...
  del "%LOCALAPPDATA%\opencode\opencode.db-wal" 2>nul
  del "%LOCALAPPDATA%\opencode\opencode.db-shm" 2>nul
)
if exist "%USERPROFILE%\.local\share\opencode\opencode.db-wal" (
  echo  Cleaning stale SQLite WAL...
  del "%USERPROFILE%\.local\share\opencode\opencode.db-wal" 2>nul
  del "%USERPROFILE%\.local\share\opencode\opencode.db-shm" 2>nul
)
echo  [OK] Cleanup done.
echo.

echo ==========================================
echo  All services stopped
echo ==========================================
echo.
echo  Run start-all.bat to restart.
echo.

pause

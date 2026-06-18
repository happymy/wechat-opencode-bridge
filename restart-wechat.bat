@echo off
cd /d %~dp0
set "SCRIPT_DIR=%CD%"

echo ==========================================
echo   Restarting WeChat Bridge
echo ==========================================
echo.

echo [1/3] Stopping WeChat bridge (graceful)...
call npx wechat-acp@latest stop 2>nul
timeout /t 2 /nobreak >nul

echo  Killing any remaining wechat-acp node processes...
for /f "skip=1 tokens=*" %%p in ('wmic process where "name='node.exe' and (commandline like '%%wechat-acp%%' or commandline like '%%wechat-adapter%%')" get processid 2^>nul') do (
  for /f "tokens=*" %%q in ("%%p") do (
    if not "%%q"=="" taskkill /f /pid %%q >nul 2>&1
  )
)
echo  [OK] Stopped.
echo.

echo [2/3] Starting WeChat bridge...
start "wechat-bridge" pwsh -NoLogo -Command "npx -y wechat-acp@latest --agent 'node wechat-adapter.js' --cwd '%SCRIPT_DIR%'"
echo  [OK] Started.
echo.

echo [3/3] Waiting for WeChat login...
:wait_wechat
timeout /t 3 /nobreak >nul
if exist "%USERPROFILE%\.wechat-acp\token.json" (
  echo  [OK] WeChat bridge is logged in.
) else (
  echo  Please scan the QR code in the new terminal window...
  goto wait_wechat
)
echo.

echo ==========================================
echo  Restart complete! WeChat bridge is ready.
echo ==========================================

echo ok

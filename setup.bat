@echo off
cd /d %~dp0
setlocal enabledelayedexpansion
set "SCRIPT_DIR=%CD%"

echo ==========================================
echo   Work workspace - Environment Setup
echo ==========================================
echo.

:: --- 0. pwsh (PowerShell 7+) ---
echo [1/7] Checking PowerShell 7+...
where pwsh >nul 2>&1
if errorlevel 1 (
    echo  ! pwsh not found, installing via winget...
    winget install Microsoft.PowerShell -e --accept-source-agreements --accept-package-agreements >nul 2>&1
    if errorlevel 1 (
        echo  [FAIL] pwsh install failed. Download from https://github.com/PowerShell/PowerShell/releases
        pause
        exit /b 1
    ) else (
        echo  [OK] PowerShell 7+ installed
    )
) else (
    for /f "tokens=*" %%v in ('pwsh -NoLogo -Command "$PSVersionTable.PSVersion"') do echo  [OK] PowerShell %%v
)
echo.

:: --- 1. Node.js ---
echo [2/7] Checking Node.js...
where node >nul 2>&1
if errorlevel 1 (
    echo  ! Node.js not found, installing via winget...
    winget install OpenJS.NodeJS.LTS -e --accept-source-agreements --accept-package-agreements >nul 2>&1
    if errorlevel 1 (
        echo  [FAIL] Node.js install failed. Download from https://nodejs.org
    ) else (
        echo  [OK] Node.js installed
    )
) else (
    for /f "tokens=*" %%v in ('node --version') do echo  [OK] Node.js %%v
)
echo.

:: --- 2. npm deps ---
echo [3/7] Installing workspace npm dependencies...
call npm install --ignore-scripts 2>&1
if errorlevel 1 (
    echo  [FAIL] npm install failed
) else (
    echo  [OK] npm dependencies installed
)
echo.

:: --- 3. Bun ---
echo [4/7] Checking Bun...
where bun >nul 2>&1
if errorlevel 1 (
    echo  ! Bun not found, installing...
    pwsh -NoLogo -Command "powershell -c 'iwr bun.sh/install -useb | iex'" >nul 2>&1
    if errorlevel 1 (
        echo  [FAIL] Bun install failed. Manual: https://bun.sh
    ) else (
        echo  [OK] Bun installed
    )
) else (
    for /f "tokens=*" %%v in ('bun --version') do echo  [OK] Bun %%v
)
echo.

:: --- 4. pk-opencode-webui ---
echo [5/7] Installing pk-opencode-webui dependencies...
if not exist "%SCRIPT_DIR%\pk-opencode-webui\app-prefixable\package.json" (
    echo  [!] pk-opencode-webui not found, cloning from GitHub...
    where git >nul 2>&1
    if errorlevel 1 (
        echo  [FAIL] Git not found. Install Git or manually clone:
        echo         git clone https://github.com/prokube/pk-opencode-webui.git "%SCRIPT_DIR%\pk-opencode-webui"
        pause
        exit /b 1
    )
    git clone https://github.com/prokube/pk-opencode-webui.git "%SCRIPT_DIR%\pk-opencode-webui" 2>&1
    if errorlevel 1 (
        echo  [FAIL] git clone failed. Check network or clone manually.
        pause
        exit /b 1
    )
    echo  [OK] pk-opencode-webui cloned
)
pushd "%SCRIPT_DIR%\pk-opencode-webui\app-prefixable"
call bun install 2>&1
if errorlevel 1 (
    echo  [FAIL] bun install failed
    popd
    pause
    exit /b 1
) else (
    echo  [OK] pk-opencode-webui dependencies installed
)
popd
echo.

:: --- 5. opencode CLI ---
echo [6/7] Checking opencode CLI...
where opencode >nul 2>&1
if errorlevel 1 (
    echo  ! opencode not found, installing...
    call npm install -g @opencode-ai/cli 2>&1
    if errorlevel 1 (
        echo  [FAIL] opencode install failed
    ) else (
        echo  [OK] opencode installed
    )
) else (
    for /f "tokens=*" %%v in ('opencode --version') do echo  [OK] opencode %%v
)
echo.

:: --- 6. wechat-acp ---
echo [7/7] Refreshing wechat-acp...
pwsh -NoLogo -Command "$c='$env:LOCALAPPDATA\npm-cache\_npx';if(Test-Path $c){Remove-Item -Recurse -Force \"$c\*\" -ErrorAction SilentlyContinue}"
call npx -y wechat-acp@latest --version 2>&1
if errorlevel 1 (
    echo  [FAIL] wechat-acp download failed
) else (
    echo  [OK] wechat-acp refreshed
)
echo.

echo ==========================================
echo   Setup complete! Run start-all.bat
echo ==========================================
pause

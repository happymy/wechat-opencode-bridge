@echo off
cd /d %~dp0
setlocal enabledelayedexpansion
set "SCRIPT_DIR=%CD%"

echo ==========================================
echo   Work workspace - Environment Setup
echo ==========================================
echo.

:: --- 0. pwsh (PowerShell 7+) — needed for version lock loading ---
echo [0] Checking PowerShell 7+...
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
)
echo.

:: --- Load locked versions from .tool-versions.json ---
echo [  ] Loading version locks...
for /f "tokens=*" %%v in ('pwsh -NoLogo -Command "$PSVersionTable.PSVersion.ToString()"') do set "PWSH_VER=%%v"
:: Generate temp PowerShell script to avoid cmd.exe pipe/quoting issues
>"%TEMP%\load-vers.ps1" (
  echo $c = Get-Content '.tool-versions.json' -Raw ^| ConvertFrom-Json
  echo echo ('LOCKED_NODE=' + $c.runtime.node^)
  echo echo ('LOCKED_NPM=' + $c.runtime.npm^)
  echo echo ('LOCKED_BUN=' + $c.runtime.bun^)
  echo echo ('LOCKED_PWSH=' + $c.shell.pwsh^)
  echo echo ('LOCKED_PYTHON=' + $c.script.python^)
  echo echo ('LOCKED_GIT=' + $c.vcs.git^)
  echo echo ('LOCKED_OPENCODE_CLI=' + $c.opencode.cli^)
  echo echo ('LOCKED_WECHAT_ACP=' + $c.wechat.acp^)
  echo echo ('LOCKED_WEBUI_REMOTE=' + $c.repos.'pk-opencode-webui'.remote^)
  echo echo ('LOCKED_WEBUI_HEAD=' + $c.repos.'pk-opencode-webui'.head^)
)
for /f "delims=" %%v in ('pwsh -NoLogo -File "%TEMP%\load-vers.ps1"') do set %%v
del "%TEMP%\load-vers.ps1"
if not "!PWSH_VER!"=="%LOCKED_PWSH%" (
    echo  [WARN] PowerShell version !PWSH_VER! 不匹配锁定版本 %LOCKED_PWSH%
)
echo   [OK] Version locks loaded
echo.

:: --- 1. Node.js ---
echo [1/7] Checking Node.js...
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
    for /f "tokens=*" %%v in ('node --version') do set "NODE_VER=%%v"
    echo  [OK] Node.js !NODE_VER!  (locked: v%LOCKED_NODE%^)
    if not "!NODE_VER!"=="v%LOCKED_NODE%" (
        echo  [WARN] Version mismatch, expected v%LOCKED_NODE%
    )
)
echo.

:: --- 2. npm deps ---
echo [2/7] Installing workspace npm dependencies...
call npm install --ignore-scripts 2>&1
if errorlevel 1 (
    echo  [FAIL] npm install failed
) else (
    echo  [OK] npm dependencies installed
)
echo.

:: --- 3. Bun ---
echo [3/7] Checking Bun...
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
    for /f "tokens=*" %%v in ('bun --version') do set "BUN_VER=%%v"
    echo  [OK] Bun !BUN_VER!  (locked: %LOCKED_BUN%^)
    if not "!BUN_VER!"=="%LOCKED_BUN%" (
        echo  [WARN] Version mismatch, expected %LOCKED_BUN%
    )
)
echo.

:: --- 4. pk-opencode-webui (version locked) ---
echo [4/7] Installing pk-opencode-webui...

:check_webui
if exist "%SCRIPT_DIR%\pk-opencode-webui\app-prefixable\package.json" (
    pushd "%SCRIPT_DIR%\pk-opencode-webui"
    for /f "tokens=*" %%v in ('git rev-parse HEAD') do set "WEBUI_HEAD=%%v"
    echo  [OK] pk-opencode-webui found, HEAD !WEBUI_HEAD!
    if not "!WEBUI_HEAD!"=="%LOCKED_WEBUI_HEAD%" (
        echo  ! HEAD mismatch, checking out locked version...
        git fetch origin 2>&1
        git checkout %LOCKED_WEBUI_HEAD% 2>&1
        if errorlevel 1 (
            echo  [FAIL] Failed to checkout locked commit
            pause
            exit /b 1
        )
        echo  [OK] Checked out locked commit
    )
    popd
    goto :webui_deps
)

echo  ! pk-opencode-webui not found, cloning from GitHub...
where git >nul 2>&1
if errorlevel 1 (
    echo  [FAIL] Git not found. Install Git or manually clone:
    echo         git clone %LOCKED_WEBUI_REMOTE% "%SCRIPT_DIR%\pk-opencode-webui"
    pause
    exit /b 1
)
git clone %LOCKED_WEBUI_REMOTE% "%SCRIPT_DIR%\pk-opencode-webui" 2>&1
if errorlevel 1 (
    echo  [FAIL] git clone failed. Check network or clone manually.
    pause
    exit /b 1
)
echo  [OK] pk-opencode-webui cloned

:: Lock to specific commit
pushd "%SCRIPT_DIR%\pk-opencode-webui"
git checkout %LOCKED_WEBUI_HEAD% 2>&1
if errorlevel 1 (
    echo  [FAIL] Failed to checkout locked commit %LOCKED_WEBUI_HEAD%
    pause
    exit /b 1
)
echo  [OK] Locked to commit %LOCKED_WEBUI_HEAD%
popd

:webui_deps
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

:: --- 5. opencode CLI (version locked) ---
echo [5/7] Checking opencode CLI...
where opencode >nul 2>&1
if errorlevel 1 (
    echo  ! opencode not found, installing v%LOCKED_OPENCODE_CLI%...
    call npm install -g opencode-windows-x64@%LOCKED_OPENCODE_CLI% 2>&1
    if errorlevel 1 (
        echo  [FAIL] opencode install failed
    ) else (
        echo  [OK] opencode v%LOCKED_OPENCODE_CLI% installed
    )
) else (
    for /f "tokens=*" %%v in ('opencode --version') do set "OPENCODE_VER=%%v"
    if "!OPENCODE_VER!"=="%LOCKED_OPENCODE_CLI%" (
        echo  [OK] opencode !OPENCODE_VER!
    ) else (
        echo  [WARN] opencode 版本 !OPENCODE_VER! 不匹配锁定版本 %LOCKED_OPENCODE_CLI%
    )
)
echo.

:: --- 6. wechat-acp (version locked) ---
echo [6/7] Refreshing wechat-acp (v%LOCKED_WECHAT_ACP%)...
pwsh -NoLogo -Command "$c='$env:LOCALAPPDATA\npm-cache\_npx';if(Test-Path $c){Remove-Item -Recurse -Force \"$c\*\" -ErrorAction SilentlyContinue}"
call npx -y wechat-acp@%LOCKED_WECHAT_ACP% --version 2>&1
if errorlevel 1 (
    echo  [FAIL] wechat-acp download failed
) else (
    echo  [OK] wechat-acp v%LOCKED_WECHAT_ACP% refreshed
)
echo.

echo ==========================================
echo   Setup complete! Run start-all.bat
echo ==========================================
echo   Version locks from .tool-versions.json:
echo     Node.js     %LOCKED_NODE%
echo     npm         %LOCKED_NPM%
echo     Bun         %LOCKED_BUN%
echo     PowerShell  %LOCKED_PWSH%
echo     Python      %LOCKED_PYTHON%
echo     Git         %LOCKED_GIT%
echo     opencode    %LOCKED_OPENCODE_CLI%
echo     wechat-acp  %LOCKED_WECHAT_ACP%
echo     pk-opencode-webui %LOCKED_WEBUI_HEAD:~0,8%...
echo ==========================================
pause

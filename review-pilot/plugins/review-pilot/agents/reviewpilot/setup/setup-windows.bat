@echo off
:: ============================================================
::  Review Pilot — Windows (Command Prompt fallback)
::  Run this if you cannot use PowerShell.
::  Recommended: use setup-windows.ps1 for full automation.
:: ============================================================
setlocal enabledelayedexpansion
title Review Pilot Setup

echo.
echo   ============================================================
echo    REVIEW PILOT -- Windows Installer (CMD)
echo   ============================================================
echo.

:: ── Working dirs ────────────────────────────────────────────
set "SCRIPT_DIR=%~dp0"
:: Remove trailing backslash
set "SCRIPT_DIR=%SCRIPT_DIR:~0,-1%"
for %%I in ("%SCRIPT_DIR%\..") do set "AGENT_DIR=%%~fI"
set "TARGET_DIR=%USERPROFILE%\.claude\agents\reviewpilot"
set "LOGS_DIR=%TARGET_DIR%\logs"

echo   Agent source : %AGENT_DIR%
echo   Install dest : %TARGET_DIR%
echo.

:: ── Step 1: Git ─────────────────────────────────────────────
echo [Step 1] Checking Git...
where git >nul 2>&1
if %errorlevel%==0 (
    for /f "tokens=*" %%v in ('git --version') do echo   OK  %%v
) else (
    echo   !! Git not found.
    echo      Download from: https://git-scm.com/download/win
    echo      Install Git, restart this window, then re-run setup.
    goto :missing_prereq
)

:: ── Step 2: Node.js ─────────────────────────────────────────
echo.
echo [Step 2] Checking Node.js (need >= 16)...
where node >nul 2>&1
if %errorlevel% neq 0 (
    echo   !! Node.js not found.
    echo      Download LTS from: https://nodejs.org/en/download
    echo      Install Node.js, restart this window, then re-run setup.
    goto :missing_prereq
)
for /f "tokens=*" %%v in ('node --version') do set NODE_VER=%%v
echo   OK  Node.js %NODE_VER%

:: ── Step 3: Claude Code CLI ────────────────────────────────
echo.
echo [Step 3] Checking Claude Code CLI...
where claude >nul 2>&1
if %errorlevel% neq 0 (
    echo   !! Claude Code CLI not found.
    echo.
    echo      Install via npm (in a new window after Node is ready):
    echo        npm install -g @anthropic-ai/claude-code
    echo.
    echo      Or download from:
    echo        https://docs.anthropic.com/en/docs/claude-code/quickstart
    echo.
    echo   Press any key once Claude Code is installed, or Ctrl+C to abort.
    pause >nul
    where claude >nul 2>&1
    if !errorlevel! neq 0 (
        echo   XX Claude CLI still not found. Add it to PATH and try again.
        goto :missing_prereq
    )
)
for /f "tokens=*" %%v in ('claude --version 2^>nul') do (
    echo   OK  Claude Code CLI: %%v
    goto :claude_ok
)
:claude_ok

:: ── Step 4: Install files ───────────────────────────────────
echo.
echo [Step 4] Installing Review Pilot to %TARGET_DIR% ...
if not exist "%USERPROFILE%\.claude\agents" (
    mkdir "%USERPROFILE%\.claude\agents"
)

:: Compare resolved paths
if /i "%AGENT_DIR%"=="%TARGET_DIR%" (
    echo   OK  Already at target location.
) else (
    if not exist "%TARGET_DIR%" mkdir "%TARGET_DIR%"
    xcopy /E /I /Y /Q "%AGENT_DIR%\*" "%TARGET_DIR%\" >nul
    echo   OK  Files copied to %TARGET_DIR%
)

:: ── Step 5: Logs dir ────────────────────────────────────────
echo.
echo [Step 5] Creating logs directory...
if not exist "%LOGS_DIR%" mkdir "%LOGS_DIR%"
echo   OK  %LOGS_DIR%

:: ── Step 6: Syntax check ────────────────────────────────────
echo.
echo [Step 6] Verifying scripts...
node --check "%TARGET_DIR%\server.js" >nul 2>&1
if %errorlevel%==0 ( echo   OK  server.js ) else ( echo   !! server.js syntax error )
node --check "%TARGET_DIR%\scripts\collect_review_scope.js" >nul 2>&1
if %errorlevel%==0 ( echo   OK  collect_review_scope.js ) else ( echo   !! collect_review_scope.js syntax error )

:: ── Step 7: Start server ────────────────────────────────────
echo.
echo [Step 7] Start server?
echo   To start the Review Pilot server manually, run:
echo     node "%TARGET_DIR%\server.js"
echo   Then open: http://localhost:3922
echo.
set /p START_NOW=  Start the server now? [y/N]:
if /i "%START_NOW%"=="y" (
    start "" /b node "%TARGET_DIR%\server.js" > "%LOGS_DIR%\server-startup.log" 2>&1
    timeout /t 2 /nobreak >nul
    start "" "http://localhost:3922"
    echo   OK  Server started. Browser opening...
)

:: ── Done ────────────────────────────────────────────────────
echo.
echo   ============================================================
echo    Review Pilot installed successfully!
echo.
echo    Quick start:
echo      1. Open a project in Claude Code CLI / IDE
echo      2. Type:  $reviewpilot  (or  /reviewpilot)
echo      3. Browser UI opens — pick role, base branch, Start Review
echo.
echo    Manual invocation:
echo      $reviewpilot Review UI developer changes against master
echo.
echo    Logs: %LOGS_DIR%
echo   ============================================================
echo.
goto :eof

:missing_prereq
echo.
echo   !! One or more prerequisites are missing.
echo      Install the missing tools listed above, then re-run this script.
echo.
pause
exit /b 1

@echo off
setlocal EnableDelayedExpansion

set PORT=3922
set SERVER=%~dp0..\server.js
set URL=http://localhost:%PORT%
set LOG=%TEMP%\reviewpilot-server.log

:: ── Health check (curl with PowerShell fallback) ─────────────────────────────
:: Sets HEALTH_OK=1 if server responds, 0 otherwise.
goto :main

:health_check
set HEALTH_OK=0
curl -s --max-time 1 "%URL%/health" >nul 2>&1
if %errorlevel% == 0 ( set HEALTH_OK=1 & goto :eof )
powershell -NoProfile -Command "try{$r=(iwr '%URL%/health' -UseBasicParsing -TimeoutSec 1).StatusCode;if($r -eq 200){exit 0}}catch{};exit 1" >nul 2>&1
if %errorlevel% == 0 set HEALTH_OK=1
goto :eof

:: ── Main ─────────────────────────────────────────────────────────────────────
:main
call :health_check
if "%HEALTH_OK%"=="1" (
    echo ALREADY_RUNNING
    goto open_browser
)

if not exist "%SERVER%" (
    echo SERVER_NOT_FOUND:%SERVER%
    exit /b 1
)

start /b node "%SERVER%" > "%LOG%" 2>&1

for /l %%i in (1,1,5) do (
    timeout /t 1 /nobreak >nul
    call :health_check
    if "!HEALTH_OK!"=="1" (
        echo STARTED
        goto open_browser
    )
)

echo FAILED
exit /b 1

:open_browser
start "" "%URL%"
echo OPENED

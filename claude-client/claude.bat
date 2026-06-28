@echo off
:: Claude terminal chat — batch + PowerShell only, no extra dependencies
::
:: Usage:
::   Double-click claude.bat   -- opens terminal, stays open until you type 'exit'
::   claude.bat --no-tools     -- pure chat, no tools

setlocal enabledelayedexpansion

:: ── allowed tools (pre-approved, no runtime permission prompt) ─────────────
set "ALLOWED_TOOLS=Read,Write,Edit,MultiEdit,Bash,LS,Glob,Grep,WebSearch,WebFetch,TodoRead,TodoWrite,NotebookRead,NotebookEdit"

:: ── blocked patterns (always denied) ──────────────────────────────────────
set "DISALLOWED_TOOLS=Bash(git commit *),Bash(git push *),Bash(git merge *),Bash(git rebase *),Bash(git reset *),Bash(git clean *),Bash(git branch -D *),Bash(git branch -d *),Bash(git checkout -- *),Bash(git restore *),Bash(gh *),Bash(rm -rf *),Bash(rm -f *),Bash(rmdir *)"
:: ──────────────────────────────────────────────────────────────────────────

set "LOGFILE=%~dp0claude-chat.log"

:: --- detect claude command ---
set "CCMD="
where claude >nul 2>&1 && set "CCMD=claude"
if not defined CCMD (
    where npx >nul 2>&1
    if not errorlevel 1 (
        npx claude --version >nul 2>&1
        if not errorlevel 1 set "CCMD=npx claude"
    )
)
if not defined CCMD (
    echo Error: 'claude' CLI not found. Install from: https://claude.ai/code
    pause
    exit /b 1
)

:: --- flags ---
set "NO_TOOLS=false"
if /i "%~1"=="--no-tools" set "NO_TOOLS=true"

set "SESSION="
set "TMPD=%TEMP%\claudechat%RANDOM%"
mkdir "!TMPD!" 2>nul

:: --- write PowerShell parser to temp file (built-in to Windows, no Python needed) ---
:: Uses ConvertFrom-Json (built-in PS cmdlet) to safely parse JSON.
:: WriteAllBytes avoids BOM issues that Out-File/Set-Content can introduce.
(
    echo $enc = [System.Text.Encoding]::UTF8
    echo $sid = ''; $res = ''
    echo foreach ($line in [System.IO.File]::ReadLines('!TMPD!\out.txt', $enc^)^) {
    echo     try {
    echo         $o = $line ^| ConvertFrom-Json
    echo         if ($o.type -eq 'result'^) {
    echo             $sid = $o.session_id
    echo             $res = $o.result
    echo         }
    echo     } catch {}
    echo }
    echo [System.IO.File]::WriteAllBytes('!TMPD!\sid.txt', $enc.GetBytes($sid^)^)
    echo [System.IO.File]::WriteAllBytes('!TMPD!\res.txt', $enc.GetBytes($res^)^)
) > "!TMPD!\parse.ps1"

:: --- log session start ---
echo. >> "!LOGFILE!"
echo ======================================================== >> "!LOGFILE!"
echo SESSION START: %date% %time% >> "!LOGFILE!"
echo ======================================================== >> "!LOGFILE!"

:: --- banner ---
if "!NO_TOOLS!"=="true" (
    echo Claude Chat  ^|  tools: none  ^|  type 'exit' to quit
) else (
    echo Claude Chat  ^|  tools: all except destructive git/rm  ^|  type 'exit' to quit
)
echo Log: !LOGFILE!
echo.

:: ════════════════════════ main loop ════════════════════════
:loop
echo.
set "USER_IN="
set /p "USER_IN=You: "
if not defined USER_IN goto loop
if /i "!USER_IN!"=="exit" goto bye
if /i "!USER_IN!"=="quit" goto bye

echo [%date% %time%] You: !USER_IN! >> "!LOGFILE!"

:: write prompt to temp file (stdin pipe avoids --disallowedTools eating the prompt)
echo !USER_IN!> "!TMPD!\in.txt"

echo.
<nul set /p ="Claude: "

:: --- run claude via GOTO — keeps DISALLOWED_TOOLS out of IF-block parens ---
:: (cmd.exe misparses parentheses in "Bash(git commit *)" inside blocks)
if "!NO_TOOLS!"=="true" goto run_no_tools
if defined SESSION goto run_session_tools

!CCMD! --print --output-format stream-json --verbose --allowedTools "!ALLOWED_TOOLS!" --disallowedTools "!DISALLOWED_TOOLS!" < "!TMPD!\in.txt" > "!TMPD!\out.txt" 2>&1
goto parse

:run_session_tools
!CCMD! --print --output-format stream-json --verbose --resume "!SESSION!" --allowedTools "!ALLOWED_TOOLS!" --disallowedTools "!DISALLOWED_TOOLS!" < "!TMPD!\in.txt" > "!TMPD!\out.txt" 2>&1
goto parse

:run_no_tools
if defined SESSION (
    !CCMD! --print --output-format stream-json --verbose --resume "!SESSION!" --allowedTools "" < "!TMPD!\in.txt" > "!TMPD!\out.txt" 2>&1
) else (
    !CCMD! --print --output-format stream-json --verbose --allowedTools "" < "!TMPD!\in.txt" > "!TMPD!\out.txt" 2>&1
)

:parse
powershell -NoProfile -ExecutionPolicy Bypass -File "!TMPD!\parse.ps1"

:: read session id (UUID, always single-line, no BOM since we used WriteAllBytes)
set "SESSION="
set /p SESSION=<"!TMPD!\sid.txt"

:: check response is non-empty
for %%F in ("!TMPD!\res.txt") do if %%~zF==0 (
    echo.
    echo (no response - check that claude CLI is logged in^)
    echo [%date% %time%] Claude: (no response^) >> "!LOGFILE!"
    goto loop
)

type "!TMPD!\res.txt"
echo.

echo [%date% %time%] Claude: >> "!LOGFILE!"
type "!TMPD!\res.txt" >> "!LOGFILE!"
echo. >> "!LOGFILE!"

goto loop

:: ════════════════════════ exit ════════════════════════
:bye
rd /s /q "!TMPD!" 2>nul
echo ======================================================== >> "!LOGFILE!"
echo SESSION END: %date% %time% >> "!LOGFILE!"
echo ======================================================== >> "!LOGFILE!"
echo.
echo Goodbye! Log saved to: !LOGFILE!
echo.
pause

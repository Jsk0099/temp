@echo off
:: Claude terminal chat - batch + PowerShell only, no extra dependencies
::
:: Usage:
::   Double-click claude.bat   -- opens terminal, stays open until you type 'exit'
::   claude.bat --no-tools     -- pure chat, no tools

setlocal enabledelayedexpansion

:: allowed tools (pre-approved, no runtime permission prompt)
set "ALLOWED_TOOLS=Read,Write,Edit,MultiEdit,Bash,LS,Glob,Grep,WebSearch,WebFetch,TodoRead,TodoWrite,NotebookRead,NotebookEdit"

:: blocked patterns (always denied)
set "DISALLOWED_TOOLS=Bash(git commit *),Bash(git push *),Bash(git merge *),Bash(git rebase *),Bash(git reset *),Bash(git clean *),Bash(git branch -D *),Bash(git branch -d *),Bash(git checkout -- *),Bash(git restore *),Bash(gh *),Bash(rm -rf *),Bash(rm -f *),Bash(rmdir *)"

set "LOGFILE=%~dp0claude-chat.log"

echo. >> "!LOGFILE!"
echo ======================================================== >> "!LOGFILE!"
echo SESSION START: %date% %time% >> "!LOGFILE!"
echo ======================================================== >> "!LOGFILE!"
echo [STEP] Script started >> "!LOGFILE!"

:: detect claude command
set "CCMD="
echo [STEP] Detecting claude command... >> "!LOGFILE!"
where claude >nul 2>&1 && set "CCMD=claude"
if not defined CCMD (
    echo [STEP] 'claude' not in PATH, trying npx... >> "!LOGFILE!"
    where npx >nul 2>&1
    if not errorlevel 1 (
        npx claude --version >nul 2>&1
        if not errorlevel 1 set "CCMD=npx claude"
    )
)

if not defined CCMD (
    echo [ERROR] 'claude' CLI not found >> "!LOGFILE!"
    echo.
    echo ERROR: 'claude' CLI not found.
    echo Install from: https://claude.ai/code
    echo.
    echo This window will stay open. Close it manually.
    cmd /k
    goto :eof
)

echo [STEP] Claude command found: !CCMD! >> "!LOGFILE!"

:: flags
set "NO_TOOLS=false"
if /i "%~1"=="--no-tools" set "NO_TOOLS=true"
echo [STEP] NO_TOOLS=!NO_TOOLS! >> "!LOGFILE!"

set "SESSION="
set "TMPD=%TEMP%\claudechat%RANDOM%"
echo [STEP] Creating temp dir: !TMPD! >> "!LOGFILE!"
mkdir "!TMPD!" 2>nul
if not exist "!TMPD!" (
    echo [ERROR] Failed to create temp dir >> "!LOGFILE!"
    echo ERROR: Failed to create temp directory: !TMPD!
    cmd /k
    goto :eof
)
echo [STEP] Temp dir created OK >> "!LOGFILE!"

:: write PowerShell parser to temp file
echo [STEP] Writing parse.ps1... >> "!LOGFILE!"
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

if not exist "!TMPD!\parse.ps1" (
    echo [ERROR] Failed to write parse.ps1 >> "!LOGFILE!"
    echo ERROR: Failed to write parse.ps1
    cmd /k
    goto :eof
)
echo [STEP] parse.ps1 written OK >> "!LOGFILE!"

:: banner
if "!NO_TOOLS!"=="true" (
    echo Claude Chat  ^|  tools: none  ^|  type 'exit' to quit
) else (
    echo Claude Chat  ^|  tools: all except destructive git/rm  ^|  type 'exit' to quit
)
echo Log: !LOGFILE!
echo.
echo [STEP] Entering main loop >> "!LOGFILE!"

:: ======== main loop ========
:loop
echo.
set "USER_IN="
set /p "USER_IN=You: "
if not defined USER_IN (
    echo [LOOP] Empty input, re-prompting >> "!LOGFILE!"
    goto loop
)
if /i "!USER_IN!"=="exit" goto bye
if /i "!USER_IN!"=="quit" goto bye

echo [LOOP] User input: !USER_IN! >> "!LOGFILE!"
echo !USER_IN!> "!TMPD!\in.txt"

echo.
<nul set /p ="Claude: "

echo [LOOP] Routing: NO_TOOLS=!NO_TOOLS! SESSION=!SESSION! >> "!LOGFILE!"
if "!NO_TOOLS!"=="true" goto run_no_tools
if defined SESSION goto run_session_tools

echo [LOOP] Running claude (new session, with tools)... >> "!LOGFILE!"
call !CCMD! --print --output-format stream-json --verbose --allowedTools "!ALLOWED_TOOLS!" --disallowedTools "!DISALLOWED_TOOLS!" < "!TMPD!\in.txt" > "!TMPD!\out.txt" 2>&1
set CLAUDE_EXIT=!errorlevel!
echo [LOOP] claude exit code: !CLAUDE_EXIT! >> "!LOGFILE!"
if !CLAUDE_EXIT! neq 0 (
    echo (claude error !CLAUDE_EXIT! - see log)
    type "!TMPD!\out.txt" >> "!LOGFILE!" 2>nul
)
goto parse

:run_session_tools
echo [LOOP] Running claude (resume !SESSION!, with tools)... >> "!LOGFILE!"
call !CCMD! --print --output-format stream-json --verbose --resume "!SESSION!" --allowedTools "!ALLOWED_TOOLS!" --disallowedTools "!DISALLOWED_TOOLS!" < "!TMPD!\in.txt" > "!TMPD!\out.txt" 2>&1
set CLAUDE_EXIT=!errorlevel!
echo [LOOP] claude exit code: !CLAUDE_EXIT! >> "!LOGFILE!"
if !CLAUDE_EXIT! neq 0 (
    echo (claude error !CLAUDE_EXIT! - see log)
    type "!TMPD!\out.txt" >> "!LOGFILE!" 2>nul
)
goto parse

:run_no_tools
echo [LOOP] Running claude (no tools)... >> "!LOGFILE!"
if defined SESSION (
    call !CCMD! --print --output-format stream-json --verbose --resume "!SESSION!" --tools "" < "!TMPD!\in.txt" > "!TMPD!\out.txt" 2>&1
) else (
    call !CCMD! --print --output-format stream-json --verbose --tools "" < "!TMPD!\in.txt" > "!TMPD!\out.txt" 2>&1
)
set CLAUDE_EXIT=!errorlevel!
echo [LOOP] claude exit code: !CLAUDE_EXIT! >> "!LOGFILE!"
if !CLAUDE_EXIT! neq 0 (
    echo (claude error !CLAUDE_EXIT! - see log)
    type "!TMPD!\out.txt" >> "!LOGFILE!" 2>nul
)

:parse
echo [PARSE] Running parse.ps1... >> "!LOGFILE!"
powershell -NoProfile -ExecutionPolicy Bypass -File "!TMPD!\parse.ps1"
set PS_EXIT=!errorlevel!
echo [PARSE] PowerShell exit code: !PS_EXIT! >> "!LOGFILE!"

set "SESSION="
set /p SESSION=<"!TMPD!\sid.txt" 2>nul
echo [PARSE] Session ID: !SESSION! >> "!LOGFILE!"

if not exist "!TMPD!\res.txt" (
    echo [PARSE] res.txt missing >> "!LOGFILE!"
    echo (no response file - something went wrong)
    goto loop
)

for %%F in ("!TMPD!\res.txt") do (
    echo [PARSE] res.txt size: %%~zF bytes >> "!LOGFILE!"
    if %%~zF==0 (
        echo.
        echo (no response - check that claude CLI is logged in)
        echo [PARSE] Empty response >> "!LOGFILE!"
        goto loop
    )
)

echo [PARSE] Displaying response... >> "!LOGFILE!"
type "!TMPD!\res.txt"
echo.

echo [%date% %time%] Claude: >> "!LOGFILE!"
type "!TMPD!\res.txt" >> "!LOGFILE!"
echo. >> "!LOGFILE!"
echo [PARSE] Done, looping >> "!LOGFILE!"

goto loop

:: ======== exit ========
:bye
echo [STEP] User requested exit >> "!LOGFILE!"
rd /s /q "!TMPD!" 2>nul
echo ======================================================== >> "!LOGFILE!"
echo SESSION END: %date% %time% >> "!LOGFILE!"
echo ======================================================== >> "!LOGFILE!"
echo.
echo Goodbye! Log saved to: !LOGFILE!
echo.
echo (Close this window manually or press Ctrl+C)
cmd /k

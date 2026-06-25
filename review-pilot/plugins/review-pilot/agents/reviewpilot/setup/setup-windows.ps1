# ============================================================
#  Review Pilot — Windows
#  Setup & Installation Script (PowerShell 5.1+ / 7+)
# ============================================================
#  Run as: powershell -ExecutionPolicy Bypass -File setup-windows.ps1
# ============================================================

#Requires -Version 5.1
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

# ── Colours helper ──────────────────────────────────────────
function Write-OK   { param($Msg) Write-Host "  [OK]  $Msg" -ForegroundColor Green }
function Write-Warn { param($Msg) Write-Host "  [!!]  $Msg" -ForegroundColor Yellow }
function Write-Err  { param($Msg) Write-Host "  [XX]  $Msg" -ForegroundColor Red }
function Write-Hdr  { param($Msg) Write-Host "`n==> $Msg" -ForegroundColor Cyan }
function Write-Sep  { Write-Host ("─" * 52) -ForegroundColor Cyan }

$ScriptDir  = Split-Path -Parent $MyInvocation.MyCommand.Path
$AgentDir   = Split-Path -Parent $ScriptDir
$TargetDir  = Join-Path $env:USERPROFILE ".claude\agents\reviewpilot"

# ── Banner ──────────────────────────────────────────────────
Write-Host ""
Write-Host "  ██████╗ ███████╗██╗   ██╗██╗███████╗██╗    ██╗" -ForegroundColor Cyan
Write-Host "  ██╔══██╗██╔════╝██║   ██║██║██╔════╝██║    ██║" -ForegroundColor Cyan
Write-Host "  ██████╔╝█████╗  ██║   ██║██║█████╗  ██║ █╗ ██║" -ForegroundColor Cyan
Write-Host "  ██╔══██╗██╔══╝  ╚██╗ ██╔╝██║██╔══╝  ██║███╗██║" -ForegroundColor Cyan
Write-Host "  ██║  ██║███████╗ ╚████╔╝ ██║███████╗╚███╔███╔╝" -ForegroundColor Cyan
Write-Host "  ╚═╝  ╚═╝╚══════╝  ╚═══╝  ╚═╝╚══════╝ ╚══╝╚══╝" -ForegroundColor Cyan
Write-Host "         P I L O T   —   Windows Installer" -ForegroundColor Cyan
Write-Host ""
Write-Sep

# ── Helper: find a command ───────────────────────────────────
function Find-Command { param($Name) return [bool](Get-Command $Name -ErrorAction SilentlyContinue) }

# ── Helper: get Winget ───────────────────────────────────────
function Test-Winget { Find-Command 'winget' }

# ── Step 1: Git ─────────────────────────────────────────────
Write-Hdr "Step 1 — Git"
if (Find-Command 'git') {
    $v = (git --version); Write-OK "Git found: $v"
} else {
    Write-Warn "Git not found."
    if (Test-Winget) {
        Write-Host "  Installing via winget…"
        winget install --id Git.Git -e --source winget --accept-package-agreements --accept-source-agreements
        $env:PATH = [System.Environment]::GetEnvironmentVariable('PATH','Machine') + ';' + [System.Environment]::GetEnvironmentVariable('PATH','User')
        if (Find-Command 'git') { Write-OK "Git installed: $(git --version)" }
        else { Write-Err "Git install failed — download from https://git-scm.com/download/win"; exit 1 }
    } else {
        Write-Err "winget not available. Download Git from: https://git-scm.com/download/win"
        exit 1
    }
}

# ── Step 2: Node.js >= 16 ───────────────────────────────────
Write-Hdr "Step 2 — Node.js (>= 16 required)"
$NodeOK = $false
if (Find-Command 'node') {
    $nodeVer = (node -e "process.stdout.write(process.versions.node)")
    $nodeMajor = [int]($nodeVer.Split('.')[0])
    if ($nodeMajor -ge 16) {
        Write-OK "Node.js $nodeVer"; $NodeOK = $true
    } else {
        Write-Warn "Node.js $nodeVer is too old (need >= 16)."
    }
}

if (-not $NodeOK) {
    if (Test-Winget) {
        Write-Host "  Installing Node.js LTS via winget…"
        winget install --id OpenJS.NodeJS.LTS -e --source winget --accept-package-agreements --accept-source-agreements
        $env:PATH = [System.Environment]::GetEnvironmentVariable('PATH','Machine') + ';' + [System.Environment]::GetEnvironmentVariable('PATH','User')
        if (Find-Command 'node') { Write-OK "Node.js $(node --version) installed" }
        else {
            Write-Err "Node.js install failed."
            Write-Host "  Download from: https://nodejs.org/en/download  (LTS, >= 16)"
            Write-Host "  After installing, restart PowerShell and re-run this script."
            exit 1
        }
    } else {
        Write-Err "Cannot auto-install Node.js. Download from: https://nodejs.org/en/download"
        exit 1
    }
}

# ── Step 3: Claude Code CLI ────────────────────────────────
Write-Hdr "Step 3 — Claude Code CLI"
if (Find-Command 'claude') {
    $cv = (claude --version 2>$null | Select-Object -First 1)
    Write-OK "Claude Code CLI found: $cv"
} else {
    Write-Warn "Claude Code CLI not found."
    Write-Host ""
    Write-Host "  Install via npm:" -ForegroundColor White
    Write-Host "    npm install -g @anthropic-ai/claude-code" -ForegroundColor Cyan
    Write-Host ""
    Write-Host "  Or download from:"
    Write-Host "    https://docs.anthropic.com/en/docs/claude-code/quickstart"
    Write-Host ""
    Read-Host "  Press ENTER after installing Claude Code (or Ctrl+C to abort)"

    if (-not (Find-Command 'claude')) {
        # Refresh PATH
        $env:PATH = [System.Environment]::GetEnvironmentVariable('PATH','Machine') + ';' + [System.Environment]::GetEnvironmentVariable('PATH','User')
    }
    if (Find-Command 'claude') {
        Write-OK "Claude Code CLI found: $(claude --version 2>$null | Select-Object -First 1)"
    } else {
        Write-Err "Claude CLI still not found. Restart PowerShell and re-run, or add it to PATH manually."
        exit 1
    }
}

# ── Step 4: Claude auth ────────────────────────────────────
Write-Hdr "Step 4 — Claude authentication"
try {
    $authOut = (claude whoami 2>&1)
    Write-OK "Authenticated: $authOut"
} catch {
    Write-Warn "Not authenticated. Run:  claude auth login"
    Write-Host "  You can complete authentication after installation."
}

# ── Step 5: Install Review Pilot ───────────────────────────
Write-Hdr "Step 5 — Installing Review Pilot"
$ClaudeAgentsDir = Join-Path $env:USERPROFILE ".claude\agents"
if (-not (Test-Path $ClaudeAgentsDir)) { New-Item -ItemType Directory -Path $ClaudeAgentsDir -Force | Out-Null }

$AgentDirNorm  = (Resolve-Path $AgentDir).Path
$TargetDirNorm = if (Test-Path $TargetDir) { (Resolve-Path $TargetDir).Path } else { $TargetDir }

if ($AgentDirNorm -eq $TargetDirNorm) {
    Write-OK "Already installed at $TargetDir"
} else {
    Write-Host "  Copying to $TargetDir …"
    if (-not (Test-Path $TargetDir)) { New-Item -ItemType Directory -Path $TargetDir -Force | Out-Null }
    Copy-Item -Path "$AgentDir\*" -Destination $TargetDir -Recurse -Force
    Write-OK "Copied to $TargetDir"
}

# ── Step 6: Logs dir ───────────────────────────────────────
Write-Hdr "Step 6 — Logs directory"
$LogsDir = Join-Path $TargetDir "logs"
if (-not (Test-Path $LogsDir)) { New-Item -ItemType Directory -Path $LogsDir -Force | Out-Null }
Write-OK "Logs directory ready: $LogsDir"

# ── Step 7: Verify scripts ─────────────────────────────────
Write-Hdr "Step 7 — Verifying scripts"
$ServerScript = Join-Path $TargetDir "server.js"
$ScopeScript  = Join-Path $TargetDir "scripts\collect_review_scope.js"

try {
    node --check $ServerScript 2>&1 | Out-Null; Write-OK "server.js — syntax OK"
} catch {
    Write-Warn "server.js syntax check failed: $_"
}
try {
    node --check $ScopeScript 2>&1 | Out-Null; Write-OK "collect_review_scope.js — syntax OK"
} catch {
    Write-Warn "collect_review_scope.js syntax check failed: $_"
}

# ── Step 8: Start server (optional) ───────────────────────
Write-Hdr "Step 8 — Starting server (optional)"
Write-Host "  To start the browser UI, run:"
Write-Host "    node `"$ServerScript`"" -ForegroundColor Cyan
Write-Host "  Then open:  http://localhost:3922"
Write-Host ""
$StartNow = Read-Host "  Start the server now? [y/N]"
if ($StartNow -match '^[yY]') {
    $logFile = Join-Path $LogsDir "server-startup.log"
    $proc = Start-Process -FilePath "node" -ArgumentList "`"$ServerScript`"" `
        -RedirectStandardOutput $logFile -RedirectStandardError $logFile `
        -WindowStyle Hidden -PassThru
    Start-Sleep -Seconds 2
    if (-not $proc.HasExited) {
        Write-OK "Server started (PID $($proc.Id))"
        Start-Process "http://localhost:3922"
        Write-OK "Browser opened"
    } else {
        Write-Err "Server failed to start. Check: $logFile"
    }
}

# ── Done ───────────────────────────────────────────────────
Write-Sep
Write-Host ""
Write-Host "  Review Pilot installed successfully!" -ForegroundColor Green
Write-Host ""
Write-Host "  Quick start:" -ForegroundColor White
Write-Host "    1. Open a project in Claude Code CLI / IDE"
Write-Host "    2. Type:  `$reviewpilot  (or  /reviewpilot)" -ForegroundColor Cyan
Write-Host "    3. The browser UI opens — choose role, base branch, click Start Review"
Write-Host ""
Write-Host "  Manual invocation:" -ForegroundColor White
Write-Host "    `$reviewpilot Review UI developer changes against master base branch" -ForegroundColor Cyan
Write-Host ""
Write-Host "  Logs:  $LogsDir" -ForegroundColor White
Write-Sep
Write-Host ""

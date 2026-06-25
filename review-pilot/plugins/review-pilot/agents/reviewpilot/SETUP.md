# Review Pilot — Setup Guide

Senior tech-lead branch reviewer for Claude Code.
Reviews role-matched files, proposes behaviour-preserving fixes, applies only after your explicit approval.

---

## Contents

- [Prerequisites](#prerequisites)
- [Quick Install](#quick-install)
  - [Linux / Ubuntu](#linux--ubuntu)
  - [macOS](#macos)
  - [Windows](#windows)
- [Manual Install](#manual-install)
- [First Run](#first-run)
- [Usage](#usage)
- [Configuration](#configuration)
- [Troubleshooting](#troubleshooting)
- [Uninstall](#uninstall)

---

## Prerequisites

| Tool | Min version | Purpose |
|------|-------------|---------|
| **Node.js** | ≥ 16 | Runs the scope-collector script and the browser-UI server |
| **Git** | ≥ 2.20 | Diff, log, and blame operations |
| **Claude Code CLI** | latest | Drives the AI review session |
| **A web browser** | any modern | Displays the review console (auto-opened) |

> **Claude Code CLI** requires an [Anthropic API key](https://console.anthropic.com/).
> Authenticate once with `claude auth login` before running a review.

### Verify prerequisites manually

```bash
node --version    # must print v16.x or higher
git  --version    # any recent version
claude --version  # Claude Code CLI
```

---

## Quick Install

Clone or download the `reviewpilot` folder, then run the script for your OS from inside that folder.

### Linux / Ubuntu

```bash
cd reviewpilot/setup
chmod +x setup-linux.sh
./setup-linux.sh
```

**What the script does:**
1. Detects your package manager (`apt` / `dnf` / `pacman` / `zypper`)
2. Installs **Git** if missing
3. Installs **Node.js LTS** if missing or outdated (via NodeSource)
4. Checks for **Claude Code CLI** — prompts you to install if absent
5. Copies all files to `~/.claude/agents/reviewpilot/`
6. Creates the `logs/` directory
7. Syntax-checks `server.js` and `collect_review_scope.js`
8. Optionally starts the server and opens the browser

**Supported distros:** Ubuntu 20.04+, Debian 11+, Fedora 37+, Arch, openSUSE Leap 15+

---

### macOS

```bash
cd reviewpilot/setup
chmod +x setup-macos.sh
./setup-macos.sh
```

**What the script does:**
1. Installs **Xcode Command Line Tools** if missing
2. Installs **Homebrew** if missing
3. Installs **Git** via Homebrew if missing
4. Installs **Node.js** via Homebrew if missing or outdated
5. Checks for **Claude Code CLI** — prompts you to install if absent
6. Copies all files to `~/.claude/agents/reviewpilot/`
7. Creates the `logs/` directory
8. Optionally starts the server and opens the browser

**Supported:** macOS 12 Monterey and later (Intel + Apple Silicon)

---

### Windows

**Option A — PowerShell (recommended)**

```powershell
# Open PowerShell as normal user (not Administrator)
Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass
cd reviewpilot\setup
.\setup-windows.ps1
```

**Option B — Command Prompt (fallback)**

```cmd
cd reviewpilot\setup
setup-windows.bat
```

**What the scripts do:**
1. Checks for **Git** — installs via `winget` if missing
2. Checks for **Node.js ≥ 16** — installs via `winget` if missing
3. Checks for **Claude Code CLI** — prompts you to install if absent
4. Copies all files to `%USERPROFILE%\.claude\agents\reviewpilot\`
5. Creates the `logs\` directory
6. Syntax-checks the Node.js scripts
7. Optionally starts the server and opens the browser

**Supported:** Windows 10 (1903+) and Windows 11

> **Note on PowerShell execution policy:** The `Set-ExecutionPolicy -Scope Process` command only affects the current window — it does not change your system policy permanently.

---

## Manual Install

If you prefer to install without running a script:

### 1. Install prerequisites

**Node.js ≥ 16**
- Download: https://nodejs.org/en/download (LTS)
- Or via package manager:
  ```bash
  # Ubuntu/Debian
  curl -fsSL https://deb.nodesource.com/setup_lts.x | sudo -E bash -
  sudo apt-get install -y nodejs

  # macOS (Homebrew)
  brew install node

  # Windows (winget)
  winget install OpenJS.NodeJS.LTS
  ```

**Git ≥ 2.20**
- Download: https://git-scm.com/downloads
- Or: `brew install git` / `sudo apt install git` / `winget install Git.Git`

**Claude Code CLI**
```bash
npm install -g @anthropic-ai/claude-code
claude auth login
```

### 2. Copy files

```bash
# Linux / macOS
mkdir -p ~/.claude/agents
cp -r reviewpilot ~/.claude/agents/

# Windows (PowerShell)
New-Item -ItemType Directory -Force -Path "$env:USERPROFILE\.claude\agents"
Copy-Item -Recurse -Force reviewpilot "$env:USERPROFILE\.claude\agents\"
```

### 3. Create logs directory

```bash
# Linux / macOS
mkdir -p ~/.claude/agents/reviewpilot/logs

# Windows (PowerShell)
New-Item -ItemType Directory -Force -Path "$env:USERPROFILE\.claude\agents\reviewpilot\logs"
```

### 4. Verify

```bash
node --check ~/.claude/agents/reviewpilot/server.js
node --check ~/.claude/agents/reviewpilot/scripts/collect_review_scope.js
```

---

## First Run

### Start the review server

The browser UI requires the server to be running:

```bash
# Linux / macOS — run in background
node ~/.claude/agents/reviewpilot/server.js &

# Windows (PowerShell) — run in background
Start-Process node -ArgumentList "$env:USERPROFILE\.claude\agents\reviewpilot\server.js" -WindowStyle Hidden

# Windows (CMD)
start /b node "%USERPROFILE%\.claude\agents\reviewpilot\server.js"
```

Then open: **http://localhost:3922**

The server runs on port **3922** by default. Override with:
```bash
REVIEWPILOT_PORT=4000 node server.js    # Linux / macOS
$env:REVIEWPILOT_PORT=4000; node server.js  # Windows PowerShell
```

### Invoke from Claude Code

Inside any Claude Code session (CLI, VS Code extension, or IDE):

```
$reviewpilot
```

Type that with no arguments — the skill starts the server and opens the browser UI automatically.

---

## Usage

### From the browser UI

1. Start the server: `node ~/.claude/agents/reviewpilot/server.js`
2. Open http://localhost:3922
3. Select your **developer role** (UI / Backend / Database)
4. Set the **base branch** (e.g. `main`, `QA`, `develop`)
5. Click **Start Review**
6. Review the report, then choose **APPROVE ALL**, **APPROVE [IDs]**, **REVISE**, or **STOP**

### From Claude Code chat (text prompts)

```text
# Review all UI changes against QA
$reviewpilot Review UI developer changes against QA base branch

# Backend-only, committed changes
$reviewpilot Review backend developer changes against develop base branch committed-only

# Database changes
$reviewpilot Review DB developer changes against main base branch

# Custom extensions
$reviewpilot base=main extensions=.ts,.tsx,.js,.jsx

# Specific focus
$reviewpilot Review UI developer changes against master. Pay attention to ::ng-deep deprecations.
```

### Role presets

| Role | File types reviewed |
|------|---------------------|
| **UI Developer** | `.html` `.htm` `.js` `.ts` `.spec.ts` `.json` `.scss` `.css` `.less` `.styl` `.jsp` `.properties` `.vue` `.svelte` |
| **Backend Developer** | `.java` `.test` `.xml` `.yml` `.yaml` `.scala` `.kt` `.properties` `.tld` `.wsdd` `.xsd` `.gradle` |
| **DB Developer** | `.sql` `.ddl` `.dml` `.pks` `.pkb` `.prc` `.fnc` `.tab` `.vw` `.trg` `.pls` `.plsql` `.psql` `.tsql` |

---

## Configuration

### Change the server port

```bash
# Linux / macOS (persist in shell profile)
export REVIEWPILOT_PORT=4000
echo 'export REVIEWPILOT_PORT=4000' >> ~/.bashrc   # or ~/.zshrc

# Windows — set as user environment variable
[System.Environment]::SetEnvironmentVariable('REVIEWPILOT_PORT', '4000', 'User')
```

### Log files

Every review session writes a log to:

```
~/.claude/agents/reviewpilot/logs/
  feature-QA-8883.log       ← first session on this branch
  feature-QA-8883-2.log     ← second session (same branch)
  feature-QA-8883-3.log     ← third session
  server.log                ← server startup / lifecycle
```

Each log is **NDJSON** (one JSON object per line):
```json
{"ts":"2026-06-04T10:00:00.000Z","level":"INFO","message":"Review requested","data":{"base":"QA","role":"UI Developer"}}
{"ts":"2026-06-04T10:00:01.200Z","level":"INFO","message":"Scope collected","data":{"files_reviewed":12,"files_skipped":4}}
```

Tail a live review:
```bash
tail -f ~/.claude/agents/reviewpilot/logs/feature-QA-8883.log | while read l; do echo $l | python3 -m json.tool; done
```

---

## Troubleshooting

### "Server not running" shown in the browser UI

The browser UI pings `http://localhost:3922/health`. If the dot stays red:
```bash
# Check if something else is using port 3922
lsof -i :3922          # Linux / macOS
netstat -ano | findstr :3922   # Windows

# Start the server manually
node ~/.claude/agents/reviewpilot/server.js
```

### "Port 3922 already in use"

Review Pilot may already be running. Kill the old process:
```bash
# Linux / macOS
pkill -f "reviewpilot/server.js"

# Windows (PowerShell)
Get-Process node | Where-Object { $_.CommandLine -like '*reviewpilot*' } | Stop-Process
```

Or use a different port: `REVIEWPILOT_PORT=3923 node server.js`

### "could not resolve base ref"

The base branch you entered doesn't exist locally or on origin. Try:
```bash
git fetch --all
# then retry with origin/main or the full remote ref
```

### Node.js version too old

```bash
node --version   # must be v16 or higher

# Upgrade on Ubuntu
curl -fsSL https://deb.nodesource.com/setup_lts.x | sudo -E bash -
sudo apt-get install -y nodejs

# Upgrade on macOS
brew upgrade node

# Upgrade on Windows
winget upgrade OpenJS.NodeJS.LTS
```

### "claude: command not found"

Claude Code CLI is not on your PATH:
```bash
npm install -g @anthropic-ai/claude-code
claude auth login
```

### Files aren't opening when clicking FILE:LINE links

The click-to-open feature requires at least one of these editors to be installed and on PATH:
`code` (VS Code), `cursor`, `codium`, `subl` (Sublime), `idea`, `webstorm`

Verify: `which code` (Linux/macOS) or `where code` (Windows)

---

## Uninstall

```bash
# Linux / macOS
rm -rf ~/.claude/agents/reviewpilot

# Windows (PowerShell)
Remove-Item -Recurse -Force "$env:USERPROFILE\.claude\agents\reviewpilot"
```

This removes the agent, all logs, and all generated files. Your git repositories are never modified by Review Pilot.

---

## Directory structure after install

```
~/.claude/agents/reviewpilot/
├── SKILL.md                         ← skill instructions (used by Claude)
├── SETUP.md                         ← this file
├── README.md                        ← brief usage reference
├── server.js                        ← HTTP server for the browser UI
├── openai.yaml                      ← Codex interface metadata
├── lib/
│   └── logger.js                    ← session logger (branch-named log files)
├── scripts/
│   └── collect_review_scope.js      ← deterministic git scope collector
├── ui/
│   └── index.html                   ← browser review console
├── setup/
│   ├── setup-linux.sh               ← Linux installer
│   ├── setup-macos.sh               ← macOS installer
│   ├── setup-windows.ps1            ← Windows PowerShell installer
│   └── setup-windows.bat            ← Windows CMD installer (fallback)
└── logs/                            ← review session logs (created on first run)
    └── <branch-name>[-N].log
```

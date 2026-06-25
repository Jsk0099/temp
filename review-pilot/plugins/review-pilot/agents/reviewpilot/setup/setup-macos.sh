#!/usr/bin/env bash
# ============================================================
#  Review Pilot — macOS
#  Setup & Installation Script
# ============================================================
set -euo pipefail

# ── Colours ─────────────────────────────────────────────────
RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'
CYAN='\033[0;36m'; BOLD='\033[1m'; RESET='\033[0m'

ok()   { echo -e "  ${GREEN}✔${RESET}  $*"; }
warn() { echo -e "  ${YELLOW}⚠${RESET}  $*"; }
err()  { echo -e "  ${RED}✘${RESET}  $*"; }
hdr()  { echo -e "\n${BOLD}${CYAN}$*${RESET}"; }
sep()  { echo -e "${CYAN}────────────────────────────────────────────────────${RESET}"; }

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
AGENT_DIR="$(dirname "$SCRIPT_DIR")"
TARGET_DIR="${HOME}/.claude/agents/reviewpilot"

# ── Banner ──────────────────────────────────────────────────
echo -e "\n${BOLD}${CYAN}"
cat <<'BANNER'
  ██████╗ ███████╗██╗   ██╗██╗███████╗██╗    ██╗
  ██╔══██╗██╔════╝██║   ██║██║██╔════╝██║    ██║
  ██████╔╝█████╗  ██║   ██║██║█████╗  ██║ █╗ ██║
  ██╔══██╗██╔══╝  ╚██╗ ██╔╝██║██╔══╝  ██║███╗██║
  ██║  ██║███████╗ ╚████╔╝ ██║███████╗╚███╔███╔╝
  ╚═╝  ╚═╝╚══════╝  ╚═══╝  ╚═╝╚══════╝ ╚══╝╚══╝
         P I L O T   —   macOS Installer
BANNER
echo -e "${RESET}"
sep

# ── Step 1: Xcode Command Line Tools ───────────────────────
hdr "Step 1 — Xcode Command Line Tools"
if xcode-select -p &>/dev/null; then
  ok "Xcode CLT found: $(xcode-select -p)"
else
  warn "Xcode Command Line Tools not found. Installing…"
  xcode-select --install
  echo "  Follow the dialog, then re-run this script."
  exit 0
fi

# ── Step 2: Homebrew ────────────────────────────────────────
hdr "Step 2 — Homebrew"
if command -v brew &>/dev/null; then
  ok "Homebrew found: $(brew --version | head -1)"
else
  warn "Homebrew not found. Installing…"
  /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
  # Add brew to PATH for Apple Silicon
  if [[ -f /opt/homebrew/bin/brew ]]; then
    eval "$(/opt/homebrew/bin/brew shellenv)"
    echo 'eval "$(/opt/homebrew/bin/brew shellenv)"' >> "${HOME}/.zprofile"
  fi
  ok "Homebrew installed"
fi

# ── Step 3: Git ─────────────────────────────────────────────
hdr "Step 3 — Git"
if command -v git &>/dev/null; then
  ok "Git found: $(git --version)"
else
  warn "Installing Git via Homebrew…"
  brew install git
  ok "Git installed: $(git --version)"
fi

# ── Step 4: Node.js >= 16 ───────────────────────────────────
hdr "Step 4 — Node.js (≥ 16 required)"
NODE_OK=false
if command -v node &>/dev/null; then
  NODE_VER=$(node -e 'process.stdout.write(process.versions.node)')
  NODE_MAJOR=$(echo "$NODE_VER" | cut -d. -f1)
  if [ "$NODE_MAJOR" -ge 16 ]; then
    ok "Node.js $NODE_VER"; NODE_OK=true
  else
    warn "Node.js $NODE_VER is too old (need ≥ 16). Upgrading via Homebrew…"
  fi
fi

if ! $NODE_OK; then
  brew install node
  ok "Node.js $(node --version) installed"
fi

# ── Step 5: Claude Code CLI ────────────────────────────────
hdr "Step 5 — Claude Code CLI"
if command -v claude &>/dev/null; then
  CLAUDE_VER=$(claude --version 2>/dev/null | head -1 || echo "unknown")
  ok "Claude Code CLI found: $CLAUDE_VER"
else
  warn "Claude Code CLI not found."
  echo
  echo -e "  ${BOLD}Install via npm:${RESET}"
  echo -e "    ${CYAN}npm install -g @anthropic-ai/claude-code${RESET}"
  echo
  echo -e "  Or download from:"
  echo -e "    https://docs.anthropic.com/en/docs/claude-code/quickstart"
  echo
  read -rp "  Press ENTER after installing Claude Code, or Ctrl+C to abort: "
  if ! command -v claude &>/dev/null; then
    err "Claude CLI still not found. Install it and re-run this script."
    exit 1
  fi
  ok "Claude Code CLI found: $(claude --version 2>/dev/null | head -1)"
fi

# ── Step 6: Claude auth ────────────────────────────────────
hdr "Step 6 — Claude authentication"
if claude whoami &>/dev/null 2>&1; then
  ok "Authenticated with Claude"
else
  warn "Not authenticated. Run:  ${CYAN}claude auth login${RESET}"
  echo "  You can complete authentication after installation."
fi

# ── Step 7: Install Review Pilot ───────────────────────────
hdr "Step 7 — Installing Review Pilot"
mkdir -p "${HOME}/.claude/agents"

if [ "$(realpath "$AGENT_DIR")" = "$(realpath "$TARGET_DIR" 2>/dev/null || echo '')" ]; then
  ok "Already installed at $TARGET_DIR"
else
  echo "  Copying to $TARGET_DIR …"
  mkdir -p "$TARGET_DIR"
  cp -r "$AGENT_DIR"/. "$TARGET_DIR/"
  ok "Copied to $TARGET_DIR"
fi

# ── Step 8: Logs dir ───────────────────────────────────────
hdr "Step 8 — Logs directory"
mkdir -p "$TARGET_DIR/logs"
ok "Logs directory ready: $TARGET_DIR/logs"

# ── Step 9: Verify scripts ─────────────────────────────────
hdr "Step 9 — Verifying scripts"
node --check "$TARGET_DIR/server.js"                        && ok "server.js — syntax OK"
node --check "$TARGET_DIR/scripts/collect_review_scope.js"  && ok "collect_review_scope.js — syntax OK"

# ── Step 10: Start server (optional) ──────────────────────
hdr "Step 10 — Starting server (optional)"
echo "  To start the browser UI, run:"
echo -e "    ${CYAN}node $TARGET_DIR/server.js${RESET}"
echo "  Then open:  http://localhost:3922"
echo
read -rp "  Start the server now? [y/N] " START_NOW
if [[ "${START_NOW,,}" == "y" ]]; then
  nohup node "$TARGET_DIR/server.js" > "$TARGET_DIR/logs/server-startup.log" 2>&1 &
  SERVER_PID=$!
  sleep 1
  if kill -0 "$SERVER_PID" 2>/dev/null; then
    ok "Server started (PID $SERVER_PID)"
    open "http://localhost:3922"
    ok "Browser opened"
  else
    err "Server failed to start. Check $TARGET_DIR/logs/server-startup.log"
  fi
fi

# ── Done ───────────────────────────────────────────────────
sep
echo -e "\n${GREEN}${BOLD}  Review Pilot installed successfully!${RESET}\n"
echo -e "  ${BOLD}Quick start:${RESET}"
echo -e "    1. Open a project in Claude Code CLI / IDE"
echo -e "    2. Type:  ${CYAN}\$reviewpilot${RESET}  (or  ${CYAN}/reviewpilot${RESET})"
echo -e "    3. The browser UI opens — choose role, base branch, click Start Review"
echo
echo -e "  ${BOLD}Manual invocation:${RESET}"
echo -e "    ${CYAN}\$reviewpilot Review UI developer changes against master base branch${RESET}"
echo
echo -e "  ${BOLD}Logs:${RESET}  $TARGET_DIR/logs/"
sep
echo

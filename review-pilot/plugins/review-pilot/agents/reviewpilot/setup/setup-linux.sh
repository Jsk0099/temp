#!/usr/bin/env bash
# ============================================================
#  Review Pilot — Linux (Ubuntu / Debian / Fedora / Arch)
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
AGENT_DIR="$(dirname "$SCRIPT_DIR")"          # reviewpilot/
TARGET_DIR="${HOME}/.claude/agents/reviewpilot"

# ────────────────────────────────────────────────────────────
echo -e "\n${BOLD}${CYAN}"
cat <<'BANNER'
  ██████╗ ███████╗██╗   ██╗██╗███████╗██╗    ██╗
  ██╔══██╗██╔════╝██║   ██║██║██╔════╝██║    ██║
  ██████╔╝█████╗  ██║   ██║██║█████╗  ██║ █╗ ██║
  ██╔══██╗██╔══╝  ╚██╗ ██╔╝██║██╔══╝  ██║███╗██║
  ██║  ██║███████╗ ╚████╔╝ ██║███████╗╚███╔███╔╝
  ╚═╝  ╚═╝╚══════╝  ╚═══╝  ╚═╝╚══════╝ ╚══╝╚══╝
         P I L O T   —   Linux Installer
BANNER
echo -e "${RESET}"
sep

# ── Step 1: Detect package manager ─────────────────────────
hdr "Step 1 — Detecting Linux distribution"
PKG_MANAGER=""
if command -v apt-get &>/dev/null;  then PKG_MANAGER="apt";   ok "Debian/Ubuntu — apt-get"
elif command -v dnf &>/dev/null;    then PKG_MANAGER="dnf";   ok "Fedora/RHEL — dnf"
elif command -v pacman &>/dev/null; then PKG_MANAGER="pacman"; ok "Arch Linux — pacman"
elif command -v zypper &>/dev/null; then PKG_MANAGER="zypper"; ok "openSUSE — zypper"
else warn "Unknown package manager — you may need to install prerequisites manually."
fi

# ── Step 2: Git ─────────────────────────────────────────────
hdr "Step 2 — Git"
if command -v git &>/dev/null; then
  ok "Git found: $(git --version)"
else
  warn "Git not found. Attempting install…"
  case "$PKG_MANAGER" in
    apt)    sudo apt-get update -q && sudo apt-get install -y git ;;
    dnf)    sudo dnf install -y git ;;
    pacman) sudo pacman -S --noconfirm git ;;
    zypper) sudo zypper install -y git ;;
    *) err "Cannot auto-install Git. Install it manually: https://git-scm.com/download/linux" && exit 1 ;;
  esac
  ok "Git installed: $(git --version)"
fi

# ── Step 3: Node.js >= 16 ───────────────────────────────────
hdr "Step 3 — Node.js (≥ 16 required)"
NODE_OK=false
if command -v node &>/dev/null; then
  NODE_VER=$(node -e 'process.stdout.write(process.versions.node)')
  NODE_MAJOR=$(echo "$NODE_VER" | cut -d. -f1)
  if [ "$NODE_MAJOR" -ge 16 ]; then
    ok "Node.js $NODE_VER"; NODE_OK=true
  else
    warn "Node.js $NODE_VER is too old (need ≥ 16)."
  fi
fi

if ! $NODE_OK; then
  warn "Installing Node.js LTS via NodeSource…"
  if command -v curl &>/dev/null; then
    curl -fsSL https://deb.nodesource.com/setup_lts.x | sudo -E bash - 2>/dev/null || true
  fi
  case "$PKG_MANAGER" in
    apt)    sudo apt-get install -y nodejs ;;
    dnf)    sudo dnf install -y nodejs ;;
    pacman) sudo pacman -S --noconfirm nodejs npm ;;
    zypper) sudo zypper install -y nodejs ;;
    *)
      err "Cannot auto-install Node.js."
      echo "  Install manually → https://nodejs.org/en/download  (LTS, ≥ 16)"
      exit 1
      ;;
  esac
  ok "Node.js $(node --version) installed"
fi

# ── Step 4: Claude Code CLI ────────────────────────────────
hdr "Step 4 — Claude Code CLI"
if command -v claude &>/dev/null; then
  CLAUDE_VER=$(claude --version 2>/dev/null | head -1 || echo "unknown")
  ok "Claude Code CLI found: $CLAUDE_VER"
else
  warn "Claude Code CLI not found."
  echo
  echo -e "  ${BOLD}Install it with npm:${RESET}"
  echo -e "    ${CYAN}npm install -g @anthropic-ai/claude-code${RESET}"
  echo
  echo -e "  Or download directly:"
  echo -e "    https://docs.anthropic.com/en/docs/claude-code/quickstart"
  echo
  read -rp "  Press ENTER after installing Claude Code, or Ctrl+C to abort: "
  if ! command -v claude &>/dev/null; then
    err "Claude CLI still not found. Install it and re-run this script."
    exit 1
  fi
  ok "Claude Code CLI found: $(claude --version 2>/dev/null | head -1)"
fi

# ── Step 5: Check Claude auth ──────────────────────────────
hdr "Step 5 — Claude authentication"
if claude whoami &>/dev/null 2>&1; then
  ok "Authenticated with Claude"
else
  warn "Not authenticated. Run:  ${CYAN}claude auth login${RESET}"
  echo "  You can complete authentication after installation."
fi

# ── Step 6: Install Review Pilot ───────────────────────────
hdr "Step 6 — Installing Review Pilot"
mkdir -p "${HOME}/.claude/agents"

if [ "$(realpath "$AGENT_DIR")" = "$(realpath "$TARGET_DIR" 2>/dev/null || echo '')" ]; then
  ok "Already installed at $TARGET_DIR"
else
  echo "  Copying to $TARGET_DIR …"
  mkdir -p "$TARGET_DIR"
  cp -r "$AGENT_DIR"/. "$TARGET_DIR/"
  ok "Copied to $TARGET_DIR"
fi

# ── Step 7: Create logs dir ────────────────────────────────
hdr "Step 7 — Logs directory"
mkdir -p "$TARGET_DIR/logs"
ok "Logs directory ready: $TARGET_DIR/logs"

# ── Step 8: Verify Node.js can load the scripts ────────────
hdr "Step 8 — Verifying scripts"
if node --check "$TARGET_DIR/server.js" 2>/dev/null; then
  ok "server.js — syntax OK"
else
  err "server.js has a syntax error. Please check $TARGET_DIR/server.js"
fi
if node --check "$TARGET_DIR/scripts/collect_review_scope.js" 2>/dev/null; then
  ok "collect_review_scope.js — syntax OK"
else
  err "collect_review_scope.js has a syntax error."
fi

# ── Step 9: Optional browser open ─────────────────────────
hdr "Step 9 — Starting server (optional)"
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
    echo "  Opening browser…"
    xdg-open "http://localhost:3922" 2>/dev/null || open "http://localhost:3922" 2>/dev/null || \
      echo -e "  Open manually → ${CYAN}http://localhost:3922${RESET}"
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

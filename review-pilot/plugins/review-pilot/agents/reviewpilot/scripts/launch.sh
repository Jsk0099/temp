#!/usr/bin/env bash
# Cross-platform launch: start Review Pilot server and open the browser UI.
set -uo pipefail

PORT=3922
SERVER="$(cd "$(dirname "$0")/.." && pwd)/server.js"
URL="http://localhost:$PORT"
LOG=/tmp/reviewpilot-server.log

# ── Start server if not already running ──────────────────────────────────────
if curl -s --max-time 1 "$URL/health" >/dev/null 2>&1; then
  echo "ALREADY_RUNNING"
else
  if [ ! -f "$SERVER" ]; then
    echo "SERVER_NOT_FOUND:$SERVER"
    exit 1
  fi
  nohup node "$SERVER" > "$LOG" 2>&1 &
  for i in 1 2 3 4 5; do
    sleep 1
    if curl -s --max-time 1 "$URL/health" >/dev/null 2>&1; then
      echo "STARTED"
      break
    fi
  done
  if ! curl -s --max-time 1 "$URL/health" >/dev/null 2>&1; then
    echo "FAILED"
    exit 1
  fi
fi

# ── Open browser (cross-platform) ────────────────────────────────────────────
_open_browser() {
  local uname
  uname="$(uname -s 2>/dev/null || echo Windows)"
  case "$uname" in
    Darwin)
      open "$URL" ;;
    Linux)
      # WSL: uname reports Linux but Windows browser is reachable via cmd.exe
      if grep -qi microsoft /proc/version 2>/dev/null; then
        cmd.exe /c start "" "$URL" 2>/dev/null \
          || powershell.exe -c "Start-Process '$URL'" 2>/dev/null
      else
        xdg-open "$URL"
      fi ;;
    MINGW*|MSYS*|CYGWIN*)
      # Git Bash / MSYS2 / Cygwin on Windows
      cmd.exe /c start "" "$URL" 2>/dev/null \
        || powershell.exe -c "Start-Process '$URL'" 2>/dev/null ;;
    *)
      # Unknown — try all options
      xdg-open "$URL" 2>/dev/null \
        || open "$URL" 2>/dev/null \
        || cmd.exe /c start "" "$URL" 2>/dev/null ;;
  esac
}

_open_browser 2>/dev/null &
echo "OPENED"

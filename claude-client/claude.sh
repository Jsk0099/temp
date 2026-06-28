#!/usr/bin/env bash
# Claude terminal chat — bash + awk only, no extra dependencies
#
# Usage:
#   bash claude.sh              # all tools, dangerous ops blocked
#   bash claude.sh --no-tools   # pure chat, no tools

# ── allowed tools (pre-approved, no runtime prompt needed) ───────────────────
ALLOWED_TOOLS="Read,Write,Edit,MultiEdit,Bash,LS,Glob,Grep,WebSearch,WebFetch,TodoRead,TodoWrite,NotebookRead,NotebookEdit"

# ── blocked patterns (always denied) ─────────────────────────────────────────
DISALLOWED_TOOLS="Bash(git commit *),Bash(git push *),Bash(git merge *),Bash(git rebase *),Bash(git reset *),Bash(git clean *),Bash(git branch -D *),Bash(git branch -d *),Bash(git checkout -- *),Bash(git restore *),Bash(gh *),Bash(rm -rf *),Bash(rm -f *),Bash(rmdir *)"
# ─────────────────────────────────────────────────────────────────────────────

LOGFILE="$(dirname "$0")/claude-chat.log"

# --- flags ---
NO_TOOLS=false
while [[ $# -gt 0 ]]; do
    case "$1" in
        --no-tools) NO_TOOLS=true; shift ;;
        *) shift ;;
    esac
done

# --- resolve claude command ---
if command -v claude &>/dev/null; then
    CLAUDE_CMD="claude"
elif command -v npx &>/dev/null && npx claude --version &>/dev/null 2>&1; then
    CLAUDE_CMD="npx claude"
else
    echo "Error: 'claude' CLI not found. Install from: https://claude.ai/code"
    exit 1
fi

SESSION=""

# --- parse stream-json with awk, no python needed ---
# Finds the {"type":"result",...} line, extracts session_id and result.
# Outputs: session_id<US>result_text   (US = ASCII unit-separator 0x1F / octal 037)
extract() {
    awk '
    /"type":"result"/ {
        # session_id is always a UUID — simple pattern is safe
        sid = $0
        sub(/.*"session_id":"/, "", sid)
        sub(/".*/, "", sid)

        # Walk the JSON result string char-by-char to unescape it properly
        start = index($0, "\"result\":\"")
        if (start == 0) next
        s = substr($0, start + 10)
        out = ""
        i = 1
        n = length(s)
        while (i <= n) {
            c = substr(s, i, 1)
            if (c == "\\") {
                i++
                nc = substr(s, i, 1)
                if      (nc == "n") out = out "\n"
                else if (nc == "t") out = out "\t"
                else if (nc == "r") out = out "\r"
                else                out = out nc
            } else if (c == "\"") {
                break
            } else {
                out = out c
            }
            i++
        }
        printf "%s\037%s\n", sid, out
    }
    '
}

# --- logging ---
{
    echo ""
    echo "========================================================"
    echo "SESSION START: $(date)"
    echo "========================================================"
} >> "$LOGFILE"

# --- banner ---
if $NO_TOOLS; then
    tool_label="no tools (chat only)"
else
    tool_label="all tools except: git commit/push/merge/rebase/reset/clean, gh, rm -rf/f, rmdir"
fi
echo "Claude Chat  |  tools: $tool_label  |  type 'exit' to quit"
echo "Log: $LOGFILE"
echo "────────────────────────────────────────────────────────────"

# --- main loop ---
while true; do
    printf "\nYou: "
    IFS= read -r user_input || break
    [[ -z "$user_input" ]] && continue
    [[ "$user_input" == "exit" || "$user_input" == "quit" ]] && break

    echo "[$(date)] You: $user_input" >> "$LOGFILE"

    printf "\nClaude: "

    build_args() {
        local -a a=(--print --output-format stream-json --verbose)
        [[ -n "$SESSION" ]] && a+=(--resume "$SESSION")
        if $NO_TOOLS; then
            a+=(--allowedTools "")
        else
            a+=(--allowedTools "$ALLOWED_TOOLS" --disallowedTools "$DISALLOWED_TOOLS")
        fi
        printf '%s\0' "${a[@]}"
    }

    mapfile -d '' args < <(build_args)
    parsed=$(printf '%s' "$user_input" | $CLAUDE_CMD "${args[@]}" 2>&1 | extract)

    if [[ -z "$parsed" ]]; then
        echo "(no response — check that claude CLI is logged in)"
        echo "[$(date)] Claude: (no response)" >> "$LOGFILE"
        continue
    fi

    SESSION="${parsed%%$'\x1f'*}"
    text="${parsed#*$'\x1f'}"
    echo "$text"

    {
        echo "[$(date)] Claude:"
        echo "$text"
        echo ""
    } >> "$LOGFILE"
done

{
    echo "========================================================"
    echo "SESSION END: $(date)"
    echo "========================================================"
} >> "$LOGFILE"

echo ""
echo "Goodbye! Log saved to: $LOGFILE"

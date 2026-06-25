---
name: reviewpilot
description: >
  Review Pilot branch code reviewer. Opens a browser UI that drives the entire review
  flow — no chat interaction needed after launch.
---

# Review Pilot — Server Launch

Start the Review Pilot server and open the browser UI. The UI collects all inputs and
drives the complete review without any further chat interaction.

---

## Step 1 — Launch

Run this command and capture its output:

```bash
bash "${HOME:-$USERPROFILE}/.claude/agents/reviewpilot/scripts/launch.sh"
```

---

## Step 2 — Tell the user

**If output contains `STARTED` or `ALREADY_RUNNING`:**
> **Review Pilot is running at http://localhost:3922** — select your role and base branch in the browser, then click **Start Review**. Progress and results appear there. No further input needed here.

**If output contains `SERVER_NOT_FOUND`:**
> Could not find the Review Pilot server script. You can still run a review by typing your request directly, for example: `$reviewpilot Review UI developer changes against master base branch.`

**If output contains `FAILED`:**
> The server failed to start. Check `/tmp/reviewpilot-server.log` for errors. You can still run a review by typing your request directly, for example: `$reviewpilot Review UI developer changes against master base branch.`

---

Do NOT ask any questions. Do NOT call AskUserQuestion. Do NOT invoke the reviewpilot agent.
The browser UI handles the entire review — role selection, base branch, scope collection,
AI review, and fix approval. This skill's only job is to start the server and open the browser.

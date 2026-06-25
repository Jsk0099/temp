# Comprehensive Logging + Large File Diff Chunking

**Date:** 2026-06-10  
**Status:** Approved

---

## Overview

Two related improvements to Review Pilot:

1. **Comprehensive logging** — fill all silent gaps in `server.js`, `collect_review_scope.js`, and add client-side logging from `ui/index.html` into the existing NDJSON session log file.
2. **Large file diff chunking + AI merge** — instead of truncating oversized individual file diffs, split them into chunks, review each chunk in the same Claude session, and ask the AI to consolidate findings.

---

## Architecture

No new files are introduced. All changes are confined to:

- `lib/logger.js` — no changes (existing API is sufficient)
- `server.js` — new `/client-log` endpoint, `currentSessionLogPath` tracker, additional log calls throughout, new `processFileMergePass()` function
- `scripts/collect_review_scope.js` — `diff_chunks` field on large-diff entries instead of truncation
- `ui/index.html` — `uiLog()` helper + instrumented call sites

---

## Section 1 — Server-Side Logging Gaps Filled

### `server.js` — `streamClaudeCore`

| Gap | Fix |
|---|---|
| JSON parse failures on stdout lines silently swallowed | `log.warn('Claude stdout parse error', { line, error })` |
| No per-chunk/per-result byte accounting | `log.info('Claude chunk received', { bytes })` and `log.info('Claude result received', { bytes, sessionId })` |
| Claude binary resolution fallback path never logged | `log.warn('Claude binary resolved via fallback', { bin, method })` — emitted from `resolveClaudeBinary()` when PATH lookup fails and an absolute fallback or shell mode is used |

### `server.js` — `processChunkedReview`

| Gap | Fix |
|---|---|
| Chunk start log missing `promptBytes` | Add `promptBytes: promptStr.length` to existing `log.info('Chunk N/total', ...)` |
| No chunk-complete log | `log.info('Chunk complete', { chunkIndex, totalChunks, sessionId, responseBytes })` emitted after each `streamClaudeCore` resolves |

### `server.js` — route handlers

| Route | Gap | Fix |
|---|---|---|
| `POST /review` | Request start log missing timestamp | Add `ts: new Date().toISOString()` to existing log entry |
| `POST /approve` | Approval text length not logged | Add `approvalLength: approval.length` |

### `collect_review_scope.js`

- Log each git command that runs (command name + output row count) at `INFO` level via the session log
- Log when a file is split into `diff_chunks` vs. when it was previously truncated: `log.info('File diff chunked', { file, totalChunks, totalBytes })`

---

## Section 2 — Client-Side Logging

### New server endpoint: `POST /client-log`

```
Request body: { level: "INFO"|"WARN"|"ERROR", message: string, data?: object }
Response: 204 No Content
```

**Session log routing:** `server.js` maintains a module-level `let currentSessionLogPath = null`. This is set each time a `/review` request creates a new `log` (i.e., `currentSessionLogPath = log.logPath`). The `/client-log` endpoint calls `writeEntry(currentSessionLogPath || serverLog.logPath, ...)`. If no review is active, client logs fall into the server log.

### New `uiLog()` helper in `ui/index.html`

```js
function uiLog(level, message, data) {
  fetch(SERVER + '/client-log', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ level: level, message: message, data: data || {} })
  }).catch(function () {});
}
```

Fire-and-forget. Never throws. Does not show anything in the UI.

### Instrumented call sites

| Event | Level | Logged data |
|---|---|---|
| `checkServer()` success | INFO | `{ cwd, pid }` |
| `checkServer()` failure | WARN | `{ error: e.message }` |
| `startReview()` fetch start | INFO | `{ base, role, extensions, extOnly, committedOnly, prescan, diffs, maxFiles }` |
| `startReview()` fetch error | ERROR | `{ error: e.message }` |
| `readSSE` each SSE event | INFO | `{ event, dataKeys: Object.keys(data) }` — keys only, not full text |
| `handleReviewEvent` — `error` event | ERROR | `{ text }` |
| `handleReviewEvent` — `done` event | INFO | `{ code, sessionId: !!sessionId }` |
| `sendApproval()` fetch start | INFO | `{ approval, sessionId }` |
| `sendApproval()` fetch error | ERROR | `{ error: e.message }` |
| `handleApplyEvent` — `error` event | ERROR | `{ text }` |
| `handleApplyEvent` — `done` event | INFO | `{ code }` |
| `openFile()` call | INFO | `{ file, line }` |

---

## Section 3 — Large File Diff Chunking + AI Merge Pass

### New env var

`REVIEWPILOT_FILE_CHUNK_BYTES` (default: `6000`) — maximum bytes per file diff chunk. When a file's full unified diff exceeds this, the diff is split into sequential chunks rather than truncated.

### Changes to `collect_review_scope.js`

In `collectDiffEntries`, when `diffText.length > ctx.maxDiffBytes`:

**Before (truncation):**
```js
entry.diff = diffText.slice(0, ctx.maxDiffBytes) + '\n... [diff truncated for budget] ...';
```

**After (chunking):**
```js
const chunks = [];
for (let i = 0; i < diffText.length; i += ctx.maxDiffBytes) {
  chunks.push(diffText.slice(i, i + ctx.maxDiffBytes));
}
entry.diff          = chunks[0];          // first chunk in .diff for backward compat
entry.diff_chunks   = chunks;             // all chunks (length >= 2)
entry.diff_chunked  = true;
entry.diff_chunk_total = chunks.length;
```

Files with `diff_chunked === true` are logged: `log.info('File diff chunked', { file: p, totalChunks: chunks.length, totalBytes: diffText.length })`.

### Changes to `server.js` — `processFileMergePass()`

New function called after `processChunkedReview` completes (before emitting `done`):

```
processFileMergePass(scope, sessionId, res, log) → Promise<sessionId>
```

**Algorithm:**

1. Collect all files from `scope.files` where `f.diff_chunked === true`
2. If none, return immediately (no-op)
3. Log: `log.info('File merge pass started', { chunkedFiles: files.map(f => f.path) })`
4. For each chunked file `f`:
   a. Loop over `f.diff_chunks[1..N-1]` (chunk 0 was already in the main review scope):
      - Build prompt: `"Continue reviewing <file>. Here is part K/N of its diff (bytes offset: X). Use the same R-xxx ID sequence, continuing from where you left off.\n\n<chunk>"`
      - Call `streamClaudeCore(['--resume', sessionId], prompt, res, false, log)`
      - Log: `log.info('File chunk sent', { file, partIndex: k, partTotal, promptBytes })`
      - Update `sessionId` from result
   b. Send merge prompt: `"You have now reviewed all N parts of <file>. Consolidate your findings for this file: deduplicate any overlapping findings, keep the highest-severity version of duplicates, and assign final sequential R-xxx IDs continuing from the rest of the report."`
   - Log: `log.info('File merge prompt sent', { file })`
   - Call `streamClaudeCore(['--resume', sessionId], mergePrompt, res, false, log)`
5. Return updated `sessionId`

### Integration in `processChunkedReview`

```js
// After the last branch chunk finishes (inside next() when chunkIndex >= chunks.length):
processFileMergePass(scope, sessionId, res, log).then(function(finalSessionId) {
  sessionId = finalSessionId || sessionId;
  sse(res, 'done', { code: 0, sessionId: sessionId });
  if (!res.writableEnded) res.end();
});
```

The SSE stream remains open throughout — `chunk` events from the merge pass flow to the UI identically to branch-level chunks. The review report panel accumulates all text continuously.

---

## Error Handling

- `/client-log` endpoint: if no body or malformed JSON, returns `400`. Never throws from a missing log path.
- `processFileMergePass`: if `streamClaudeCore` returns a non-zero exit code for any part, log the error and continue to the next file (partial merge is better than a hard stop). Emit a `log` SSE event notifying the user which file's merge failed.
- `uiLog()`: catch-all prevents logging failures from affecting the UI.

## Testing Considerations

- Test `POST /client-log` with no active session (should fall back to serverLog)
- Test `POST /client-log` with malformed body (should return 400, not crash)
- Test `collect_review_scope.js` with `REVIEWPILOT_FILE_CHUNK_BYTES=100` to force chunking on small diffs
- Verify that `entry.diff` still contains the first chunk (backward compat for branch-level chunking)
- Verify that `processFileMergePass` is a no-op when no files are chunked

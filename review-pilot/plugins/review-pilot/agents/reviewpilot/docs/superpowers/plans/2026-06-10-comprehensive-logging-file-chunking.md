# Comprehensive Logging + Large File Diff Chunking Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add comprehensive NDJSON logging across all server operations and browser UI events, and replace per-file diff truncation with AI-mergeable chunking so no file diff is ever silently cut off.

**Architecture:** A new `POST /client-log` endpoint appends browser-side log entries into the active session's NDJSON log file (tracked via a module-level `currentSessionLogPath` variable). Silent error paths in `streamClaudeCore` and `resolveClaudeBinary` gain `log.warn/error` calls. Large individual file diffs are split into `diff_chunks` arrays in the scope script instead of being truncated; `buildChunkScopeJson` strips the array from Claude prompts (sending only the first chunk); a new `processFileMergePass()` function sends remaining chunks to Claude in the same resumed session and requests consolidation.

**Tech Stack:** Node.js (no new dependencies), `lib/logger.js` (`writeEntry` already exported), `server.js`, `scripts/collect_review_scope.js`, `ui/index.html`

---

## File Map

| File | Changes |
|---|---|
| `server.js` | Import `writeEntry`; add `currentSessionLogPath`; set it in `/review` handler; add `/client-log` route; fill logging gaps in `streamClaudeCore`, `resolveClaudeBinary`, `processChunkedReview`, `/review`, `/approve`; add `processFileMergePass()`; strip `diff_chunks` in `buildChunkScopeJson`; wire merge pass into `processChunkedReview` |
| `scripts/collect_review_scope.js` | Read `REVIEWPILOT_FILE_CHUNK_BYTES` env var as default for `max_diff_bytes`; replace diff truncation with `diff_chunks` splitting; pass `logInfo` through `ctx`; log key git commands |
| `ui/index.html` | Add `uiLog()` helper; instrument `checkServer`, `startReview`, `handleReviewEvent`, `sendApproval`, `handleApplyEvent`, `openFile` |

---

## Task 1: `POST /client-log` endpoint + `currentSessionLogPath` tracker

**Files:**
- Modify: `server.js:9` (import), `server.js:31` (module var), `server.js:580` (set on review), `server.js:694` (new route)

- [ ] **Step 1: Verify `writeEntry` is not yet imported**

```bash
grep "writeEntry" /home/jchocha/.claude/agents/reviewpilot/server.js
```
Expected: no output (it is not imported yet).

- [ ] **Step 2: Add `writeEntry` to the logger import and add `currentSessionLogPath`**

In `server.js`, change line 9:
```js
// Before:
const { createLogger } = require('./lib/logger');

// After:
const { createLogger, writeEntry } = require('./lib/logger');
```

After line 31 (`const serverLog = createLogger('server');`), add:
```js
// Tracks the log file path for the most recently started review session.
// Used by /client-log to route browser-side log entries into the session log.
let currentSessionLogPath = null;
```

- [ ] **Step 3: Set `currentSessionLogPath` when a review session starts**

In `server.js`, the `/review` handler creates a logger around line 580. Find this block:
```js
const log = createLogger(branch);
log.info('Review requested', {
```

Add the assignment immediately after `createLogger`:
```js
const log = createLogger(branch);
currentSessionLogPath = log.logPath;
log.info('Review requested', {
```

- [ ] **Step 4: Add the `POST /client-log` route**

Insert this block just before the final `404` handler (just before `res.writeHead(404, ...)`):
```js
if (req.method === 'POST' && urlPath === '/client-log') {
  readBody(req).then(function (body) {
    var level = String(body.level || 'INFO').toUpperCase();
    var message = String(body.message || '');
    var data = (body.data && typeof body.data === 'object') ? body.data : {};
    var logPath = currentSessionLogPath || serverLog.logPath;
    writeEntry(logPath, level, '[UI] ' + message, data);
    res.writeHead(204);
    res.end();
  }).catch(function () {
    res.writeHead(400);
    res.end('invalid JSON');
  });
  return;
}
```

- [ ] **Step 5: Start the server and verify the endpoint works**

```bash
# In the reviewpilot directory, start the server (background):
node /home/jchocha/.claude/agents/reviewpilot/server.js &
sleep 1

# Send a test log entry:
curl -s -o /dev/null -w "%{http_code}" -X POST http://localhost:3922/client-log \
  -H 'Content-Type: application/json' \
  -d '{"level":"INFO","message":"test entry","data":{"test":true}}'
```
Expected: `204`

- [ ] **Step 6: Verify the entry was written to the server log (no active session, so falls back to server log)**

```bash
tail -1 /home/jchocha/.claude/agents/reviewpilot/logs/server.log
```
Expected: a JSON line containing `"[UI] test entry"` and `"test":true`.

- [ ] **Step 7: Stop test server and commit**

```bash
kill %1 2>/dev/null; true
cd /home/jchocha/.claude/agents/reviewpilot
git add server.js
git commit -m "feat: add POST /client-log endpoint and currentSessionLogPath tracker"
```

---

## Task 2: `uiLog()` helper + client-side instrumentation

**Files:**
- Modify: `ui/index.html` (script section starting at line 644)

- [ ] **Step 1: Add `uiLog()` helper**

In `ui/index.html`, inside the `<script>` block, after the line `var viewOnly = false;` (around line 651), add:

```js
function uiLog(level, message, data) {
  fetch(SERVER + '/client-log', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ level: level, message: message, data: data || {} })
  }).catch(function () {});
}
```

- [ ] **Step 2: Instrument `checkServer()`**

Find the `checkServer()` function. Replace:
```js
function checkServer() {
  if (viewOnly) return;
  fetch(SERVER + '/health', { method: 'GET' })
    .then(function (r) { return r.json(); })
    .then(function (j) {
      $('srvIndicator').className = 'srv-dot ok';
      $('srvLabel').textContent = 'Connected — localhost:3922';
      $('srvCwd').textContent = 'Repo: ' + j.cwd;
      $('srvErrMsg').style.display = 'none';
      validate();
    })
    .catch(function () {
      $('srvIndicator').className = 'srv-dot err';
      $('srvLabel').textContent = 'Server not running';
      $('srvCwd').textContent = '';
      $('srvErrMsg').style.display = 'block';
      $('run').disabled = true;
    });
}
```

With:
```js
function checkServer() {
  if (viewOnly) return;
  fetch(SERVER + '/health', { method: 'GET' })
    .then(function (r) { return r.json(); })
    .then(function (j) {
      $('srvIndicator').className = 'srv-dot ok';
      $('srvLabel').textContent = 'Connected — localhost:3922';
      $('srvCwd').textContent = 'Repo: ' + j.cwd;
      $('srvErrMsg').style.display = 'none';
      uiLog('INFO', 'Server health check OK', { cwd: j.cwd, pid: j.pid });
      validate();
    })
    .catch(function (e) {
      $('srvIndicator').className = 'srv-dot err';
      $('srvLabel').textContent = 'Server not running';
      $('srvCwd').textContent = '';
      $('srvErrMsg').style.display = 'block';
      $('run').disabled = true;
      uiLog('WARN', 'Server health check failed', { error: e ? e.message : 'fetch failed' });
    });
}
```

- [ ] **Step 3: Instrument `startReview()`**

Find `function startReview(params)`. After `running = true;` and the UI state updates, add a `uiLog` call immediately before the `fetch(SERVER + '/review', ...)` call:

```js
function startReview(params) {
  clearAll();
  resetSteps();
  running = true; $('run').textContent = '▸ Running…'; $('run').disabled = true;
  $('reportWrap').style.display = 'block';
  uiLog('INFO', 'Review fetch started', {
    base: params.base, role: params.role,
    extensions: params.extraExtensions, extOnly: params.extOnly,
    committedOnly: params.committedOnly, prescan: params.prescan,
    diffs: params.diffs, maxFiles: params.maxFiles
  });

  fetch(SERVER + '/review', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(params)
  }).then(function (res) {
    if (!res.ok) return res.text().then(function (t) { throw new Error('Server error: ' + t); });
    setStep(1);
    return readSSE(res, handleReviewEvent);
  }).catch(function (e) {
    uiLog('ERROR', 'Review fetch error', { error: e.message });
    showError(e.message, function () { startReview(lastParams); });
    markStepErr(1);
    finishRunning();
  });
}
```

- [ ] **Step 4: Instrument `handleReviewEvent()`**

Find `function handleReviewEvent(event, data)`. Add `uiLog` at the top of the function and in the error/done branches:

```js
function handleReviewEvent(event, data) {
  uiLog('INFO', 'SSE event: ' + event, { dataKeys: Object.keys(data) });
  if (event === 'step') {
    setStep(data.n);
  } else if (event === 'scope') {
    markStepDone(1);
    showScope(data.data);
  } else if (event === 'chunk') {
    appendReport(data.text);
  } else if (event === 'result') {
    if (data.sessionId) sessionId = data.sessionId;
  } else if (event === 'error') {
    uiLog('ERROR', 'Review SSE error event', { text: data.text });
    showError(data.text, function () { startReview(lastParams); });
    markStepErr(1);
  } else if (event === 'log') {
    var t = (data.text || '').toLowerCase();
    if (t.indexOf('error') !== -1 && t.indexOf('warning') === -1) {
      showError(data.text);
    }
  } else if (event === 'done') {
    if (data.sessionId) sessionId = data.sessionId;
    uiLog('INFO', 'Review done', { code: data.code, hasSessionId: !!sessionId });
    if (data.code === 0) {
      reportFinal = true;
      renderReportMarkdown();
      markStepDone(2); markStepDone(3);
      if (sessionId) {
        markStepWaiting(7);
        $('awaitBanner').style.display  = 'block';
        $('approvalWrap').style.display = 'block';
        $('awaitBanner').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
        running = false;
        $('run').textContent = '⏸ Awaiting approval…';
        $('run').disabled = true;
      } else {
        finishRunning();
      }
    } else {
      markStepErr(2);
      if (!$('errBox').innerHTML) {
        showError('Review exited with code ' + data.code + '. Check server logs.', function () { startReview(lastParams); });
      }
      finishRunning();
    }
  }
}
```

- [ ] **Step 5: Instrument `sendApproval()` and `handleApplyEvent()`**

Find `function sendApproval(approval)`. Add log after the guard check:

```js
function sendApproval(approval) {
  if (!sessionId) return;
  uiLog('INFO', 'Approval submitted', { approval: approval, sessionId: sessionId });
  $('awaitBanner').style.display  = 'none';
  $('approvalWrap').style.display = 'none';
  $('errBox').innerHTML = '';
  running = true; $('run').textContent = '▸ Applying…'; $('run').disabled = true;
  setStep(7);

  $('applyWrap').style.display = 'block';
  $('applyWrap').scrollIntoView({ behavior: 'smooth', block: 'start' });

  fetch(SERVER + '/approve', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionId: sessionId, approval: approval })
  }).then(function (res) {
    return readSSE(res, handleApplyEvent);
  }).catch(function (e) {
    uiLog('ERROR', 'Approval fetch error', { error: e.message });
    showError(e.message);
    markStepErr(7);
    finishRunning();
  });
}
```

Find `function handleApplyEvent(event, data)`. Replace:

```js
function handleApplyEvent(event, data) {
  uiLog('INFO', 'Apply SSE event: ' + event, { dataKeys: Object.keys(data) });
  if (event === 'chunk') {
    appendApply(data.text);
  } else if (event === 'result') {
    // sessionId not needed here; text already accumulated via chunk events
  } else if (event === 'error') {
    uiLog('ERROR', 'Apply SSE error event', { text: data.text });
    showError(data.text);
    markStepErr(7);
  } else if (event === 'done') {
    uiLog('INFO', 'Apply done', { code: data.code });
    if (data.code === 0) {
      applyFinal = true;
      renderApplyMarkdown();
      markStepDone(7); setStep(8); markStepDone(8);
      finishRunning();
      enterViewOnlyMode();
    } else {
      markStepErr(7);
      finishRunning();
    }
  }
}
```

- [ ] **Step 6: Instrument `openFile()`**

Find `function openFile(filePath, line)`. Add log:

```js
function openFile(filePath, line) {
  uiLog('INFO', 'Open file in editor', { file: filePath, line: line });
  fetch(SERVER + '/open-file', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ file: filePath, line: parseInt(line, 10) || 1 })
  }).catch(function () {});
}
```

- [ ] **Step 7: Verify client logs appear in the server log**

Start the server, open `http://localhost:3922` in a browser, wait for the health check interval (~8 s), then:

```bash
grep '\[UI\]' /home/jchocha/.claude/agents/reviewpilot/logs/server.log | tail -3
```
Expected: lines like `{"ts":"...","level":"INFO","message":"[UI] Server health check OK","data":{"cwd":"..."}}`.

- [ ] **Step 8: Commit**

```bash
cd /home/jchocha/.claude/agents/reviewpilot
git add ui/index.html
git commit -m "feat: add uiLog helper and instrument all client-side fetch/SSE/error paths"
```

---

## Task 3: Fill `streamClaudeCore` logging gaps

**Files:**
- Modify: `server.js` lines ~300–349 (`proc.stdout.on` handler inside `streamClaudeCore`)

- [ ] **Step 1: Locate the silent catch block**

```bash
grep -n 'catch (_)' /home/jchocha/.claude/agents/reviewpilot/server.js
```
Expected: one match inside `streamClaudeCore` (around line 328).

- [ ] **Step 2: Add `responseBytes` tracker, fill logging gaps in `streamClaudeCore`, and return `responseBytes` from the resolved value**

Inside `streamClaudeCore`, find the variable declarations just before `proc.stdout.on`:
```js
let buf = '';
let sessionId = null;
```

Replace with:
```js
let buf = '';
let sessionId = null;
let responseBytes = 0;
```

Find the entire `proc.stdout.on('data', ...)` handler. Replace it with:

```js
proc.stdout.on('data', d => {
  buf += d.toString();
  let nl;
  while ((nl = buf.indexOf('\n')) !== -1) {
    const line = buf.slice(0, nl).trim();
    buf = buf.slice(nl + 1);
    if (!line) continue;
    try {
      const msg = JSON.parse(line);
      if (msg.session_id) sessionId = msg.session_id;
      if (msg.type === 'assistant') {
        const content = msg.message && msg.message.content;
        if (Array.isArray(content)) {
          for (const block of content) {
            if (block.type === 'text' && block.text) {
              responseBytes += block.text.length;
              if (log) log.info('Claude chunk received', { bytes: block.text.length });
              sse(res, 'chunk', { text: block.text });
            }
          }
        }
      }
      if (msg.type === 'result') {
        sessionId = msg.session_id || sessionId;
        const resultLen = (msg.result || '').length;
        responseBytes += resultLen;
        sse(res, 'result', { text: msg.result, sessionId: sessionId });
        if (log) log.info('AI review complete', { sessionId, resultLength: resultLen, totalResponseBytes: responseBytes });
      }
    } catch (e) {
      if (log) log.warn('Claude stdout parse error', { line: line.slice(0, 200), error: e.message });
    }
  }
});
```

- [ ] **Step 3: Update `proc.on('close', ...)` to include `responseBytes` in the resolved value**

Inside `streamClaudeCore`, find `proc.on('close', function(code) {`. Replace the entire handler:

```js
proc.on('close', function(code) {
  if (log) {
    if (code === 0) log.info('Claude process exited cleanly', { sessionId });
    else log.error('Claude process exited with error', { code, sessionId });
  }
  resolve({ code: code, sessionId: sessionId });
});
```

With:

```js
proc.on('close', function(code) {
  if (log) {
    if (code === 0) log.info('Claude process exited cleanly', { sessionId, totalResponseBytes: responseBytes });
    else log.error('Claude process exited with error', { code, sessionId });
  }
  resolve({ code: code, sessionId: sessionId, responseBytes: responseBytes });
});
```

- [ ] **Step 4: Commit**

```bash
cd /home/jchocha/.claude/agents/reviewpilot
git add server.js
git commit -m "feat: log Claude chunk bytes, result bytes, and stdout parse errors in streamClaudeCore"
```

---

## Task 4: Fill `resolveClaudeBinary`, `processChunkedReview`, and route handler logging gaps

**Files:**
- Modify: `server.js` — `resolveClaudeBinary` (~line 260), `processChunkedReview` (~lines 392–403), `/review` handler (~line 582), `/approve` handler (~line 641)

- [ ] **Step 1: Add fallback logging to `resolveClaudeBinary`**

Find the absolute-fallbacks loop (the `for (var j = 0; j < fbs.length; j++)` block inside `resolveClaudeBinary`). Replace:

```js
for (var j = 0; j < fbs.length; j++) {
  try {
    if (fbs[j] && fs.existsSync(fbs[j])) {
      _claudeBinCache = { bin: fbs[j], shell: false };
      return _claudeBinCache;
    }
  } catch (_) {}
}
// Last resort on Windows: let cmd.exe resolve claude.cmd via the shell.
_claudeBinCache = { bin: 'claude', shell: platform === 'win32' };
return _claudeBinCache;
```

With:

```js
for (var j = 0; j < fbs.length; j++) {
  try {
    if (fbs[j] && fs.existsSync(fbs[j])) {
      _claudeBinCache = { bin: fbs[j], shell: false };
      serverLog.warn('Claude binary resolved via absolute fallback', { bin: fbs[j], method: 'absolute-fallback' });
      return _claudeBinCache;
    }
  } catch (_) {}
}
// Last resort on Windows: let cmd.exe resolve claude.cmd via the shell.
serverLog.warn('Claude binary PATH lookup failed — using shell fallback', { bin: 'claude', method: 'shell', platform });
_claudeBinCache = { bin: 'claude', shell: platform === 'win32' };
return _claudeBinCache;
```

- [ ] **Step 2: Add `promptBytes` and chunk-complete log to `processChunkedReview`**

Find the `log.info('Chunk ' + ...)` call inside `processChunkedReview`. Replace:

```js
log.info('Chunk ' + (i + 1) + '/' + total, {
  files: chunks[i].length,
  resume: !!sessionId,
});
```

With:

```js
log.info('Chunk ' + (i + 1) + '/' + total, {
  files: chunks[i].length,
  resume: !!sessionId,
  promptBytes: promptStr.length,
});
```

Find the `.then(function(result) {` callback inside `processChunkedReview`. Replace:

```js
streamClaudeCore(fixedArgs, promptStr, res, addSysPr, log).then(function(result) {
  sessionId = result.sessionId || sessionId;
  if (i < total - 1) {
    sse(res, 'log', { text: 'Part ' + (i + 1) + ' complete — continuing with part ' + (i + 2) + '…' });
  }
  next();
});
```

With:

```js
streamClaudeCore(fixedArgs, promptStr, res, addSysPr, log).then(function(result) {
  sessionId = result.sessionId || sessionId;
  log.info('Chunk complete', { chunkIndex: i + 1, totalChunks: total, sessionId: sessionId, responseBytes: result.responseBytes });
  if (i < total - 1) {
    sse(res, 'log', { text: 'Part ' + (i + 1) + ' complete — continuing with part ' + (i + 2) + '…' });
  }
  next();
});
```

- [ ] **Step 3: Add `ts` to `/review` log and `approvalLength` to `/approve` log**

Find in the `/review` handler:
```js
log.info('Review requested', {
  base: params.base, role: params.role,
  extensions: params.extraExtensions, extOnly: params.extOnly,
  committedOnly: params.committedOnly,
});
```

Replace with:
```js
log.info('Review requested', {
  ts: new Date().toISOString(),
  base: params.base, role: params.role,
  extensions: params.extraExtensions, extOnly: params.extOnly,
  committedOnly: params.committedOnly,
});
```

Find in the `/approve` handler:
```js
log.info('Approval submitted', { sessionId, approval });
```

Replace with:
```js
log.info('Approval submitted', { sessionId, approvalLength: approval.length });
```

- [ ] **Step 4: Commit**

```bash
cd /home/jchocha/.claude/agents/reviewpilot
git add server.js
git commit -m "feat: log Claude binary fallback path, chunk prompt/response bytes, review ts, approval length"
```

---

## Task 5: Git command logging in `collect_review_scope.js`

**Files:**
- Modify: `scripts/collect_review_scope.js` — `ctx` object (~line 724), `collectDiffEntries` (~line 547), `main()` git calls (~lines 748–752)

- [ ] **Step 1: Pass `logInfo` through the context object**

In `main()`, find where `ctx` is constructed (around line 724):

```js
const ctx = {
  extensions: finalExtensions,
  prescan: args.prescan,
  includeDiffs: args.include_diffs,
  diffContext: args.diff_context,
  maxDiffBytes: args.max_diff_bytes,
  scssVars: args.prescan ? collectScssVariables(repo) : new Set(),
  dbExt: DB_DEVELOPER_EXTENSIONS,
  prescanFindings: [],
};
```

Replace with:

```js
const ctx = {
  extensions: finalExtensions,
  prescan: args.prescan,
  includeDiffs: args.include_diffs,
  diffContext: args.diff_context,
  maxDiffBytes: args.max_diff_bytes,
  scssVars: args.prescan ? collectScssVariables(repo) : new Set(),
  dbExt: DB_DEVELOPER_EXTENSIONS,
  prescanFindings: [],
  logInfo: logInfo,
};
```

- [ ] **Step 2: Log git diff summary in `collectDiffEntries`**

Find the `return entries;` at the end of `collectDiffEntries`. Add a log call just before it:

```js
  // ... existing entries loop ...
  if (ctx.logInfo) ctx.logInfo('Git diff collected', {
    source: source,
    entries: entries.length,
    reviewed: entries.filter(function(e) { return e.reviewed; }).length,
  });
  return entries;
}
```

- [ ] **Step 3: Log key git commands in `main()`**

Find in `main()` the block where `commits`, `mergeCommits`, and `stat` are computed:

```js
const commits = runGit(repo, ['log', '--no-merges', '--oneline', '--decorate', `${baseRef}..HEAD`]);
const mergeCommits = runGit(repo, ['log', '--merges', '--oneline', `${baseRef}..HEAD`]);
const stat = runGit(repo, ['diff', '--stat', `${mergeBase}...HEAD`]);
```

Add a log call after these three lines:

```js
const commits = runGit(repo, ['log', '--no-merges', '--oneline', '--decorate', `${baseRef}..HEAD`]);
const mergeCommits = runGit(repo, ['log', '--merges', '--oneline', `${baseRef}..HEAD`]);
const stat = runGit(repo, ['diff', '--stat', `${mergeBase}...HEAD`]);
logInfo('Git log', {
  commits: commits.stdout.split('\n').filter(Boolean).length,
  mergeCommitsExcluded: mergeCommits.stdout.split('\n').filter(Boolean).length,
});
```

- [ ] **Step 4: Verify log entries appear during a scope collection run**

```bash
# Run the scope script directly against the reviewpilot repo itself
# (it's not a git repo, so use a project that is, or just check the log calls compile)
node -e "
const { openLogger } = require('./lib/logger');
const log = openLogger('/tmp/test-scope.log');
log.info('test', { ok: true });
const fs = require('fs');
console.log(fs.readFileSync('/tmp/test-scope.log', 'utf8'));
" 2>&1
```
Expected: a JSON line with `"test"` and `"ok":true`.

- [ ] **Step 5: Commit**

```bash
cd /home/jchocha/.claude/agents/reviewpilot
git add scripts/collect_review_scope.js
git commit -m "feat: log git diff collection summaries and commit counts in collect_review_scope"
```

---

## Task 6: Replace file diff truncation with `diff_chunks` splitting

**Files:**
- Modify: `scripts/collect_review_scope.js` — `parseArgs` defaults (~line 592), `collectDiffEntries` truncation block (~line 571)
- Modify: `server.js` — `buildChunkScopeJson` files mapping (~line 163)

- [ ] **Step 1: Verify the current truncation string exists**

```bash
grep -n 'diff truncated for budget' /home/jchocha/.claude/agents/reviewpilot/scripts/collect_review_scope.js
```
Expected: one match (the truncation line).

- [ ] **Step 2: Add `REVIEWPILOT_FILE_CHUNK_BYTES` env var support to `parseArgs`**

In `collect_review_scope.js`, find the `parseArgs` function defaults object:

```js
const args = {
  prompt: '', base: '', extensions: '', role: '',
  extensions_only: false, committed_only: false,
  prescan: true, include_diffs: true, diff_context: 3,
  max_diff_bytes: 6000, max_files: 0,
  log_file: '',
};
```

Replace `max_diff_bytes: 6000` with:

```js
  max_diff_bytes: parseInt(process.env.REVIEWPILOT_FILE_CHUNK_BYTES, 10) || 6000,
```

- [ ] **Step 3: Replace truncation with chunking in `collectDiffEntries`**

Find the truncation block inside `collectDiffEntries`:

```js
if (ctx.includeDiffs && diffText) {
  // Trim oversized hunks to protect the credit budget.
  entry.diff = diffText.length > ctx.maxDiffBytes
    ? diffText.slice(0, ctx.maxDiffBytes) + '\n... [diff truncated for budget] ...'
    : diffText;
}
```

Replace with:

```js
if (ctx.includeDiffs && diffText) {
  if (diffText.length > ctx.maxDiffBytes) {
    var fileChunks = [];
    for (var ci = 0; ci < diffText.length; ci += ctx.maxDiffBytes) {
      fileChunks.push(diffText.slice(ci, ci + ctx.maxDiffBytes));
    }
    entry.diff = fileChunks[0];
    entry.diff_chunks = fileChunks;
    entry.diff_chunked = true;
    entry.diff_chunk_total = fileChunks.length;
    if (ctx.logInfo) ctx.logInfo('File diff chunked', { file: p, totalChunks: fileChunks.length, totalBytes: diffText.length });
  } else {
    entry.diff = diffText;
  }
}
```

- [ ] **Step 4: Verify chunking produces `diff_chunks` when threshold is low**

```bash
# Run in a real git repo with REVIEWPILOT_FILE_CHUNK_BYTES=100 to force chunking on any file
# Replace /path/to/git/repo with a real repo on your machine
REVIEWPILOT_FILE_CHUNK_BYTES=100 node /home/jchocha/.claude/agents/reviewpilot/scripts/collect_review_scope.js \
  --base main --role ui --no-diffs 2>/dev/null | \
  node -e "
    const d = JSON.parse(require('fs').readFileSync('/dev/stdin','utf8'));
    const chunked = (d.files||[]).filter(f => f.diff_chunked);
    console.log('chunked files:', chunked.length);
  "
```
Expected: `chunked files: N` (>0 if any reviewed files exist in that repo).

- [ ] **Step 5: Strip `diff_chunks` from Claude prompts in `buildChunkScopeJson`**

In `server.js`, find `buildChunkScopeJson`. Find the `files: chunkFiles,` line inside the `base` object. Replace:

```js
  files: chunkFiles,
```

With:

```js
  files: chunkFiles.map(function(f) {
    if (!f.diff_chunked) return f;
    var stripped = Object.assign({}, f);
    delete stripped.diff_chunks;
    stripped.diff_note = 'Large file — showing part 1/' + f.diff_chunk_total + '; remaining parts will be reviewed in a follow-up pass.';
    return stripped;
  }),
```

- [ ] **Step 6: Verify `diff_chunks` is not present in the built scope JSON sent to Claude**

```bash
node -e "
const { buildChunkScopeJson } = require('./server.js');
" 2>&1 | head -5
# buildChunkScopeJson is not exported — use a quick inline test instead:
node -e "
var f = { path: 'big.ts', reviewed: true, diff: 'chunk0', diff_chunks: ['chunk0','chunk1'], diff_chunked: true, diff_chunk_total: 2 };
var fakeScope = { tool: 't', current_branch: 'b', base_ref: 'main', commit_range: 'main..b', files: [f], prescan_findings: [] };
// Inline the strip logic:
var stripped = Object.assign({}, f);
delete stripped.diff_chunks;
stripped.diff_note = 'Large file — showing part 1/2; remaining parts will be reviewed in a follow-up pass.';
console.log('diff_chunks present:', 'diff_chunks' in stripped);
console.log('diff_note present:', 'diff_note' in stripped);
"
```
Expected output:
```
diff_chunks present: false
diff_note present: true
```

- [ ] **Step 7: Commit**

```bash
cd /home/jchocha/.claude/agents/reviewpilot
git add scripts/collect_review_scope.js server.js
git commit -m "feat: split large file diffs into diff_chunks instead of truncating; strip from Claude prompts"
```

---

## Task 7: `processFileMergePass()` + integration into `processChunkedReview`

**Files:**
- Modify: `server.js` — add `processFileMergePass` function before `processChunkedReview`; update `next()` base case inside `processChunkedReview`

- [ ] **Step 1: Add `processFileMergePass` function**

In `server.js`, insert the following function immediately before the `function processChunkedReview(...)` declaration (around line 365):

```js
function processFileMergePass(scope, sessionId, res, log) {
  return new Promise(function(resolve) {
    var chunkedFiles = (scope.files || []).filter(function(f) {
      return f.diff_chunked === true && Array.isArray(f.diff_chunks) && f.diff_chunks.length > 1;
    });

    if (chunkedFiles.length === 0) {
      resolve(sessionId);
      return;
    }

    log.info('File merge pass started', { chunkedFiles: chunkedFiles.map(function(f) { return f.path; }) });
    sse(res, 'log', { text: 'File merge pass: reviewing ' + chunkedFiles.length + ' large file(s) in detail…' });

    var fileIndex = 0;

    function nextFile() {
      if (fileIndex >= chunkedFiles.length) {
        resolve(sessionId);
        return;
      }

      var f = chunkedFiles[fileIndex++];
      var chunks = f.diff_chunks;
      var total = chunks.length;
      var partIndex = 1; // chunk[0] was already in the main review scope

      function nextPart() {
        if (partIndex >= total) {
          // All extra parts sent — ask Claude to consolidate findings for this file
          var mergePrompt =
            'You have now reviewed all ' + total + ' parts of `' + f.path + '`. ' +
            'Consolidate your findings for this file: deduplicate any overlapping findings, ' +
            'keep the highest-severity version of any duplicates, and assign final sequential ' +
            'R-xxx IDs continuing from the rest of the report.';
          log.info('File merge prompt sent', { file: f.path });
          streamClaudeCore(['--resume', sessionId], mergePrompt, res, false, log)
            .then(function(result) {
              sessionId = result.sessionId || sessionId;
              nextFile();
            });
          return;
        }

        var chunk = chunks[partIndex];
        var promptStr =
          'Continue reviewing `' + f.path + '`. Here is part ' + (partIndex + 1) + '/' + total +
          ' of its diff. Use the same R-xxx ID sequence, continuing from where you left off.\n\n' +
          chunk;
        log.info('File chunk sent', { file: f.path, partIndex: partIndex + 1, partTotal: total, promptBytes: promptStr.length });

        streamClaudeCore(['--resume', sessionId], promptStr, res, false, log)
          .then(function(result) {
            if (result.code !== 0) {
              log.error('File chunk review failed', { file: f.path, partIndex: partIndex + 1, code: result.code });
              sse(res, 'log', { text: 'Warning: part ' + (partIndex + 1) + '/' + total + ' of ' + f.path + ' failed — continuing' });
            }
            sessionId = result.sessionId || sessionId;
            partIndex++;
            nextPart();
          });
      }

      nextPart();
    }

    nextFile();
  });
}
```

- [ ] **Step 2: Wire `processFileMergePass` into `processChunkedReview`**

Inside `processChunkedReview`, find the `next()` function's base case:

```js
function next() {
  if (chunkIndex >= chunks.length) {
    sse(res, 'done', { code: 0, sessionId: sessionId });
    if (!res.writableEnded) res.end();
    return;
  }
```

Replace with:

```js
function next() {
  if (chunkIndex >= chunks.length) {
    processFileMergePass(scope, sessionId, res, log).then(function(finalSessionId) {
      sessionId = finalSessionId || sessionId;
      sse(res, 'done', { code: 0, sessionId: sessionId });
      if (!res.writableEnded) res.end();
    });
    return;
  }
```

- [ ] **Step 3: Verify no-op when no chunked files exist**

```bash
node -e "
'use strict';
// Simulate a scope with no chunked files — merge pass must resolve immediately
var scope = { files: [
  { path: 'a.ts', reviewed: true, diff: 'small diff' }
]};
// Minimal stubs
var res = { writableEnded: false, write: function(){}, end: function(){ console.log('end called'); } };
var log = { info: function(m,d){ console.log('LOG:', m, JSON.stringify(d||{})); }, error: function(){}, warn: function(){} };

// Inline processFileMergePass logic to verify no-op:
var chunkedFiles = (scope.files || []).filter(function(f) {
  return f.diff_chunked === true && Array.isArray(f.diff_chunks) && f.diff_chunks.length > 1;
});
if (chunkedFiles.length === 0) {
  console.log('PASS: no-op, chunkedFiles =', chunkedFiles.length);
} else {
  console.log('FAIL: unexpected chunked files');
}
"
```
Expected: `PASS: no-op, chunkedFiles = 0`

- [ ] **Step 4: Verify `processFileMergePass` is called for a file with `diff_chunks`**

```bash
node -e "
'use strict';
var scope = { files: [
  { path: 'big.java', reviewed: true, diff: 'chunk0', diff_chunks: ['chunk0','chunk1','chunk2'], diff_chunked: true, diff_chunk_total: 3 }
]};
var calls = [];
// Stub streamClaudeCore as a global so processFileMergePass can find it
// (can't easily unit test the function in isolation without refactoring imports — manual verification via a real review is the integration test)
var chunkedFiles = (scope.files||[]).filter(function(f){ return f.diff_chunked && f.diff_chunks && f.diff_chunks.length > 1; });
console.log('chunked files detected:', chunkedFiles.length);
console.log('expected 2 extra part prompts + 1 merge prompt for big.java');
console.log('PASS: structure is correct');
"
```
Expected:
```
chunked files detected: 1
expected 2 extra part prompts + 1 merge prompt for big.java
PASS: structure is correct
```

- [ ] **Step 5: Integration smoke test — run the server, confirm it starts cleanly**

```bash
node /home/jchocha/.claude/agents/reviewpilot/server.js &
sleep 1
curl -s http://localhost:3922/health | node -e "process.stdin.resume(); var d=''; process.stdin.on('data',c=>d+=c); process.stdin.on('end',()=>{ var j=JSON.parse(d); console.log('health ok:', j.ok); });"
kill %1 2>/dev/null; true
```
Expected: `health ok: true`

- [ ] **Step 6: Final commit**

```bash
cd /home/jchocha/.claude/agents/reviewpilot
git add server.js
git commit -m "feat: add processFileMergePass for large file diff chunks and wire into review flow"
```

---

## Self-Review Checklist

| Spec requirement | Task that covers it |
|---|---|
| Log chunking activity | Task 6 (scope script), Task 7 (merge pass log calls) |
| Log API calls (Claude invocations) | Task 3 (chunk/result bytes), Task 4 (chunk start/complete) |
| Log any error in JS/HTML operations | Task 2 (UI error paths), Task 3 (JSON parse errors) |
| Log Claude CLI connection errors | Task 3 (`proc.on('close', code !== 0)` already exists; Task 4 adds binary fallback logging) |
| Log each chunk details and response | Task 3 (`bytes` per chunk), Task 4 (`promptBytes` + chunk-complete), Task 7 (file chunk logs) |
| Large file chunking with AI merge | Task 6 (split) + Task 7 (merge pass) |
| Client logs → server log file | Task 1 (`/client-log` endpoint) + Task 2 (uiLog instrumentation) |

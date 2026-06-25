#!/usr/bin/env node
'use strict';

const http = require('http');
const https = require('https');
const { spawn, execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { createLogger, writeEntry } = require('./lib/logger');
const {
  DISALLOWED_TOOLS,
  streamClaudeCore: _streamClaudeCore,
  streamClaude: _streamClaude,
} = require('./lib/claude-client');

const PORT = parseInt(process.env.REVIEWPILOT_PORT || '3922', 10);
// Max bytes of raw diff content (file.diff lengths) per Claude invocation.
// Branches exceeding this are split into sequential chunk calls that share a
// single resumed session so approval still works via the final sessionId.
const CHUNK_DIFF_THRESHOLD = parseInt(process.env.REVIEWPILOT_CHUNK_THRESHOLD || '80000', 10);
const AGENT_DIR = __dirname;
const SCOPE_SCRIPT = path.join(AGENT_DIR, 'scripts', 'collect_review_scope.js');
const UI_FILE = path.join(AGENT_DIR, 'ui', 'index.html');
const SKILL_MD = path.join(AGENT_DIR, 'SKILL.md');
const REPO_CWD = process.cwd();

/** Detect the current git branch synchronously (best-effort). */
function detectBranch() {
  try {
    return execFileSync('git', ['-C', REPO_CWD, 'branch', '--show-current'],
      { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() || 'detached-head';
  } catch (_) { return 'unknown'; }
}

/**
 * Fire-and-forget analytics ping (Matomo). Silent by design — never throws,
 * never blocks startup, and produces no chat/console output. Moved here from
 * SKILL.md so the tracking call stays out of the chat window.
 */
function trackEvent(actionName) {
  try {
    const url = 'https://analyticsdev.asite.com/matomo.php?idsite=5&rec=1' +
      '&action_name=' + encodeURIComponent(actionName) +
      '&url=' + encodeURIComponent('https://asite.com/reviewpilot');
    const req = https.get(url, function (res) { res.resume(); });
    req.on('error', function () {});
    req.setTimeout(2000, function () { req.destroy(); });
  } catch (_) { /* never let tracking break the server */ }
}

// One server-lifecycle logger (used for startup / shutdown messages).
const serverLog = createLogger('server');

// Tracks the log file path for the most recently started review session.
// Used by /client-log to route browser-side log entries into the session log.
let currentSessionLogPath = null;

// All live Claude runs — AbortControllers populated in streamClaudeCore so /kill
// can abort them immediately on a hard-stop request.
const liveProcs = new Set();

// DISALLOWED_TOOLS, streamClaudeCore, streamClaude are imported from
// lib/claude-client.js, a thin wrapper over the @anthropic-ai/claude-code SDK
// query() — see that file for permission-mode configuration.

function stripFrontmatter(md) {
  if (!md.startsWith('---')) return md;
  const end = md.indexOf('\n---', 3);
  return end !== -1 ? md.slice(end + 4).trimStart() : md;
}

const SYSTEM_PROMPT = fs.existsSync(SKILL_MD)
  ? stripFrontmatter(fs.readFileSync(SKILL_MD, 'utf8'))
  : '';

function cors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

function sseStart(res) {
  cors(res);
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
  });
}

function sse(res, event, data) {
  if (!res.writableEnded) {
    res.write('event: ' + event + '\ndata: ' + JSON.stringify(data) + '\n\n');
  }
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', d => { body += d; });
    req.on('end', () => {
      try { resolve(JSON.parse(body)); }
      catch (e) { reject(new Error('invalid JSON: ' + e.message)); }
    });
    req.on('error', reject);
  });
}

function runScope(params, logPath) {
  return new Promise((resolve, reject) => {
    const args = [SCOPE_SCRIPT];
    if (params.base) args.push('--base', params.base);
    if (params.role) args.push('--role', params.role);
    if (params.extraExtensions && params.extraExtensions.length)
      args.push('--extensions', params.extraExtensions.join(','));
    if (params.extOnly) args.push('--extensions-only');
    if (params.skipExtensions && params.skipExtensions.length)
      args.push('--skip-extensions', params.skipExtensions.join(','));
    if (params.committedOnly) args.push('--committed-only');
    if (params.localOnly) args.push('--local-only');
    if (params.prescan === false) args.push('--no-prescan');
    if (params.diffs === false) args.push('--no-diffs');
    if (params.maxFiles > 0) args.push('--max-files', String(params.maxFiles));
    if (logPath) args.push('--log-file', logPath);

    let out = '', err = '';
    const proc = spawn('node', args, { cwd: REPO_CWD });
    proc.stdout.on('data', d => { out += d; });
    proc.stderr.on('data', d => { err += d; });
    proc.on('close', code => {
      if (code !== 0) return reject(new Error(err || 'scope script exited ' + code));
      try { resolve(JSON.parse(out)); }
      catch (e) { reject(new Error('failed to parse scope JSON: ' + e.message)); }
    });
  });
}

// ── Chunking helpers ──────────────────────────────────────────────────────────

/**
 * Split reviewed files into chunks so no single Claude call exceeds
 * CHUNK_DIFF_THRESHOLD bytes of raw diff content. A single file's diff is
 * never split across chunks — the whole file always lands in one chunk.
 * Skipped files are excluded from chunking (they carry no diff data).
 * Returns an array of arrays; length === 1 means no chunking needed.
 */
function buildScopeChunks(scope) {
  var reviewed = scope.files.filter(function(f) { return f.reviewed; });
  var total = reviewed.reduce(function(n, f) { return n + (f.diff ? f.diff.length : 0); }, 0);
  if (total <= CHUNK_DIFF_THRESHOLD || reviewed.length === 0) return [reviewed];

  var chunks = [], current = [], currentBytes = 0;
  for (var i = 0; i < reviewed.length; i++) {
    var f = reviewed[i];
    var size = f.diff ? f.diff.length : 0;
    // Start a new chunk only if adding this file would exceed the threshold
    // AND the current chunk already has at least one file (avoid empty chunks).
    if (current.length > 0 && currentBytes + size > CHUNK_DIFF_THRESHOLD) {
      chunks.push(current);
      current = [];
      currentBytes = 0;
    }
    current.push(f);
    currentBytes += size;
  }
  if (current.length > 0) chunks.push(current);
  return chunks;
}

/**
 * Build the scope object sent to Claude for one chunk.
 * First chunk carries full branch metadata; continuation chunks carry only
 * the fields that differ (file list + per-chunk prescan findings) to save tokens.
 */
function buildChunkScopeJson(scope, chunkFiles, chunkIndex, totalChunks) {
  var filePaths = new Set(chunkFiles.map(function(f) { return f.path; }));
  var chunkPrescan = (scope.prescan_findings || []).filter(function(f) { return filePaths.has(f.file); });

  var base = {
    tool: scope.tool,
    current_branch: scope.current_branch,
    base_ref: scope.base_ref,
    commit_range: scope.commit_range,
    files_reviewed: chunkFiles.length,
    files: chunkFiles.map(function(f) {
    if (!f.diff_chunked) return f;
    var stripped = Object.assign({}, f);
    delete stripped.diff_chunks;
    stripped.diff_note = 'Large file — showing part 1/' + f.diff_chunk_total + '; remaining parts will be reviewed in a follow-up pass.';
    return stripped;
  }),
    prescan_findings: chunkPrescan,
    chunk: chunkIndex + 1,
    total_chunks: totalChunks,
  };

  if (chunkIndex === 0) {
    // Full metadata on the first chunk only.
    base.commits              = scope.commits;
    base.merge_commits_excluded = scope.merge_commits_excluded;
    base.diff_stat            = scope.diff_stat;
    base.status_short_branch  = scope.status_short_branch;
    base.merge_base           = scope.merge_base;
    base.diff_range           = scope.diff_range;
    base.commit_walk          = scope.commit_walk;
    base.ignored_branch_diff_files_count = (scope.ignored_branch_diff_files || []).length;
    base.extension_filter     = scope.extension_filter;
    base.files_changed_total  = scope.files_changed;
    base.files_reviewed_total = scope.files_reviewed;
    base.files_skipped_total  = scope.files_skipped;
    base.prescan_summary      = scope.prescan_summary;
    // Compact skipped-file list for context (path + reason only, no diffs).
    base.skipped_files = scope.files
      .filter(function(f) { return !f.reviewed; })
      .map(function(f) { return { path: f.path, reason: f.reason_if_skipped }; });
  }

  return base;
}

/**
 * Build the stdin prompt for one chunk.
 * First chunk uses the standard $reviewpilot invocation so the system prompt
 * instruction fires. Continuation chunks are a short instruction resuming the
 * existing session — the system prompt is already in conversation history so
 * there is no need to re-send it (saves tokens).
 */
function buildPromptForChunk(params, scope, chunkScope, chunkIndex, totalChunks) {
  var scopeStr = JSON.stringify(chunkScope);

  if (chunkIndex === 0) {
    var roleLabel    = params.role ? params.role.replace(' Developer', '') + ' developer' : '';
    var committedStr = params.committedOnly ? ' committed-only' : '';
    var extraStr     = params.extra ? '\n\n' + params.extra : '';
    var chunkNote    = totalChunks > 1
      ? '\n\n[This branch has ' + scope.files_reviewed + ' reviewed files split across ' +
        totalChunks + ' parts. Review part 1 now; remaining files follow in subsequent messages.]'
      : '';
    return '$reviewpilot Review ' + roleLabel + ' changes against ' + params.base +
      ' base branch' + committedStr + '.' + extraStr + chunkNote +
      '\n\nScope JSON (part 1/' + totalChunks + '):\n' + scopeStr;
  }

  return 'Continue the review. Here is part ' + (chunkIndex + 1) + ' of ' + totalChunks +
    ' of the branch diff. Review these files using the same format, severity levels, and ' +
    'R-xxx IDs continuing from where you left off.\n\n' +
    'Scope JSON (part ' + (chunkIndex + 1) + '/' + totalChunks + '):\n' + scopeStr;
}

// ── Claude streaming wrappers ─────────────────────────────────────────────────
// Thin adapters that bind server-level context (liveProcs, SYSTEM_PROMPT,
// REPO_CWD) so call-sites need not pass them explicitly — matching the old
// local-function signatures.

function streamClaudeCore(fixedArgs, promptText, res, addSystemPrompt, log) {
  return _streamClaudeCore(fixedArgs, promptText, res, addSystemPrompt, log, liveProcs, SYSTEM_PROMPT, REPO_CWD);
}

function streamClaude(fixedArgs, promptText, res, addSystemPrompt, log) {
  _streamClaude(fixedArgs, promptText, res, addSystemPrompt, log, liveProcs, SYSTEM_PROMPT, REPO_CWD);
}

// ── File-level merge pass ─────────────────────────────────────────────────────
// For files whose diff was split into diff_chunks, send each remaining chunk to
// Claude in the same session and request consolidation of findings per file.
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

// ── Chunked review orchestration ──────────────────────────────────────────────
// Iterates over scope chunks sequentially, resuming the same Claude session for
// each continuation so the entire review shares one conversation context and the
// final sessionId can be used for the approval flow.
function processChunkedReview(scope, chunks, params, res, log) {
  var sessionId        = null;
  var chunkIndex       = 0;
  var totalRespBytes   = 0;

  function next() {
    if (chunkIndex >= chunks.length) {
      if (totalRespBytes === 0) {
        log.error('All chunks returned no content — Claude may not be reachable');
        sse(res, 'error', { text: 'Claude returned no content. Check that the Claude CLI is installed and try again.' });
        if (!res.writableEnded) res.end();
        return;
      }
      processFileMergePass(scope, sessionId, res, log).then(function(finalSessionId) {
        sessionId = finalSessionId || sessionId;
        sse(res, 'done', { code: 0, sessionId: sessionId });
        if (!res.writableEnded) res.end();
      });
      return;
    }

    var i = chunkIndex++;
    var total = chunks.length;
    var label = total > 1
      ? 'AI review — part ' + (i + 1) + '/' + total + ' in progress'
      : 'AI review in progress';
    sse(res, 'step', { n: 2 + i, label: label });

    var chunkScope  = buildChunkScopeJson(scope, chunks[i], i, total);
    var promptStr   = buildPromptForChunk(params, scope, chunkScope, i, total);

    // First chunk starts a fresh session with the full system prompt.
    // Continuation chunks resume the same session — the system prompt is already
    // in conversation history, so we skip it to avoid re-paying for those tokens.
    var fixedArgs   = sessionId ? ['--resume', sessionId] : [];
    var addSysPr    = (i === 0);

    log.info('Chunk ' + (i + 1) + '/' + total, {
      files: chunks[i].length,
      resume: !!sessionId,
      promptBytes: promptStr.length,
    });

    streamClaudeCore(fixedArgs, promptStr, res, addSysPr, log).then(function(result) {
      sessionId      = result.sessionId || sessionId;
      totalRespBytes += result.responseBytes;
      log.info('Chunk complete', { chunkIndex: i + 1, totalChunks: total, sessionId: sessionId, responseBytes: result.responseBytes });
      if (i < total - 1) {
        sse(res, 'log', { text: 'Part ' + (i + 1) + ' complete — continuing with part ' + (i + 2) + '…' });
      }
      next();
    });
  }

  next();
}

// ── Editor detection ────────────────────────────────────────────────────────
// Returns the resolved full binary path for the first usable editor, or null.
// Priority order is nudged by the detected IDE environment.

var VSCODE_LIKE = ['code', 'cursor', 'codium', 'code-insiders'];

// Absolute fallback paths tried when PATH lookup fails (Linux / macOS / Windows).
// Windows paths are derived from os.homedir() — no env vars required.
//   Local    = <home>\AppData\Local
//   ProgramFiles = <drive>:\Program Files  (drive root derived from homedir)
var _winHome     = os.homedir();
var _winLocal    = path.join(_winHome, 'AppData', 'Local');
var _winPrograms = path.join(path.parse(_winHome).root, 'Program Files');

var ABSOLUTE_FALLBACKS = {
  linux: [
    '/usr/bin/code', '/usr/local/bin/code', '/snap/bin/code',
    '/opt/visual-studio-code/bin/code',
    '/usr/bin/cursor', '/usr/local/bin/cursor',
  ],
  darwin: [
    '/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code',
    '/usr/local/bin/code', '/opt/homebrew/bin/code',
    '/Applications/Cursor.app/Contents/Resources/app/bin/cursor',
    '/usr/local/bin/cursor',
  ],
  win32: [
    path.join(_winLocal,    'Programs', 'Microsoft VS Code', 'bin', 'code.cmd'),
    path.join(_winPrograms, 'Microsoft VS Code', 'bin', 'code.cmd'),
    path.join(_winLocal,    'Programs', 'cursor', 'resources', 'app', 'bin', 'cursor.cmd'),
  ],
};

function resolveEditorBinary(platform) {
  var env = process.env;
  var termProg = (env.TERM_PROGRAM || '').toLowerCase();
  var inCursor  = termProg.includes('cursor') || !!env.CURSOR_SESSION_ID;
  var inVSCode  = !!env.VSCODE_PID || !!env.VSCODE_INJECTION_UUID || termProg.includes('vscode');

  var candidates = ['code', 'cursor', 'codium', 'code-insiders', 'subl', 'idea', 'webstorm', 'phpstorm'];
  if (inCursor) {
    candidates = ['cursor', 'code', 'codium', 'code-insiders', 'subl', 'idea', 'webstorm', 'phpstorm'];
  } else if (inVSCode) {
    candidates = ['code', 'cursor', 'codium', 'code-insiders', 'subl', 'idea', 'webstorm', 'phpstorm'];
  }

  var checker = platform === 'win32' ? 'where' : 'which';
  for (var i = 0; i < candidates.length; i++) {
    try {
      // `which` / `where` prints the full resolved path to stdout.
      var out = execFileSync(checker, [candidates[i]], {
        encoding: 'utf-8',
        stdio: ['ignore', 'pipe', 'ignore'],
      }).trim();
      // `where` on Windows can return multiple lines; take the first.
      var resolved = out.split(/\r?\n/)[0].trim();
      if (resolved) return { name: candidates[i], bin: resolved };
    } catch (_) {}
  }

  // PATH lookup failed — try known absolute locations.
  var fallbacks = ABSOLUTE_FALLBACKS[platform] || [];
  for (var j = 0; j < fallbacks.length; j++) {
    try {
      if (fallbacks[j] && fs.existsSync(fallbacks[j])) {
        var name = path.basename(fallbacks[j]).replace(/\.(cmd|exe|sh)$/, '');
        return { name: name, bin: fallbacks[j] };
      }
    } catch (_) {}
  }

  return null;
}

function buildEditorArgs(editorName, absPath, line) {
  if (VSCODE_LIKE.indexOf(editorName) !== -1) {
    // --reuse-window: open in the existing VS Code window, not a new one.
    // --goto: jump directly to file:line.
    return ['--reuse-window', '--goto', absPath + ':' + line];
  }
  if (editorName === 'subl') return [absPath + ':' + line];
  // IntelliJ family (idea, webstorm, phpstorm, etc.)
  return ['--line', String(line), absPath];
}

function findFileInRepo(repo, filePath) {
  var basename = path.basename(filePath);
  try {
    var output = execFileSync('git', ['-C', repo, 'ls-files'], {
      encoding: 'utf-8',
      maxBuffer: 4 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    var lines = output.split('\n').filter(Boolean);
    var normalizedInput = filePath.replace(/\\/g, '/');
    // 1) suffix match: input path matches end of a tracked path
    var match = lines.find(function (l) {
      var nl = l.replace(/\\/g, '/');
      return nl === normalizedInput || nl.endsWith('/' + normalizedInput);
    });
    // 2) basename-only fallback
    if (!match) {
      match = lines.find(function (l) { return path.basename(l) === basename; });
    }
    return match ? path.join(repo, match) : null;
  } catch (_) { return null; }
}

function openFileInEditor(filePath, line, log) {
  var platform = os.platform();
  var absPath = path.isAbsolute(filePath) ? filePath : path.resolve(REPO_CWD, filePath);
  var editor = resolveEditorBinary(platform);

  if (editor) {
    var args = buildEditorArgs(editor.name, absPath, line);
    if (log) log.info('Opening file', { editor: editor.bin, args: args });
    var proc = spawn(editor.bin, args, { detached: true, stdio: 'ignore', shell: false });
    proc.on('error', function (err) {
      if (log) log.error('Editor spawn failed', { editor: editor.bin, error: err.message });
      // Retry with OS fallback when the resolved binary errors.
      spawnOsFallback(platform, absPath, log);
    });
    proc.unref();
    return;
  }

  if (log) log.warn('No editor found on PATH — falling back to OS file open', { file: absPath });
  spawnOsFallback(platform, absPath, log);
}

function spawnOsFallback(platform, absPath, log) {
  var cmd, args;
  if (platform === 'darwin') {
    cmd = 'open'; args = [absPath];
  } else if (platform === 'win32') {
    cmd = 'cmd'; args = ['/c', 'start', '', absPath];
  } else {
    cmd = 'xdg-open'; args = [absPath];
  }
  if (log) log.info('OS fallback open', { cmd, file: absPath });
  var proc = spawn(cmd, args, { detached: true, stdio: 'ignore', shell: false });
  proc.on('error', function (err) {
    if (log) log.error('OS fallback failed', { cmd, error: err.message });
  });
  proc.unref();
}

const server = http.createServer(function (req, res) {
  cors(res);

  // Strip query-string and hash so routes match regardless of browser cache-busting params.
  var urlPath = req.url.split('?')[0].split('#')[0];

  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  if (req.method === 'GET' && (urlPath === '/' || urlPath === '/index.html')) {
    try {
      const html = fs.readFileSync(UI_FILE, 'utf8');
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(html);
    } catch (e) {
      res.writeHead(500); res.end('Failed to load UI: ' + e.message);
    }
    return;
  }

  if (req.method === 'GET' && urlPath === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, pid: process.pid, cwd: REPO_CWD }));
    return;
  }

  if (req.method === 'POST' && urlPath === '/review') {
    readBody(req).then(function (params) {
      sseStart(res);
      sse(res, 'step', { n: 1, label: 'Collecting scope' });

      // Create a per-session logger keyed to the current git branch.
      const branch = detectBranch();
      const log = createLogger(branch);
      currentSessionLogPath = log.logPath;
      log.info('Review requested', {
        ts: new Date().toISOString(),
        base: params.base, role: params.role,
        extensions: params.extraExtensions, extOnly: params.extOnly,
        committedOnly: params.committedOnly,
        localOnly: !!params.localOnly,
        enableChunking: !!params.enableChunking,
      });

      runScope(params, log.logPath).then(function (scope) {
        sse(res, 'scope', { data: scope });
        log.info('Scope collected', {
          branch: scope.current_branch,
          base_ref: scope.base_ref,
          files_changed: scope.files_changed,
          files_reviewed: scope.files_reviewed,
          files_skipped: scope.files_skipped,
          prescan_findings: (scope.prescan_findings || []).length,
          log_file: log.logPath,
        });
        sse(res, 'log', { text: 'Log: ' + log.logPath });

        var chunks;
        if (params.enableChunking) {
          chunks = buildScopeChunks(scope);
          if (chunks.length > 1) {
            log.info('Large branch: splitting into ' + chunks.length + ' chunks', {
              totalReviewedFiles: scope.files_reviewed,
              chunkSizes: chunks.map(function(c) { return c.length; }),
            });
            sse(res, 'log', {
              text: 'Large branch: reviewing in ' + chunks.length + ' parts (' +
                scope.files_reviewed + ' files, threshold ' + CHUNK_DIFF_THRESHOLD + ' bytes/part)',
            });
          }
        } else {
          chunks = [scope.files.filter(function(f) { return f.reviewed; })];
          log.info('Chunking disabled: sending all ' + scope.files_reviewed + ' files in one AI call');
        }

        log.info('AI review started', { chunks: chunks.length, chunking: !!params.enableChunking });
        processChunkedReview(scope, chunks, params, res, log);

      }).catch(function (e) {
        log.error('Scope collection failed', { error: e.message });
        sse(res, 'error', { text: e.message });
        res.end();
      });

    }).catch(function (e) {
      res.writeHead(400); res.end(e.message);
    });
    return;
  }

  if (req.method === 'POST' && urlPath === '/approve') {
    readBody(req).then(function (params) {
      const sessionId = params.sessionId;
      const approval = params.approval;

      if (!sessionId) { res.writeHead(400); res.end('missing sessionId'); return; }
      if (!approval)  { res.writeHead(400); res.end('missing approval');  return; }

      sseStart(res);
      sse(res, 'step', { n: 7, label: 'Applying approved fixes' });

      const branch = detectBranch();
      const log = createLogger(branch);
      log.info('Approval submitted', { sessionId, approvalLength: approval.length });

      streamClaude(['--resume', sessionId], approval, res, false, log);

    }).catch(function (e) {
      res.writeHead(400); res.end(e.message);
    });
    return;
  }

  if (req.method === 'POST' && urlPath === '/kill') {
    cors(res);
    var killedCount = liveProcs.size;
    liveProcs.forEach(function(p) {
      try { p.abort(); } catch (_) {}
    });
    liveProcs.clear();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, killedProcs: killedCount }));
    serverLog.warn('Kill requested — all AI processes terminated, shutting down', { killedProcs: killedCount });
    setTimeout(function() { process.exit(0); }, 450);
    return;
  }

  if (req.method === 'POST' && urlPath === '/shutdown') {
    cors(res);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
    setTimeout(function () { process.exit(0); }, 300);
    return;
  }

  if (req.method === 'POST' && urlPath === '/open-file') {
    readBody(req).then(function (params) {
      var filePath = (params.file || '').trim();
      var line = Math.max(1, parseInt(params.line, 10) || 1);
      if (!filePath) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: 'missing file parameter' }));
        return;
      }
      var absPath = path.isAbsolute(filePath) ? filePath : path.resolve(REPO_CWD, filePath);
      // If the computed path doesn't exist on disk, search the repo for the file
      if (!fs.existsSync(absPath)) {
        var found = findFileInRepo(REPO_CWD, filePath);
        if (found) {
          serverLog.info('open-file: resolved via repo search', { original: filePath, resolved: found });
          absPath = found;
        }
      }
      var editor = resolveEditorBinary(os.platform());
      serverLog.info('open-file request', { file: filePath, line: line, absPath: absPath, editor: editor ? editor.bin : 'os-fallback' });
      openFileInEditor(absPath, line, serverLog);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        ok: true,
        file: absPath,
        line: line,
        editor: editor ? editor.bin : 'os-fallback',
      }));
    }).catch(function (e) {
      serverLog.error('open-file error', { error: e.message });
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: e.message }));
    });
    return;
  }

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

  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ ok: false, error: 'Not found', method: req.method, path: urlPath }));
});

process.on('uncaughtException', function (err) {
  serverLog.error('Uncaught exception — server kept alive', { message: err.message, stack: err.stack });
});

process.on('unhandledRejection', function (reason) {
  serverLog.error('Unhandled promise rejection — server kept alive', { reason: String(reason) });
});

server.listen(PORT, '127.0.0.1', function () {
  const msg = 'Review Pilot server → http://localhost:' + PORT + '  (repo: ' + REPO_CWD + ')';
  process.stdout.write(msg + '\n');
  serverLog.info(msg, { port: PORT, cwd: REPO_CWD });
  trackEvent('reviewpilot-skill-invoked');
});

server.on('error', function (err) {
  serverLog.error('Server error', { code: err.code, message: err.message });
  if (err.code === 'EADDRINUSE') {
    process.stderr.write('Port ' + PORT + ' already in use — Review Pilot may already be running.\n');
    process.exit(1);
  }
  throw err;
});

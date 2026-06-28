'use strict';

/**
 * Claude Code connection and communication layer.
 *
 * Spawns the official Claude Code native binary (shipped by
 * @anthropic-ai/claude-code) directly and parses its --output-format=stream-json
 * NDJSON stream.  This module bakes in ReviewPilot's permission policy
 * (bypassPermissions + DISALLOWED_TOOLS) and adapts the message stream to the
 * SSE contract server.js expects.
 *
 * Why spawn the binary instead of importing query()?
 * ──────────────────────────────────────────────────
 * @anthropic-ai/claude-code v2.x is a CLI-binary-only package — it has no
 * `main`/`exports` and exports NO query() function (the JS SDK moved to a
 * separate package).  `import('@anthropic-ai/claude-code')` therefore fails or
 * yields no query(), which broke ReviewPilot inconsistently across machines
 * (perceived as "Windows-only").  Resolving the per-platform native binary and
 * spawning its absolute path works identically on Windows, macOS and Linux —
 * spawning the real .exe sidesteps the .cmd/.ps1 shell-shim problems Windows
 * hits with PATH-based launches.
 *
 * No API key is required: the native CLI authenticates from the existing
 * logged-in session (OAuth / VS Code extension), same as before.
 *
 * streamClaudeCore / streamClaude are server.js-compatible wrappers.
 *
 * Permission model
 * ────────────────
 * bypassPermissions: Claude can read repo files, run analysis tools, and apply
 * edits without interrupting the user per-action.  DISALLOWED_TOOLS still
 * hard-blocks all destructive git / filesystem operations.
 */

const { spawn } = require('child_process');
const path = require('path');
const os = require('os');

// ── Disallowed tools ──────────────────────────────────────────────────────────
// Hard-blocked regardless of permission mode.  Claude may never commit, push,
// merge, reset, or delete files from the repo without the user acting outside
// ReviewPilot.
const DISALLOWED_TOOLS = [
  'Bash(git commit *)',
  'Bash(git push *)',
  'Bash(git merge *)',
  'Bash(git rebase *)',
  'Bash(git reset *)',
  'Bash(git clean *)',
  'Bash(git branch -D *)',
  'Bash(git branch -d *)',
  'Bash(git checkout -- *)',
  'Bash(git restore *)',
  'Bash(gh *)',
  'Bash(rm -rf *)',
  'Bash(rm -f *)',
  'Bash(rmdir *)',
];

// ── Native binary resolution ────────────────────────────────────────────────
// Resolve the per-platform binary package the same way the official wrapper
// does (incl. linux musl/glibc).  Falls back to PATH 'claude'/'claude.exe'.

function getPlatformKey() {
  const platform = process.platform;
  const arch = os.arch();
  if (platform === 'linux') {
    const report = typeof process.report?.getReport === 'function'
      ? process.report.getReport()
      : null;
    const isMusl = !!report && report.header && report.header.glibcVersionRuntime === undefined;
    return 'linux-' + arch + (isMusl ? '-musl' : '');
  }
  // win32-x64, win32-arm64, darwin-arm64, darwin-x64, ...
  return platform + '-' + arch;
}

function getClaudeBinaryPath() {
  const binName = process.platform === 'win32' ? 'claude.exe' : 'claude';
  const pkgName = '@anthropic-ai/claude-code-' + getPlatformKey();
  try {
    const pkgJsonPath = require.resolve(pkgName + '/package.json');
    return path.join(path.dirname(pkgJsonPath), binName);
  } catch {
    return binName; // Package not installed for this platform — try PATH
  }
}

// ── runClaude — spawn the binary, parse stream-json, drive callbacks ──────────
//
// Builds the CLI invocation from ReviewPilot's options and the native binary's
// stream-json output (identical message shapes to the old SDK stream):
//   { type: 'assistant', message: { content: [{type:'text', text}] } }
//   { type: 'result', result, session_id, is_error, subtype }
//
// The prompt is fed via stdin (not a positional arg) so large review prompts
// never hit Windows' command-line length limit and never collide with the
// variadic --disallowedTools parsing.
//
// onMessage(msg) is called per parsed NDJSON object.  Returns a handle with
// .abort() (kills the process) so /kill can stop the run.

function runClaude(opts, onMessage) {
  const args = [
    '--print',
    '--output-format', 'stream-json',
    '--verbose',
    '--permission-mode', opts.permissionMode || 'bypassPermissions',
  ];

  if (DISALLOWED_TOOLS.length) {
    args.push('--disallowedTools', DISALLOWED_TOOLS.join(','));
  }
  if (opts.resume) {
    args.push('--resume', opts.resume);
  }
  if (opts.appendSystemPrompt) {
    args.push('--append-system-prompt', opts.appendSystemPrompt);
  }

  const proc = spawn(getClaudeBinaryPath(), args, {
    cwd: opts.cwd || process.cwd(),
    env: { ...process.env },
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  // Feed the prompt over stdin and close it.  Swallow EPIPE: if the binary
  // fails to spawn, the 'error' event below handles it — the stdin write must
  // not throw an unhandled stream error.
  proc.stdin.on('error', () => {});
  proc.stdin.write(opts.prompt || '');
  proc.stdin.end();

  let buffer = '';
  let stderrOutput = '';

  function consume(line) {
    const trimmed = line.trim();
    if (!trimmed) return;
    try {
      onMessage(JSON.parse(trimmed));
    } catch {
      // Ignore non-JSON output (e.g. banner text)
    }
  }

  proc.stdout.on('data', (chunk) => {
    buffer += chunk.toString('utf8');
    const lines = buffer.split('\n');
    buffer = lines.pop(); // keep last incomplete line
    for (const line of lines) consume(line);
  });

  proc.stderr.on('data', (chunk) => {
    stderrOutput += chunk.toString('utf8');
  });

  const done = new Promise((resolve, reject) => {
    proc.on('error', (err) => {
      reject(new Error('Failed to start Claude process: ' + err.message));
    });
    proc.on('close', (code) => {
      if (buffer.trim()) consume(buffer); // flush final line
      resolve({ code: code, stderr: stderrOutput });
    });
  });

  const handle = { done: done, aborted: false };
  handle.abort = function () {
    handle.aborted = true;
    try { proc.kill(); } catch (_) { /* already dead */ }
  };
  return handle;
}

// ── SSE helper ────────────────────────────────────────────────────────────────

function sseWrite(res, event, data) {
  if (!res.writableEnded) {
    res.write('event: ' + event + '\ndata: ' + JSON.stringify(data) + '\n\n');
  }
}

// ── streamClaudeCore — server.js-compatible wrapper ──────────────────────────
//
// Spawns the binary and pipes events to an SSE response.
// Returns Promise<{ code, sessionId, responseBytes }> — same contract as before.
// liveProcs holds run handles; /kill calls handle.abort().

function streamClaudeCore(fixedArgs, promptText, res, addSystemPrompt, log, liveProcs, systemPrompt, repoCwd) {
  // Extract --resume sessionId from the legacy fixedArgs array.
  var resumeIdx = fixedArgs.indexOf('--resume');
  var resumeId  = resumeIdx !== -1 ? fixedArgs[resumeIdx + 1] : undefined;

  var opts = {
    prompt:         promptText || '',
    cwd:            repoCwd,
    permissionMode: 'bypassPermissions',
  };
  if (resumeId)                        opts.resume             = resumeId;
  if (addSystemPrompt && systemPrompt) opts.appendSystemPrompt = systemPrompt;

  var sessionId     = null;
  var responseBytes = 0;
  var exitCode      = 0;

  var handle = runClaude(opts, function (msg) {
    if (msg.session_id) sessionId = msg.session_id;

    if (msg.type === 'assistant') {
      var content = msg.message && msg.message.content;
      if (Array.isArray(content)) {
        for (var k = 0; k < content.length; k++) {
          var block = content[k];
          if (block.type === 'text' && block.text) {
            responseBytes += block.text.length;
            if (log) log.info('Claude chunk received', { bytes: block.text.length });
            sseWrite(res, 'chunk', { text: block.text });
          }
        }
      }
    }

    if (msg.type === 'result') {
      sessionId = msg.session_id || sessionId;
      // The CLI signals failure via is_error / non-success subtype.
      if (msg.is_error || (msg.subtype && msg.subtype !== 'success')) {
        exitCode = 1;
      }
      var resultText = msg.result || '';
      responseBytes += resultText.length;
      sseWrite(res, 'result', { text: msg.result, sessionId: sessionId });
      if (log) log.info('AI review complete', {
        sessionId: sessionId,
        resultLength: resultText.length,
        totalResponseBytes: responseBytes,
      });
    }
  });

  if (liveProcs) liveProcs.add(handle);

  return (async function () {
    try {
      var outcome = await handle.done;
      // Non-zero exit with no result message → surface the failure.
      if (outcome.code !== 0 && exitCode === 0) {
        exitCode = 1;
        var errMsg = (outcome.stderr || '').trim() || ('Claude exited with code ' + outcome.code);
        if (log) log.error('Claude stream error', { error: errMsg });
        sseWrite(res, 'log', { text: 'Claude error: ' + errMsg });
      }
    } catch (err) {
      // Intentional /kill abort: stop quietly, no error SSE.
      if (handle.aborted) {
        exitCode = 1;
        if (log) log.info('Claude stream aborted', { sessionId: sessionId });
      } else {
        if (log) log.error('Claude stream error', { error: err.message });
        sseWrite(res, 'log', { text: 'Claude error: ' + err.message });
        exitCode = 1;
      }
    } finally {
      if (liveProcs) liveProcs.delete(handle);
    }

    if (log) {
      if (exitCode === 0) {
        log.info('Claude process exited cleanly', { sessionId: sessionId, totalResponseBytes: responseBytes });
      } else {
        log.error('Claude process exited with error', { code: exitCode, sessionId: sessionId });
      }
    }

    return { code: exitCode, sessionId: sessionId, responseBytes: responseBytes };
  })();
}

/**
 * Convenience wrapper: drives streamClaudeCore, then emits 'done' and ends the
 * SSE response.  Used by single-invocation call sites (approval flow, etc.).
 */
function streamClaude(fixedArgs, promptText, res, addSystemPrompt, log, liveProcs, systemPrompt, repoCwd) {
  streamClaudeCore(fixedArgs, promptText, res, addSystemPrompt, log, liveProcs, systemPrompt, repoCwd)
    .then(function (result) {
      sseWrite(res, 'done', { code: result.code, sessionId: result.sessionId });
      if (!res.writableEnded) res.end();
    });
}

// ── Exports ───────────────────────────────────────────────────────────────────

module.exports = {
  DISALLOWED_TOOLS:    DISALLOWED_TOOLS,
  getClaudeBinaryPath: getClaudeBinaryPath,
  streamClaudeCore:    streamClaudeCore,
  streamClaude:        streamClaude,
};

'use strict';

/**
 * Claude Code connection and communication layer.
 *
 * Thin wrapper around the official @anthropic-ai/claude-code SDK `query()`.
 * The SDK owns process spawning, binary resolution, stdin/stdout wiring, and
 * NDJSON parsing — this module only bakes in ReviewPilot's permission policy
 * (bypassPermissions + DISALLOWED_TOOLS) and adapts the SDK message stream to
 * the SSE contract server.js expects.
 *
 * No API key is required: the bundled Claude Code CLI authenticates from the
 * existing logged-in session (OAuth / VS Code extension), same as before.
 *
 * streamClaudeCore / streamClaude are server.js-compatible wrappers.
 *
 * Permission model
 * ────────────────
 * bypassPermissions: Claude can read repo files, run analysis tools, and apply
 * edits without interrupting the user per-action.  DISALLOWED_TOOLS still
 * hard-blocks all destructive git / filesystem operations.
 */

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

// ── SDK loader ────────────────────────────────────────────────────────────────
// @anthropic-ai/claude-code is ESM-first; this module is CommonJS, so we load it
// via a cached dynamic import() (works whether the package is ESM-only or dual).

var _sdkQueryPromise = null;

function loadSdkQuery() {
  if (!_sdkQueryPromise) {
    _sdkQueryPromise = import('@anthropic-ai/claude-code').then(function (mod) {
      var fn = mod.query || (mod.default && mod.default.query);
      if (typeof fn !== 'function') {
        throw new Error('@anthropic-ai/claude-code did not export query()');
      }
      return fn;
    });
  }
  return _sdkQueryPromise;
}

// ── query() — async generator ─────────────────────────────────────────────────
//
// Delegates to the SDK's query(), baking in ReviewPilot's permission policy.
//
//   for await (const msg of query({ prompt, options })) {
//     if (msg.type === 'assistant') { /* streaming text blocks */ }
//     if (msg.type === 'result')    { /* final result + session_id */ }
//   }
//
// Options accepted (mapped to the SDK option names):
//   cwd                string         — working directory for the Claude process
//   resume             string         — session ID to resume
//   permissionMode     string         — default 'bypassPermissions'
//   disallowedTools    string[]       — merged with DISALLOWED_TOOLS
//   appendSystemPrompt string         — appended to Claude's system prompt
//   abortController    AbortController — abort() stops the run
//
// Yields the SDK's typed message objects.  Aborting throws an AbortError from
// the SDK generator; callers (streamClaudeCore) handle that.

async function* query({ prompt: promptText, options = {} }) {
  var sdkQuery = await loadSdkQuery();

  var extraDenied = Array.isArray(options.disallowedTools) ? options.disallowedTools : [];
  var allDenied = DISALLOWED_TOOLS.concat(
    extraDenied.filter(function (t) { return DISALLOWED_TOOLS.indexOf(t) === -1; })
  );

  var sdkOptions = {
    cwd:                    options.cwd || process.cwd(),
    permissionMode:         options.permissionMode || 'bypassPermissions',
    disallowedTools:        allDenied,
    includePartialMessages: true,
  };
  if (options.resume)             sdkOptions.resume             = options.resume;
  if (options.appendSystemPrompt) sdkOptions.appendSystemPrompt = options.appendSystemPrompt;
  if (options.abortController)    sdkOptions.abortController     = options.abortController;

  yield* sdkQuery({ prompt: promptText || '', options: sdkOptions });
}

// ── SSE helper ────────────────────────────────────────────────────────────────

function sseWrite(res, event, data) {
  if (!res.writableEnded) {
    res.write('event: ' + event + '\ndata: ' + JSON.stringify(data) + '\n\n');
  }
}

// ── streamClaudeCore — server.js-compatible wrapper ──────────────────────────
//
// Drives query() and pipes events to an SSE response.
// Returns Promise<{ code, sessionId, responseBytes }> — same contract as before.
// liveProcs holds AbortControllers; /kill calls controller.abort().

function streamClaudeCore(fixedArgs, promptText, res, addSystemPrompt, log, liveProcs, systemPrompt, repoCwd) {
  // Extract --resume sessionId from the legacy fixedArgs array.
  var resumeIdx = fixedArgs.indexOf('--resume');
  var resumeId  = resumeIdx !== -1 ? fixedArgs[resumeIdx + 1] : undefined;

  var abortCtrl = new AbortController();
  if (liveProcs) liveProcs.add(abortCtrl);

  var opts = {
    cwd:             repoCwd,
    permissionMode:  'bypassPermissions',
    disallowedTools: [],        // DISALLOWED_TOOLS already baked in inside query()
    abortController: abortCtrl,
  };
  if (resumeId)                          opts.resume             = resumeId;
  if (addSystemPrompt && systemPrompt)   opts.appendSystemPrompt = systemPrompt;

  var sessionId     = null;
  var responseBytes = 0;
  var exitCode      = 0;

  var stream = query({ prompt: promptText, options: opts });

  return (async function() {
    try {
      for await (var msg of stream) {
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
          // SDK signals failure via is_error / non-success subtype instead of
          // a process exit code.
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
      }
    } catch (err) {
      // Intentional /kill abort: stop quietly, no error SSE.
      if (abortCtrl.signal.aborted) {
        exitCode = 1;
        if (log) log.info('Claude stream aborted', { sessionId: sessionId });
      } else {
        if (log) log.error('Claude stream error', { error: err.message });
        sseWrite(res, 'log', { text: 'Claude error: ' + err.message });
        exitCode = 1;
      }
    } finally {
      if (liveProcs) liveProcs.delete(abortCtrl);
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
    .then(function(result) {
      sseWrite(res, 'done', { code: result.code, sessionId: result.sessionId });
      if (!res.writableEnded) res.end();
    });
}

// ── Exports ───────────────────────────────────────────────────────────────────

module.exports = {
  DISALLOWED_TOOLS: DISALLOWED_TOOLS,
  query:            query,
  streamClaudeCore: streamClaudeCore,
  streamClaude:     streamClaude,
};

'use strict';

const { spawn } = require('child_process');
const path = require('path');
const os = require('os');

function getClaudeBinaryPath() {
  const platform = process.platform;
  const arch = os.arch();

  let pkgSuffix;
  const binName = platform === 'win32' ? 'claude.exe' : 'claude';

  if (platform === 'win32') {
    pkgSuffix = `win32-${arch}`;
  } else if (platform === 'darwin') {
    // Rosetta 2: prefer arm64 binary when running x64 Node on Apple Silicon
    pkgSuffix = `darwin-${arch}`;
  } else if (platform === 'linux') {
    pkgSuffix = `linux-${arch}`;
  } else {
    return binName; // Fall back to PATH
  }

  const pkgName = `@anthropic-ai/claude-code-${pkgSuffix}`;

  try {
    const pkgJsonPath = require.resolve(`${pkgName}/package.json`);
    return path.join(path.dirname(pkgJsonPath), binName);
  } catch {
    // Package not found for this platform — try PATH
    return binName;
  }
}

/**
 * Query Claude CLI programmatically via @anthropic-ai/claude-code binary.
 *
 * @param {string} prompt - The prompt to send to Claude
 * @param {object} [options]
 * @param {string[]} [options.allowedTools] - Tool names Claude is allowed to use
 * @param {string} [options.resume] - Session ID to resume
 * @returns {Promise<{ result: string|null, sessionId: string|null, messages: object[], costUsd: number|null }>}
 */
function askClaude(prompt, options = {}) {
  return new Promise((resolve, reject) => {
    const claudeBin = getClaudeBinaryPath();

    const args = ['--print', '--output-format', 'stream-json', '--verbose'];

    if (options.allowedTools && options.allowedTools.length > 0) {
      args.push('--allowedTools', options.allowedTools.join(','));
    }

    if (options.resume) {
      args.push('--resume', options.resume);
    }

    // Prompt is the final positional argument
    args.push(prompt);

    const proc = spawn(claudeBin, args, {
      env: { ...process.env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const messages = [];
    let buffer = '';
    let resultMsg = null;
    let stderrOutput = '';

    proc.stdout.on('data', (chunk) => {
      buffer += chunk.toString('utf8');
      const lines = buffer.split('\n');
      buffer = lines.pop(); // Keep the last incomplete line

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          const msg = JSON.parse(trimmed);
          messages.push(msg);
          if (msg.type === 'result') {
            resultMsg = msg;
          }
        } catch {
          // Ignore non-JSON output (e.g. banner text)
        }
      }
    });

    proc.stderr.on('data', (chunk) => {
      stderrOutput += chunk.toString('utf8');
    });

    proc.on('error', (err) => {
      reject(new Error(`Failed to start Claude process: ${err.message}`));
    });

    proc.on('close', (code) => {
      // Flush any remaining data in buffer
      if (buffer.trim()) {
        try {
          const msg = JSON.parse(buffer.trim());
          messages.push(msg);
          if (msg.type === 'result') resultMsg = msg;
        } catch { /* ignore */ }
      }

      if (code !== 0 && !resultMsg) {
        const errMsg = stderrOutput.trim() || `Claude exited with code ${code}`;
        reject(new Error(errMsg));
        return;
      }

      resolve({
        result: resultMsg?.result ?? null,
        sessionId: resultMsg?.session_id ?? null,
        costUsd: resultMsg?.cost_usd ?? null,
        messages,
      });
    });
  });
}

module.exports = { askClaude, getClaudeBinaryPath };

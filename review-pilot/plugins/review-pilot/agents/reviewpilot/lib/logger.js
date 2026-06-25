'use strict';

/**
 * Review Pilot — session logger.
 *
 * Each review session writes to its own log file under logs/.
 * Files are named after the git branch; if a file already exists a
 * numeric suffix is appended: main.log → main-2.log → main-3.log …
 *
 * Log format: one JSON object per line (NDJSON), easy to tail / grep.
 */

const fs   = require('fs');
const path = require('path');

const LOGS_DIR = path.join(__dirname, '..', 'logs');

function ensureLogsDir() {
  if (!fs.existsSync(LOGS_DIR)) fs.mkdirSync(LOGS_DIR, { recursive: true });
}

/** Turns a branch name into a safe filename slug. */
function slugify(branch) {
  return (branch || 'unknown')
    .replace(/[/\\:*?"<>|]/g, '-')   // path-unsafe chars → dash
    .replace(/-{2,}/g, '-')           // collapse multiple dashes
    .replace(/^-+|-+$/g, '')          // trim leading/trailing dashes
    .slice(0, 100) || 'unknown';
}

/**
 * Resolve a unique log file path for `branch`.
 * Returns the path that should be used for this session.
 */
function resolveLogPath(branch) {
  ensureLogsDir();
  const slug = slugify(branch);
  const candidate = path.join(LOGS_DIR, slug + '.log');
  if (!fs.existsSync(candidate)) return candidate;

  let n = 2;
  while (fs.existsSync(path.join(LOGS_DIR, `${slug}-${n}.log`))) n++;
  return path.join(LOGS_DIR, `${slug}-${n}.log`);
}

/** Append a single NDJSON entry to the log file — never throws. */
function writeEntry(logPath, level, message, data) {
  if (!logPath) return;
  const entry = { ts: new Date().toISOString(), level, message };
  if (data !== undefined && data !== null) entry.data = data;
  try { fs.appendFileSync(logPath, JSON.stringify(entry) + '\n', 'utf8'); } catch (_) {}
}

/**
 * Create a logger bound to a specific log file.
 * @param {string} branch   Git branch name (used as the filename base).
 * @returns {{ logPath: string, info, warn, error }}
 */
function createLogger(branch) {
  const logPath = resolveLogPath(branch);
  writeEntry(logPath, 'INFO', 'Review Pilot session started', { branch, pid: process.pid });
  return {
    logPath,
    info:  (msg, data) => writeEntry(logPath, 'INFO',  msg, data),
    warn:  (msg, data) => writeEntry(logPath, 'WARN',  msg, data),
    error: (msg, data) => writeEntry(logPath, 'ERROR', msg, data),
  };
}

/**
 * Lightweight helper used by child scripts that receive the log path
 * as a CLI argument (`--log-file <path>`).
 */
function openLogger(logPath) {
  return {
    logPath,
    info:  (msg, data) => writeEntry(logPath, 'INFO',  msg, data),
    warn:  (msg, data) => writeEntry(logPath, 'WARN',  msg, data),
    error: (msg, data) => writeEntry(logPath, 'ERROR', msg, data),
  };
}

module.exports = { createLogger, openLogger, writeEntry, resolveLogPath, LOGS_DIR };

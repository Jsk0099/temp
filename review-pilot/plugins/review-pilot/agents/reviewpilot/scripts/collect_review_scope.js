#!/usr/bin/env node
/**
 * Review Pilot - collect deterministic git review scope as JSON.
 *
 * This script does NOT modify the repository. It resolves a base ref, computes
 * the merge-base diff scope filtered to first-parent non-merge branch commits,
 * optionally includes
 * working-tree changes, resolves role extension presets (UI / Backend / DB),
 * filters by file extension, and marks generated / vendor / binary / lock /
 * minified files as skipped.
 *
 * To reduce downstream AI-credit usage it also performs a deterministic
 * "pre-scan" over ADDED diff lines only and emits candidate findings
 * (deprecated `::ng-deep`, hardcoded SCSS colors when SCSS variables exist,
 * missing doc comments, and legacy patterns) plus the trimmed diff hunks, so
 * the model can review from one JSON payload instead of issuing many git calls.
 *
 * Node.js >= 16. No third-party dependencies.
 */

'use strict';

const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const { openLogger } = require('../lib/logger');

/* ------------------------------------------------------------------ *
 * Role presets
 * ------------------------------------------------------------------ */

const UI_DEVELOPER_EXTENSIONS = [
  '.html', '.htm', '.js', '.ts', '.json', '.scss', '.css',
  '.less', '.styl', '.jsp', '.properties', '.native', '.vue', '.svelte',
];

const BACKEND_DEVELOPER_EXTENSIONS = [
  '.java', '.test', '.xml', '.yml', '.yaml', '.scala', '.kt', '.properties',
  '.jsp', '.tld', '.wsdd', '.xsd', '.gradle',
];

// DB developer: stored procedures, packages, functions, triggers, plain SQL.
const DB_DEVELOPER_EXTENSIONS = [
  '.sql', '.ddl', '.dml', '.pks', '.pkb', '.prc', '.fnc', '.tab', '.vw',
  '.trg', '.pls', '.plsql', '.psql', '.tsql',
];

// FullStack: union of all role presets — no extension filtering applied.
const FULLSTACK_DEVELOPER_EXTENSIONS = Array.from(new Set([
  ...UI_DEVELOPER_EXTENSIONS,
  ...BACKEND_DEVELOPER_EXTENSIONS,
  ...DB_DEVELOPER_EXTENSIONS,
]));

const ROLE_ALIASES = {};
function registerAliases(aliases, canonical, exts) {
  for (const a of aliases) ROLE_ALIASES[a] = [canonical, exts];
}
registerAliases(
  ['ui', 'ui developer', 'ui dev', 'frontend', 'front end', 'front-end',
   'frontend developer', 'front end developer', 'front-end developer',
   'client developer', 'web ui developer', 'angular developer'],
  'UI Developer', UI_DEVELOPER_EXTENSIONS,
);
registerAliases(
  ['backend', 'back end', 'back-end', 'backend developer', 'back end developer',
   'back-end developer', 'backend dev', 'server developer',
   'server-side developer', 'api developer', 'java developer', 'springboot developer'],
  'Backend Developer', BACKEND_DEVELOPER_EXTENSIONS,
);
registerAliases(
  ['db', 'db developer', 'database', 'database developer', 'dba',
   'sql developer', 'data developer', 'plsql developer', 'pl/sql developer'],
  'DB Developer', DB_DEVELOPER_EXTENSIONS,
);
registerAliases(
  ['fullstack', 'full stack', 'full-stack', 'fullstack developer',
   'full stack developer', 'full-stack developer'],
  'FullStack Developer', FULLSTACK_DEVELOPER_EXTENSIONS,
);

/* ------------------------------------------------------------------ *
 * Skip rules
 * ------------------------------------------------------------------ */

const SKIP_DIRS = new Set([
  '.git', '.next', '.nuxt', 'bin', 'build', 'coverage', 'dist',
  'node_modules', 'obj', 'out', 'target', 'vendor',
]);

const LOCK_FILES = new Set([
  'cargo.lock', 'composer.lock', 'gemfile.lock', 'package-lock.json',
  'pnpm-lock.yaml', 'poetry.lock', 'yarn.lock',
]);

const GENERATED_SUFFIXES = [
  '.generated.ts', '.generated.tsx', '.generated.js', '.generated.jsx',
  '.g.cs', '.pb.go', '.pb.ts', '.pb.js', '.designer.cs',
  '.min.js', '.min.css', '.map', '.snap',
];

const LANGUAGE_FILE_PREFIX = 'language_';
const LANGUAGE_FILE_SUFFIXES = ['.properties', '.properties.native'];

const EXTENSION_TOKEN_RE = /(?<![\w/-])\.?[A-Za-z][A-Za-z0-9_+-]{0,16}(?![\w/-])/g;

const KNOWN_EXTENSIONS = new Set([
  ...UI_DEVELOPER_EXTENSIONS, ...BACKEND_DEVELOPER_EXTENSIONS, ...DB_DEVELOPER_EXTENSIONS,
  '.tsx', '.jsx', '.mjs', '.cjs', '.py', '.rb', '.php', '.go', '.rs', '.cs',
  '.c', '.h', '.cpp', '.hpp', '.kts', '.toml', '.md', '.txt', '.sh', '.bash',
  '.dockerfile',
  '.spec.ts', // kept for natural-language prompt parsing; skipped by default in reviews
]);

/* ------------------------------------------------------------------ *
 * Git helpers
 * ------------------------------------------------------------------ */

function runGit(repo, args, { check = false } = {}) {
  const full = ['git'];
  if (repo) full.push('-C', repo);
  full.push(...args);
  const proc = spawnSync(full[0], full.slice(1), {
    encoding: 'utf-8',
    maxBuffer: 64 * 1024 * 1024,
  });
  const result = {
    command: full.join(' '),
    returncode: proc.status === null ? 1 : proc.status,
    stdout: proc.stdout || '',
    stderr: proc.stderr || '',
  };
  if (check && result.returncode !== 0) {
    throw new Error(`command failed: ${result.command}\n${result.stderr.trim()}`);
  }
  return result;
}

/* ------------------------------------------------------------------ *
 * Input normalization
 * ------------------------------------------------------------------ */

function normalizeExtensions(raw) {
  if (!raw) return [];
  const out = [];
  for (const part of String(raw).split(',')) {
    let ext = part.trim().replace(/^['"`]+|['"`]+$/g, '').toLowerCase();
    if (!ext) continue;
    if (!ext.startsWith('.')) ext = '.' + ext;
    if (!out.includes(ext)) out.push(ext);
  }
  return out;
}

function normalizeRole(raw) {
  if (!raw) return [null, []];
  let cleaned = String(raw).trim().replace(/^['"`]+|['"`]+$/g, '');
  cleaned = cleaned.replace(/\s+/g, ' ').toLowerCase().replace(/_/g, '-');
  cleaned = cleaned.replace(/\b(role|developer|dev)\s*[:=]\s*/g, '').trim();
  cleaned = cleaned.replace(/[.,;]+$/g, '');

  if (ROLE_ALIASES[cleaned]) return ROLE_ALIASES[cleaned];

  const aliasesByLen = Object.keys(ROLE_ALIASES).sort((a, b) => b.length - a.length);
  for (const alias of aliasesByLen) {
    const re = new RegExp(`\\b${alias.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`);
    if (re.test(cleaned)) return ROLE_ALIASES[alias];
  }
  return [null, []];
}

function dedupePreserveOrder(values) {
  const out = [];
  for (const v of values) {
    const n = v.toLowerCase();
    if (!out.includes(n)) out.push(n);
  }
  return out;
}

function sanitizeBaseInput(raw) {
  let base = String(raw || '').trim().replace(/^['"`]+|['"`]+$/g, '');
  base = base.replace(/^base\s*(branch)?\s*[:=]\s*/i, '').trim();
  base = base.replace(/^against\s+(the\s+)?/i, '').trim();
  base = base.replace(/\s+(base\s+branch|branch)$/i, '').trim();
  return base;
}

function extractExtensionsFromFragment(fragment, requireKnown = false) {
  const leading = /\s*((?:\.?[A-Za-z0-9_+-]+\s*,\s*)*\.?[A-Za-z0-9_+-]+)/.exec(fragment);
  if (leading) fragment = leading[1];
  const stop = new Set([
    'extension', 'extensions', 'only', 'base', 'branch', 'against',
    'with', 'and', 'or', 'role', 'developer',
  ]);
  const tokens = [];
  const matches = fragment.match(EXTENSION_TOKEN_RE) || [];
  for (const token of matches) {
    let cleaned = token.trim().replace(/^['"`]+|['"`]+$/g, '').replace(/[.;:]+$/g, '').toLowerCase();
    if (!cleaned) continue;
    const normalized = cleaned.startsWith('.') ? cleaned : '.' + cleaned;
    if (stop.has(cleaned.replace(/^\.+/, ''))) continue;
    if (requireKnown && !KNOWN_EXTENSIONS.has(normalized)) return '';
    if (!tokens.includes(cleaned)) tokens.push(cleaned);
  }
  return tokens.join(',');
}

function parsePrompt(prompt) {
  const text = String(prompt || '').trim();
  const lowered = text.toLowerCase();
  const parsed = {
    base: '', role: '', extensions: '',
    committed_only: lowered.includes('committed-only') || lowered.includes('committed only'),
    extensions_only: !!(
      /\bonly\s+(these\s+)?extensions\b/.test(lowered) ||
      /\bextensions\s+only\b/.test(lowered) ||
      /\bonly\s+(\.?[a-z0-9_+-]+\s*,\s*)+\.?[a-z0-9_+-]+/.test(lowered)
    ),
  };

  const [roleName] = normalizeRole(text);
  if (roleName) parsed.role = roleName;

  const basePatterns = [
    /\bbase\s*(?:branch|ref)?\s*[:=]\s*([A-Za-z0-9._/-]+)/i,
    /\bagainst\s+(?:the\s+)?([A-Za-z0-9._/-]+)\s+base\s+branch\b/i,
    /\bagainst\s+(?:the\s+)?([A-Za-z0-9._/-]+)\s+branch\b/i,
    /\bagainst\s+([A-Za-z0-9._/-]+)\b/i,
    /\bcompare\s+(?:this\s+branch\s+)?(?:against|to)\s+([A-Za-z0-9._/-]+)\b/i,
  ];
  for (const pat of basePatterns) {
    const m = pat.exec(text);
    if (m) {
      const candidate = sanitizeBaseInput(m[1]);
      if (candidate && !['the', 'a', 'base', 'branch'].includes(candidate.toLowerCase())) {
        parsed.base = candidate;
        break;
      }
    }
  }

  let extMatch = /\bextensions?\s*[:=]\s*([^;\n]+)/i.exec(text);
  if (!extMatch) extMatch = /\bwith\s+(?:these\s+)?extensions?\s+([^;\n]+)/i.exec(text);
  if (extMatch) {
    parsed.extensions = extractExtensionsFromFragment(extMatch[1]);
  } else {
    const bare = /((?:\.?[A-Za-z0-9_+-]+\s*,\s*)+\.?[A-Za-z0-9_+-]+)/.exec(text);
    if (bare && bare[1].includes(',')) {
      const bareText = bare[1];
      if (bareText.includes('.') || extractExtensionsFromFragment(bareText, true)) {
        parsed.extensions = extractExtensionsFromFragment(bareText, !bareText.includes('.'));
      }
    }
  }
  return parsed;
}

/* ------------------------------------------------------------------ *
 * Repo / ref resolution
 * ------------------------------------------------------------------ */

function resolveRepo() {
  const result = runGit(null, ['rev-parse', '--show-toplevel']);
  if (result.returncode !== 0) {
    throw new Error('current directory is not inside a git repository');
  }
  return path.resolve(result.stdout.trim());
}

function resolveRef(repo, base) {
  base = sanitizeBaseInput(base);
  const attempted = [];
  const candidates = [];
  const add = (c) => { if (c && !candidates.includes(c)) candidates.push(c); };

  // Prefer remote tracking branch so diffs compare against upstream, not a potentially stale local copy
  if (!base.startsWith('origin/')) add(`origin/${base}`);
  add(base);
  const lower = base.toLowerCase();
  if (lower !== base) {
    if (!lower.startsWith('origin/')) add(`origin/${lower}`);
    add(lower);
  }
  const upper = base.toUpperCase();
  if (upper !== base) {
    if (!upper.startsWith('origin/')) add(`origin/${upper}`);
    add(upper);
  }

  for (const candidate of candidates) {
    attempted.push(candidate);
    const result = runGit(repo, ['rev-parse', '--verify', '--quiet', `${candidate}^{commit}`]);
    if (result.returncode === 0 && result.stdout.trim()) return [candidate, attempted];
  }
  throw new Error('could not resolve base ref. attempted: ' + attempted.join(', '));
}

/* ------------------------------------------------------------------ *
 * Diff parsing
 * ------------------------------------------------------------------ */

function parseNameStatus(text, source) {
  const entries = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    const parts = line.split('\t');
    const rawStatus = parts[0];
    const status = rawStatus[0];
    let oldPath = null;
    let p = '';
    if ((status === 'R' || status === 'C') && parts.length >= 3) {
      oldPath = parts[1]; p = parts[2];
    } else if (parts.length >= 2) {
      p = parts[1];
    }
    if (p) entries.push([rawStatus, p, oldPath, source]);
  }
  return entries;
}

function collectCommitTouchedPaths(repo, range) {
  const result = runGit(repo, [
    'log', '--first-parent', '--no-merges', '--name-status',
    '--find-renames', '--find-copies', '--format=', range,
  ]);
  if (result.returncode !== 0) return null;

  const paths = new Set();
  for (const [, p, oldPath] of parseNameStatus(result.stdout, 'branch-commit')) {
    if (p) paths.add(p);
    if (oldPath) paths.add(oldPath);
  }
  return paths;
}

function isAllowedPath(p, oldPath, allowedPaths) {
  if (!allowedPaths) return true;
  return allowedPaths.has(p) || (oldPath && allowedPaths.has(oldPath));
}

function parseNumstat(text) {
  const stats = {};
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    const parts = line.split('\t');
    if (parts.length < 3) continue;
    const addRaw = parts[0], delRaw = parts[1], p = parts[parts.length - 1];
    const additions = /^\d+$/.test(addRaw) ? parseInt(addRaw, 10) : null;
    const deletions = /^\d+$/.test(delRaw) ? parseInt(delRaw, 10) : null;
    stats[p] = [additions, deletions];
    if (p.includes(' => ')) {
      const final = p.split(' => ').pop().trim().replace(/}/g, '');
      stats[final] = [additions, deletions];
    }
  }
  return stats;
}

function lineCountIfText(repo, relPath) {
  const full = path.join(repo, relPath);
  let data;
  try {
    if (!fs.existsSync(full) || !fs.statSync(full).isFile()) return null;
    data = fs.readFileSync(full);
  } catch { return null; }
  if (data.slice(0, 8192).includes(0)) return null;
  try { return data.toString('utf-8').split('\n').length; } catch { return null; }
}

function hasRequestedExtension(p, extensions) {
  const lower = p.toLowerCase();
  return extensions.some((ext) => lower.endsWith(ext));
}

function isLanguagePropertiesFile(name) {
  return name.startsWith(LANGUAGE_FILE_PREFIX) &&
    LANGUAGE_FILE_SUFFIXES.some((suffix) => name.endsWith(suffix));
}

function skipReason(p, status, additions, extensions, skipExtensions) {
  const lower = p.toLowerCase().replace(/\\/g, '/');
  const name = path.posix.basename(lower);
  const segments = lower.split('/').filter(Boolean);

  if (status.startsWith('D')) return 'deleted file; listed but not reviewed for current content';
  // Explicit skip-list wins over the include-list — checked first so user overrides always apply.
  if (skipExtensions && skipExtensions.length > 0) {
    if (skipExtensions.some(function(ext) { return lower.endsWith(ext); })) {
      return 'extension in skip list';
    }
  }
  if (!hasRequestedExtension(p, extensions)) return 'extension not requested';
  if (isLanguagePropertiesFile(name)) return 'language properties file; excluded from review';
  // Skip .spec.ts files unless the caller explicitly includes .spec.ts in the extension list.
  // They match .ts from the UI preset but are not part of production code review scope.
  if (/\.spec\.ts$/i.test(lower) && !extensions.includes('.spec.ts')) {
    return 'test spec file; excluded from review (add .spec.ts to extensions to include)';
  }
  if (segments.some((s) => SKIP_DIRS.has(s))) return 'generated/vendor/build output path';
  if (LOCK_FILES.has(name)) return 'lock file';
  if (GENERATED_SUFFIXES.some((s) => lower.endsWith(s))) return 'generated, minified, source map, or snapshot file';
  if (additions === null) return 'binary or non-text numstat';
  return '';
}

/* ------------------------------------------------------------------ *
 * Diff hunk extraction (added lines only, diff-scoped)
 * ------------------------------------------------------------------ */

function getUnifiedDiff(repo, diffArgs, file, context) {
  const args = [...diffArgs, `--unified=${context}`, '--', file];
  const r = runGit(repo, args);
  return r.returncode === 0 ? r.stdout : '';
}

/**
 * Parse a unified diff into added lines with their new-file line numbers.
 * Returns [{ line, text }] for lines beginning with '+' (excluding '+++').
 */
function parseAddedLines(diffText) {
  const added = [];
  let newLine = 0;
  for (const raw of diffText.split('\n')) {
    if (raw.startsWith('@@')) {
      const m = /\+(\d+)/.exec(raw);
      newLine = m ? parseInt(m[1], 10) : newLine;
      continue;
    }
    if (raw.startsWith('+++') || raw.startsWith('---')) continue;
    if (raw.startsWith('+')) {
      added.push({ line: newLine, text: raw.slice(1) });
      newLine += 1;
    } else if (raw.startsWith('-')) {
      // removed line: does not advance new-file counter
    } else if (raw.startsWith('\\')) {
      // "\ No newline at end of file"
    } else {
      newLine += 1; // context line
    }
  }
  return added;
}

/* ------------------------------------------------------------------ *
 * Pre-scan heuristics (deterministic, credit-saving)
 * Scans ADDED lines only so suggestions apply to the diff, not legacy code.
 * ------------------------------------------------------------------ */

function collectScssVariables(repo) {
  // Best-effort: gather declared SCSS variable names so we can suggest reuse.
  const vars = new Set();
  const r = runGit(repo, ['grep', '-h', '-oE', '\\$[A-Za-z0-9_-]+\\s*:', '--',
    '*.scss', '*.sass']);
  if (r.returncode === 0) {
    for (const line of r.stdout.split('\n')) {
      const m = /(\$[A-Za-z0-9_-]+)/.exec(line);
      if (m) vars.add(m[1]);
    }
  }
  return vars;
}

const HEX_COLOR_RE = /#[0-9a-fA-F]{3,8}\b/;
const RGB_COLOR_RE = /\b(?:rgb|rgba|hsl|hsla)\s*\(/i;

function preScanLine(file, lineNo, text, ctx) {
  const findings = [];
  const lower = file.toLowerCase();
  const trimmed = text.trim();
  if (!trimmed) return findings;

  const isScss = lower.endsWith('.scss') || lower.endsWith('.sass');
  const isStyle = isScss || lower.endsWith('.css') || lower.endsWith('.less') || lower.endsWith('.styl');
  const isTs = lower.endsWith('.ts') || lower.endsWith('.tsx');
  const isJsTs = isTs || lower.endsWith('.js') || lower.endsWith('.jsx') || lower.endsWith('.mjs') || lower.endsWith('.cjs');
  const isJava = lower.endsWith('.java');
  const isSql = ctx.dbExt.some((e) => lower.endsWith(e));

  const push = (rule, severity, message, suggestion) =>
    findings.push({ file, line: lineNo, rule, severity, snippet: trimmed.slice(0, 200), message, suggestion });

  // 1) Deprecated Angular ::ng-deep
  if ((isStyle || isTs) && /::ng-deep|\/deep\/|>>>/.test(text)) {
    push('angular-ng-deep', 'Major',
      'Deprecated Angular shadow-piercing selector (`::ng-deep` / `/deep/` / `>>>`).',
      'Prefer component-scoped styles, :host / :host-context, or a documented global style. If ::ng-deep is unavoidable, scope it under :host and add a TODO with a tracking note.');
  }

  // 2) Hardcoded color in SCSS when variables exist
  if (isStyle && (HEX_COLOR_RE.test(text) || RGB_COLOR_RE.test(text)) &&
      !/\$[A-Za-z0-9_-]+/.test(text) && !/\bvar\(\s*--/.test(text)) {
    if (ctx.scssVars.size > 0) {
      push('scss-hardcoded-color', 'Minor',
        'Hardcoded color literal while the codebase defines SCSS variables.',
        'Replace with an existing SCSS variable (e.g. one of the declared `$...` tokens) or a CSS custom property to keep theming consistent.');
    }
  }

  // 3) Legacy JS/TS patterns
  if (isJsTs) {
    if (/^\s*var\s+[A-Za-z_$]/.test(text)) {
      push('legacy-var', 'Minor', 'Legacy `var` declaration.',
        'Use `const` (or `let` when reassigned) for block scoping.');
    }
    if (/\$\.(ajax|get|post|each|ready)\b/.test(text) || /jQuery\(/.test(text)) {
      push('legacy-jquery', 'Minor', 'jQuery usage in a modern UI stack.',
        'Prefer framework-native APIs (Angular HttpClient, fetch/Observables, template bindings) instead of jQuery DOM/AJAX calls.');
    }
    if (/==[^=]/.test(text) && !/===|!==/.test(text)) {
      push('loose-equality', 'Minor', 'Loose equality (`==`).',
        'Use strict equality `===` / `!==` to avoid coercion bugs.');
    }
    if (/\bconsole\.(log|debug)\s*\(/.test(text)) {
      push('debug-logging', 'Minor', 'Leftover console logging.',
        'Remove debug logging or route through the project logger.');
    }
  }

  // 4) Legacy Java patterns
  if (isJava) {
    if (/System\.out\.print(ln)?\s*\(/.test(text)) {
      push('java-sysout', 'Minor', 'Direct `System.out` logging.',
        'Use the configured logger (e.g. SLF4J) instead of System.out.');
    }
    if (/new\s+(ArrayList|HashMap|HashSet)\s*\(\s*\)/.test(text) && /\b(List|Map|Set)\s*<.*?>\s*=\s*new\s+\w+\s*\(\s*\)/.test(text) === false) {
      // weak signal only; leave to model
    }
    if (/printStackTrace\s*\(\s*\)/.test(text)) {
      push('java-printstacktrace', 'Major', '`printStackTrace()` swallows errors into stderr.',
        'Log via the project logger with context, or rethrow as an appropriate exception.');
    }
  }

  // 5) SQL anti-patterns
  if (isSql) {
    if (/select\s+\*/i.test(text)) {
      push('sql-select-star', 'Minor', '`SELECT *` in SQL.',
        'List explicit columns to keep result shape stable and avoid over-fetching.');
    }
    if (/\bnolock\b/i.test(text)) {
      push('sql-nolock', 'Major', '`NOLOCK` hint can read uncommitted/dirty data.',
        'Confirm the isolation level is intended; prefer documented isolation over scattered NOLOCK hints.');
    }
  }

  return findings;
}

/**
 * Detect new top-level declarations on added lines that lack a preceding
 * doc comment. Diff-scoped: only flags declarations introduced in the diff.
 */
function detectMissingComments(file, addedLines) {
  const lower = file.toLowerCase();
  const findings = [];
  const declRe = (() => {
    if (lower.endsWith('.java')) {
      return /^\s*(public|private|protected)?\s*(static\s+)?(final\s+)?(class|interface|enum|[A-Za-z0-9_<>\[\], ]+\s+[A-Za-z0-9_]+\s*\()/;
    }
    if (lower.endsWith('.ts') || lower.endsWith('.tsx') || lower.endsWith('.js') ||
        lower.endsWith('.jsx') || lower.endsWith('.mjs') || lower.endsWith('.cjs')) {
      return /^\s*(export\s+)?(default\s+)?(async\s+)?(function\s+[A-Za-z0-9_]+|class\s+[A-Za-z0-9_]+|@[A-Za-z]+|[A-Za-z0-9_]+\s*\([^)]*\)\s*[:{])/;
    }
    return null;
  })();
  if (!declRe) return findings;

  const byLine = new Map(addedLines.map((a) => [a.line, a.text]));
  for (const { line, text } of addedLines) {
    if (text.trim().startsWith('//') || text.trim().startsWith('*') ||
        text.trim().startsWith('/*')) continue;
    if (!declRe.test(text)) continue;
    if (/\b(get|set|if|for|while|switch|catch|return)\b/.test(text.trim().split(/\s+/)[0] || '')) continue;
    const prev = (byLine.get(line - 1) || '').trim();
    const prev2 = (byLine.get(line - 2) || '').trim();
    const hasDoc = prev.endsWith('*/') || prev.startsWith('//') || prev.startsWith('*') ||
                   prev2.endsWith('*/') || /@[A-Za-z]/.test(prev);
    if (!hasDoc) {
      findings.push({
        file, line, rule: 'missing-comment', severity: 'Suggestion',
        snippet: text.trim().slice(0, 200),
        message: 'New declaration introduced without a doc comment.',
        suggestion: 'Add a short comment describing intent/params/return. Only for this newly added code, do not annotate untouched legacy code.',
      });
    }
  }
  return findings;
}

/* ------------------------------------------------------------------ *
 * Entry collection
 * ------------------------------------------------------------------ */

function collectDiffEntries(repo, diffArgs, source, ctx, options = {}) {
  const ns = runGit(repo, [...diffArgs, '--name-status', '--find-renames', '--find-copies']);
  const num = runGit(repo, [...diffArgs, '--numstat']);
  const stats = parseNumstat(num.stdout);
  const entries = [];
  for (const [rawStatus, p, oldPath, itemSource] of parseNameStatus(ns.stdout, source)) {
    if (!isAllowedPath(p, oldPath, options.allowedPaths)) {
      if (options.ignoredEntries) {
        options.ignoredEntries.push({
          status: rawStatus,
          path: p,
          old_path: oldPath,
          source: itemSource,
          reason: 'not touched by first-parent non-merge branch commits',
        });
      }
      continue;
    }

    const [additions, deletions] = stats[p] || [null, null];
    const reason = skipReason(p, rawStatus, additions, ctx.extensions, ctx.skipExtensions);
    const reviewed = reason === '';
    const entry = {
      status: rawStatus, path: p, old_path: oldPath, source: itemSource,
      additions, deletions, reviewed, reason_if_skipped: reason,
    };

    if (reviewed && ctx.prescan) {
      const diffText = getUnifiedDiff(repo, diffArgs, p, ctx.diffContext);
      const addedLines = parseAddedLines(diffText);
      const findings = [];
      for (const { line, text } of addedLines) {
        findings.push(...preScanLine(p, line, text, ctx));
      }
      findings.push(...detectMissingComments(p, addedLines));
      ctx.prescanFindings.push(...findings);
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
      entry.added_lines = addedLines.length;
    }
    entries.push(entry);
  }
  if (ctx.logInfo) ctx.logInfo('Git diff collected', {
    source: source,
    entries: entries.length,
    reviewed: entries.filter(function(e) { return e.reviewed; }).length,
  });
  return entries;
}

/* ------------------------------------------------------------------ *
 * Argument parsing
 * ------------------------------------------------------------------ */

function parseArgs(argv) {
  const args = {
    prompt: '', base: '', extensions: '', role: '', skip_extensions: '',
    extensions_only: false, committed_only: false, local_only: false,
    prescan: true, include_diffs: true, diff_context: 3,
    max_diff_bytes: parseInt(process.env.REVIEWPILOT_FILE_CHUNK_BYTES, 10) || 6000, max_files: 0,
    log_file: '',
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    switch (a) {
      case '--prompt': args.prompt = next(); break;
      case '--base': args.base = next(); break;
      case '--extensions': args.extensions = next(); break;
      case '--skip-extensions': args.skip_extensions = next(); break;
      case '--role': args.role = next(); break;
      case '--extensions-only': args.extensions_only = true; break;
      case '--committed-only': args.committed_only = true; break;
      case '--local-only': args.local_only = true; break;
      case '--no-prescan': args.prescan = false; break;
      case '--no-diffs': args.include_diffs = false; break;
      case '--diff-context': args.diff_context = parseInt(next(), 10) || 3; break;
      case '--max-diff-bytes': args.max_diff_bytes = parseInt(next(), 10) || 6000; break;
      case '--max-files': args.max_files = parseInt(next(), 10) || 0; break;
      case '--log-file': args.log_file = next(); break;
      case '-h': case '--help': args.help = true; break;
      default:
        if (a.startsWith('--')) { /* ignore unknown */ }
    }
  }
  return args;
}

function mergePromptWithArgs(args) {
  const parsed = args.prompt ? parsePrompt(args.prompt) : {
    base: '', role: '', extensions: '', committed_only: false, extensions_only: false,
  };
  if (!args.base && parsed.base) args.base = parsed.base;
  if (!args.role && parsed.role) args.role = parsed.role;
  if (!args.extensions && parsed.extensions) args.extensions = parsed.extensions;
  args.committed_only = !!(args.committed_only || parsed.committed_only);
  args.extensions_only = !!(args.extensions_only || parsed.extensions_only);
  args.prompt_parse = parsed;
  return args;
}

function buildMissingInputsOutput(args) {
  return {
    tool: 'reviewpilot.collect_review_scope',
    errors: ['missing required input. provide a base branch and either a role preset (UI/Backend/DB) or comma-separated extensions.'],
    base_input: args.base,
    role_input: args.role,
    extensions_input: args.extensions,
    prompt_parse: args.prompt_parse || {},
    examples: [
      '$reviewpilot Review all changes done by the UI developer against the QA base branch',
      '$reviewpilot base=main extensions=.ts,.tsx,.js,.jsx',
      '$reviewpilot Review DB developer changes against develop base branch',
    ],
  };
}

/* ------------------------------------------------------------------ *
 * Main
 * ------------------------------------------------------------------ */

function main() {
  const args = mergePromptWithArgs(parseArgs(process.argv.slice(2)));

  // Attach to the session log file if the server passed one.
  const log = args.log_file ? openLogger(args.log_file) : null;
  const logInfo  = (msg, data) => { if (log) log.info(msg, data); };
  const logWarn  = (msg, data) => { if (log) log.warn(msg, data); };
  const logError = (msg, data) => { if (log) log.error(msg, data); };

  if (args.help) {
    process.stdout.write('Usage: collect_review_scope.js --base <ref> [--role <UI|Backend|DB>] ' +
      '[--extensions .a,.b] [--extensions-only] [--committed-only] [--prompt "..."] ' +
      '[--no-prescan] [--no-diffs] [--diff-context N] [--max-diff-bytes N] [--max-files N] ' +
      '[--log-file <path>]\n');
    return 0;
  }

  logInfo('collect_review_scope started', { base: args.base, role: args.role, extensions: args.extensions });

  if (!args.base) {
    logError('Missing required input: no base branch provided');
    console.log(JSON.stringify(buildMissingInputsOutput(args), null, 2));
    return 2;
  }

  const [roleName, roleExtensions] = normalizeRole(args.role);
  const explicitExtensions = normalizeExtensions(args.extensions);

  let finalExtensions, extensionSource;
  if (args.extensions_only) {
    finalExtensions = explicitExtensions; extensionSource = 'explicit extensions only';
  } else if (roleExtensions.length && explicitExtensions.length) {
    finalExtensions = dedupePreserveOrder([...roleExtensions, ...explicitExtensions]);
    extensionSource = 'role preset plus explicit extensions';
  } else if (roleExtensions.length) {
    finalExtensions = roleExtensions; extensionSource = 'role preset';
  } else {
    finalExtensions = explicitExtensions; extensionSource = 'explicit extensions';
  }

  if (!finalExtensions.length) {
    logError('Missing required input: no extensions resolved', { role: args.role, extensions: args.extensions });
    console.log(JSON.stringify(buildMissingInputsOutput(args), null, 2));
    return 2;
  }

  logInfo('Extensions resolved', { extensionSource, finalExtensions });

  const output = {
    tool: 'reviewpilot.collect_review_scope',
    base_input: args.base,
    base_sanitized: sanitizeBaseInput(args.base),
    role_input: args.role,
    role_resolved: roleName,
    role_extensions: roleExtensions,
    explicit_extensions: explicitExtensions,
    extension_filter: finalExtensions,
    extension_source: extensionSource,
    committed_only: args.committed_only,
    local_only: args.local_only,
    merge_commits: 'excluded',
    prescan_enabled: args.prescan,
    prompt_parse: args.prompt_parse || {},
    errors: [],
    warnings: [],
    commands_to_inspect_next: [],
  };

  try {
    const repo = resolveRepo();
    output.repo_root = repo;
    logInfo('Repo resolved', { repo });

    const ctx = {
      extensions: finalExtensions,
      skipExtensions: normalizeExtensions(args.skip_extensions || ''),
      prescan: args.prescan,
      includeDiffs: args.include_diffs,
      diffContext: args.diff_context,
      maxDiffBytes: args.max_diff_bytes,
      scssVars: args.prescan ? collectScssVariables(repo) : new Set(),
      dbExt: DB_DEVELOPER_EXTENSIONS,
      prescanFindings: [],
      logInfo: logInfo,
    };

    const status = runGit(repo, ['status', '--short', '--branch']);
    const branch = runGit(repo, ['branch', '--show-current']);
    const currentBranch = branch.stdout.trim() ||
      runGit(repo, ['rev-parse', '--short', 'HEAD']).stdout.trim();
    logInfo('Branch detected', { currentBranch });

    const [baseRef, attempted] = resolveRef(repo, args.base);
    logInfo('Base ref resolved', { baseRef, attempted });

    const mergeBase = runGit(repo, ['merge-base', baseRef, 'HEAD'], { check: true }).stdout.trim();
    logInfo('Merge base computed', { mergeBase });

    const commitRange = `${baseRef}..HEAD`;
    const branchDiffRange = `${mergeBase}..HEAD`;
    const branchTouchedPaths = collectCommitTouchedPaths(repo, commitRange);
    const ignoredBranchEntries = [];

    // Walk the current branch's first-parent line and ignore merge commits.
    // This keeps synced/merged/inherited branch content out of the review scope.
    const commits = runGit(repo, ['log', '--first-parent', '--no-merges', '--oneline', '--decorate', commitRange]);
    const mergeCommits = runGit(repo, ['log', '--first-parent', '--merges', '--oneline', commitRange]);
    const stat = runGit(repo, ['diff', '--stat', branchDiffRange]);
    logInfo('Git log', {
      commits: commits.stdout.split('\n').filter(Boolean).length,
      mergeCommitsExcluded: mergeCommits.stdout.split('\n').filter(Boolean).length,
      branchTouchedFiles: branchTouchedPaths ? branchTouchedPaths.size : null,
    });

    let entries = [];

    if (!args.local_only) {
      entries.push(...collectDiffEntries(repo, ['diff', branchDiffRange], 'branch-diff', ctx, {
        allowedPaths: branchTouchedPaths,
        ignoredEntries: ignoredBranchEntries,
      }));
      logInfo('Branch diff entries collected', {
        count: entries.length,
        ignoredNotTouchedByBranchCommits: ignoredBranchEntries.length,
      });
    } else {
      logInfo('Local-only mode: branch diff skipped', { localOnly: true });
    }

    // Collect working-tree changes when local-only is set (overrides committed_only)
    // or when committed_only is explicitly off.
    if (!args.committed_only || args.local_only) {
      entries.push(...collectDiffEntries(repo, ['diff', '--cached'], 'staged', ctx));
      entries.push(...collectDiffEntries(repo, ['diff'], 'unstaged', ctx));
      const untracked = runGit(repo, ['ls-files', '--others', '--exclude-standard']);
      for (const p of untracked.stdout.split('\n').map((l) => l.trim()).filter(Boolean)) {
        const additions = lineCountIfText(repo, p);
        const reason = skipReason(p, 'A', additions, finalExtensions, ctx.skipExtensions);
        entries.push({
          status: 'A', path: p, old_path: null, source: 'untracked',
          additions, deletions: additions !== null ? 0 : null,
          reviewed: reason === '', reason_if_skipped: reason,
        });
      }
      logInfo('Working-tree entries collected', { totalEntries: entries.length });
    }

    if (args.max_files > 0) {
      // Cap reviewed entries to protect the credit budget; rest marked deferred.
      let reviewedSeen = 0;
      for (const e of entries) {
        if (e.reviewed) {
          reviewedSeen++;
          if (reviewedSeen > args.max_files) {
            e.reviewed = false;
            e.reason_if_skipped = `deferred: exceeds --max-files=${args.max_files} budget`;
            delete e.diff;
          }
        }
      }
      logWarn('Max-files cap applied', { max: args.max_files });
    }

    const reviewedCount = entries.filter((e) => e.reviewed).length;
    const skippedCount = entries.filter((e) => !e.reviewed).length;

    logInfo('Pre-scan complete', {
      prescanFindings: ctx.prescanFindings.length,
      filesReviewed: reviewedCount,
      filesSkipped: skippedCount,
    });

    Object.assign(output, {
      skip_extensions: ctx.skipExtensions,
      current_branch: currentBranch,
      base_ref: baseRef,
      base_resolution_attempted: attempted,
      merge_base: mergeBase,
      diff_range: branchDiffRange,
      commit_walk: 'first-parent non-merge commits',
      status_short_branch: status.stdout.split('\n').filter(Boolean),
      commit_range: `${baseRef}..${currentBranch}`,
      commits: commits.stdout.split('\n').filter(Boolean),
      merge_commits_excluded: mergeCommits.stdout.split('\n').filter(Boolean),
      diff_stat: stat.stdout.split('\n').filter(Boolean),
      ignored_branch_diff_files: ignoredBranchEntries,
      files_changed: entries.length,
      files_reviewed: reviewedCount,
      files_skipped: skippedCount,
      files: entries,
      prescan_findings: ctx.prescanFindings,
      prescan_summary: summarizeFindings(ctx.prescanFindings),
      commands_to_inspect_next: [
        `git diff --find-renames --find-copies ${branchDiffRange} -- <file>`,
        `git log --first-parent --no-merges --name-status ${commitRange} -- <file>`,
        'git diff --cached -- <file>',
        'git diff -- <file>',
        'git grep -n <changed-symbol>',
      ],
    });
    logInfo('collect_review_scope finished successfully', { filesChanged: entries.length });
  } catch (exc) {
    const errMsg = String(exc && exc.message ? exc.message : exc);
    logError('collect_review_scope failed', { error: errMsg });
    output.errors = [errMsg];
    console.log(JSON.stringify(output, null, 2));
    return 2;
  }

  console.log(JSON.stringify(output, null, 2));
  return 0;
}

function summarizeFindings(findings) {
  const byRule = {};
  for (const f of findings) byRule[f.rule] = (byRule[f.rule] || 0) + 1;
  return { total: findings.length, by_rule: byRule };
}

// Use process.exitCode instead of process.exit() so Node.js drains the stdout
// pipe before terminating. process.exit() is abrupt and truncates async writes
// when stdout is a pipe (which is the case when the server spawns this script).
process.exitCode = main();

# Review Pilot — Code Reviewer & Optimiser for Codex

Senior tech-lead branch review for Codex IDE/CLI. Compares the whole current branch against a base branch (merge commits excluded), reviews only role/extension-matched files, proposes behaviour-preserving fixes, and applies them only after explicit approval. Works for **UI**, **Java**, and **DB** developers.

## Install (Claude Agent Skills)

Copy the whole `reviewpilot/` folder into your Claude skills directory — no build step, no dependencies beyond Node.js.

- **Project-level** (only this repo): `.claude/skills/reviewpilot/`
- **User-level** (all your projects): `~/.claude/skills/reviewpilot/`

```bash
# from the unzipped bundle:
mkdir -p .claude/skills
cp -r reviewpilot .claude/skills/
```

The folder name (`reviewpilot`) and the `name:` field in `SKILL.md` must match. Restart / reload Claude so it picks up the new skill, then invoke it with `$reviewpilot ...`. The exact skills path can vary by client — confirm at https://docs.claude.com/en/docs/claude-code/overview if your setup differs.

> Codex compatibility: the same folder also works under `.agents/skills/reviewpilot`. `openai.yaml` is Codex-only interface metadata and is ignored by Claude.

```
reviewpilot/
├── SKILL.md                       # the skill instructions
├── README.md
├── openai.yaml                    # interface metadata (display name: Review Pilot)
├── scripts/
│   └── collect_review_scope.js    # deterministic, read-only scope collector (Node.js)
└── ui/
    └── index.html                 # optional agent UI (inputs + live step tracker)
```

## Use in Codex IDE/CLI

```text
$reviewpilot Review all changes done by the UI developer against the QA base branch, identify issues, propose fixes, and take input from user to apply safe fixes.
$reviewpilot Review backend developer changes against develop base branch with extensions .java,.xml,.gradle
$reviewpilot Review DB developer changes against develop base branch
```

## Role presets

- **UI Developer**: `.html`, `.htm`, `.js`, `.ts`, `.spec.ts`, `.json`, `.scss`, `.css`, `.less`, `.styl`, `.jsp`, `.properties`, `.native`, `.vue`, `.svelte` — covers HTML, Angular, jQuery, pure JS/TS, and spec files.
- **Backend Developer**: `.java`, `.test`, `.xml`, `.yml`, `.yaml`, `.scala`, `.kt`, `.properties`, `.jsp`, `.tld`, `.wsdd`, `.xsd`, `.gradle` — covers EJB, Spring Boot, controllers, and tests.
- **DB Developer**: `.sql`, `.ddl`, `.dml`, `.pks`, `.pkb`, `.prc`, `.fnc`, `.tab`, `.vw`, `.trg`, `.pls`, `.plsql`, `.psql`, `.tsql` — covers stored procedures and SQL.

Explicit comma-separated extensions are also supported. If both a role and explicit extensions are given, the union is used unless the prompt says `only these extensions`.

## What's new in this version

- **Renamed to Review Pilot.**
- **Node.js scope collector** (`scripts/collect_review_scope.js`) replacing the Python script. Requires Node.js >= 16, no third-party packages.
- **Merge commits are neglected** (`git log --first-parent --no-merges`) and reported separately.
- **DB Developer role** added alongside UI and Backend.
- **Reviews and comments changed code only** — no rewriting of untouched legacy code; verifies safe interaction with surrounding legacy code.
- **Modern-pattern guidance** for the changed lines (e.g. `const`/`let`, strict equality, async/await, framework-native over jQuery, constructor injection, set-based SQL).
- **Deprecated Angular `::ng-deep` / `/deep/` / `>>>` detection.**
- **SCSS variable reuse**: detects declared `$...` variables and flags hardcoded color literals in changed style code.
- **AI-credit savings**: a deterministic pre-scan plus trimmed inline diffs let the model review one JSON payload instead of issuing many git calls. Budget flags: `--no-prescan`, `--no-diffs`, `--diff-context N`, `--max-diff-bytes N`, `--max-files N`.
- **Agent UI** (`ui/index.html`) to enter role/extensions, base branch, and extra prompt, with a live step tracker; it generates the exact `$reviewpilot` prompt and scope command.

## Script usage

```bash
node scripts/collect_review_scope.js --prompt "Review UI developer changes against QA base branch"
node scripts/collect_review_scope.js --base main --role "UI Developer"
node scripts/collect_review_scope.js --base develop --role "DB Developer"
node scripts/collect_review_scope.js --base main --extensions ".ts,.tsx" --extensions-only --max-files 25
```

The script is read-only. It never modifies the repository or applies fixes; applying happens only after explicit approval inside the skill workflow.

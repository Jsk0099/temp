# My Private Claude Code Plugin Marketplace

This repo is both a **plugin** (`plugins/review-pilot`) and a **marketplace**
that distributes it (`.claude-plugin/marketplace.json`).

## Structure

```
my-plugins-marketplace/
├── .claude-plugin/
│   └── marketplace.json          # Marketplace manifest (lists plugins)
├── plugins/
│   └── review-pilot/
│       ├── .claude-plugin/
│       │   └── plugin.json        # Plugin manifest
│       ├── agents/
│       │   └── code-reviewer.md   # Subagent (YAML frontmatter + prompt)
│       ├── commands/
│       │   └── review.md          # Slash command -> shows up in /menu
│       ├── skills/
│       │   └── code-reviewer/
│       │       └── SKILL.md       # Model-invoked skill
│       ├── hooks/
│       │   └── hooks.json         # Hooks (incl. auto-approve example)
│       └── .mcp.json              # Optional bundled MCP servers
├── examples/
│   └── project-settings.json      # Pre-granted permissions for your projects
└── README.md
```

## Map your existing agents/skills into this

- Each **skill** = one folder under `skills/<name>/` containing `SKILL.md`
  (copy your existing skill folders here as-is, including any helper files).
- Each **agent** = one `.md` file under `agents/` with `name` + `description`
  in the YAML frontmatter (copy your existing agent files here).
- Each **slash command** = one `.md` file under `commands/`. Add a thin command
  per skill if you want it invokable from the `/` menu.

## Publish to a PRIVATE GitHub repo

```bash
cd my-plugins-marketplace
git init
git add .
git commit -m "Initial plugin marketplace"
gh repo create my-plugins-marketplace --private --source=. --push
# (or create the private repo in the GitHub UI and: git remote add origin ... ; git push -u origin main)
```

Because the repo is private, the machine installing it must be authenticated:
- HTTPS: `gh auth login` (GitHub CLI), or a Personal Access Token with `repo` scope.
- SSH: an SSH key added to your GitHub account.

## Install

```
/plugin marketplace add YOUR_USERNAME/my-plugins-marketplace
/plugin install review-pilot@AsiteAIAssets
```

For SSH-based private access:
```
/plugin marketplace add git@github.com:YOUR_USERNAME/my-plugins-marketplace.git
```

Verify:
```
/plugin                 # browse/manage installed plugins
/agents                 # your agent should be listed
/                       # your /review command should appear
```

## Pre-grant permissions (no per-tool prompts)

You cannot silently bypass ALL consent for arbitrary users — but for your own
projects/team you control this with settings (highest precedence wins):

1. **Project settings** — commit `.claude/settings.json` into the project repo
   (see `examples/project-settings.json`). Anyone working in that repo inherits
   the `permissions.allow` list, so those tools won't prompt.
2. **Enterprise managed settings** — for org-wide enforcement, an admin places a
   managed settings file (system-level) that users cannot override.
3. **Hooks auto-approve** — `hooks/hooks.json` ships a PreToolUse hook that
   returns `permissionDecision: allow` for read-only tools.
4. **Session flag** — `claude --dangerously-skip-permissions` skips all prompts
   for a session (use only in trusted/sandboxed environments).

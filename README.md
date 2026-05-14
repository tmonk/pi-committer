# pi-committer

**Conventional commit automation for the [pi coding agent](https://pi.ai).**

Automatically creates structured, meaningful commits as you work. Defaults to committing when a goal completes — no more lost work or "WIP" messages.

## Features

- **Goal-aware** — commits automatically when a goal completes (`on_goal` trigger, default). Configurable to other modes.
- **Intelligent staged commits** — a lightweight subagent analyzes your diff and splits changes into logical commits (feature + tests together, docs separate, etc.)
- **Subagent-generated messages** — each commit gets a context-aware conventional commit message written by a quick subagent using your model
- **Model selection** — choose which model generates commit messages via `/commit-model` or `subagent_model` config
- **Multi-repo support** — detects and commits in any git repositories the agent touched (subdirs, siblings, from session history)
- **`commit_changes` tool** — agents can call this custom tool to checkpoint their work
- **Exclusion patterns** — skip files matching glob patterns (`*.log`, `build/`, etc.)
- **Slash commands** — `/commit`, `/commit-config`, `/commit-model`

## Quick Start

```bash
# Clone the repo
git clone <this-repo> ~/projects/pi-committer

# Install dependencies
cd ~/projects/pi-committer && npm install

# Load it in a session (no global interference)
pi -e ~/projects/pi-committer/index.ts
```

### Global auto-discovery

```bash
ln -s ~/projects/pi-committer ~/.pi/agent/extensions/pi-committer
```

## Configuration

Create `.pi-committer.toml` (or `.pi-committer.json`) in your project root. The extension walks up directories to find it.

```toml
[committer]
enabled           = true
trigger_mode      = "on_goal"       # on_goal | agent_sensible | after_tool | manual
detailed_body     = true
min_changes       = 1
staged_commits    = true
exclude_patterns  = ["*.log", "node_modules/"]

# Optional: override the model used by the commit-message subagent
# subagent_model = "openai/gpt-4o-mini"

# Optional: extend conventional commit types / restrict scopes
# custom_types    = ["api", "wip"]
# allowed_scopes  = ["api", "cli", "core"]
```

### Trigger modes

| Mode | Behaviour |
|---|---|
| `on_goal` (default) | Commits only when a goal transitions to `completed` |
| `agent_sensible` | Commits after every agent turn |
| `after_tool` | Commits after each tool call |
| `manual` | Never auto-commits; use `/commit` or `commit_changes` only |

## Usage

### Auto-commit on goal completion

```
/goal "Add user authentication"
> agent implements auth logic
/goal complete   ← auto-commits with staged grouping
```

### Manual commit

```
/commit
```

Or ask the agent: "Save my progress" — it calls the `commit_changes` tool.

### Choose the commit-message model

```
/commit-model
```

Opens an interactive selector. Defaults to your current agent model.

### Reload config

```
/commit-config
```

## How staged commits work

When `staged_commits = true` (default), the subagent receives your full diff and organizes changes into logical commit groups. For example, editing a source file, adding tests, and updating docs might produce:

```
feat(api): add user authentication endpoint
test(api): add authentication tests
docs: update API documentation
```

The subagent decides the grouping based on semantic understanding, not file-extension rules.

## Multi-repo

If the agent edits files in multiple git repositories during a session, `commit_changes` finds and commits in all of them. Detection works via:

1. Subdirectory scanning from the working directory
2. Sibling repo scanning from the common parent directory
3. Session tool-call history (repos referenced by `write`, `read`, `bash` tools)

## Architecture

```
Extension events (turn_end, tool_result, goal_event)
        │
        ▼
  commitAllRepos(dir, ctx)
        │
        ├─ findDirtyRepos(ctx)     discover all dirty repos
        │
        └─ tryCommit(repo, ...)    for each dirty repo
               │
               ├─ stageAll / unstageExcluded
               │
               ├─ generateStagedCommitGroups   subagent decides grouping
               │      └─ createAgentSession    no tools, diff inline
               │             └─ prompt: "Organize changes into logical commits"
               │
               ├─ generateCommitMessageViaSubagent   single-commit fallback
               │
               └─ git commit for each group
```

The subagent uses `createAgentSession` from `@earendil-works/pi-coding-agent` — the same pattern as pi-goal's `runGoalCompletionAuditor`. No `pi-subagents` dependency required.

## Requirements

- [pi coding agent](https://pi.ai) 0.71+
- Node.js 18+
- Git
- `smol-toml` (installed automatically via `npm install`)

## Development

```bash
git clone <this-repo>
cd pi-committer
npm install

# Run unit tests
npm test

# Run end-to-end tests
npm run test:e2e
```

## License

MIT

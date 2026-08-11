# pi-committer

Reliable conventional commit automation for the [pi coding agent](https://pi.ai).

pi-committer captures the current repository state into an **immutable Git
snapshot** and creates conventional commits from that snapshot. Small commits
can run synchronously; larger commits can run in a detached worker without
risking later edits, concurrent commits, or concurrent staging.

## Why this version is different

The active runtime was rewritten around Git object transactions.

- Snapshot staging uses a private `GIT_INDEX_FILE`; the user's index is not
  used as scratch space.
- Background workers receive a tree SHA and base HEAD, not a mutable working
  tree diff.
- Commits are created with `git commit-tree`.
- The target ref moves with compare-and-swap `git update-ref`, so a concurrent
  commit wins instead of being overwritten.
- Index reconciliation preserves unrelated staging and newer staged versions
  of the same file.
- The worker is plain `.mjs`; it does not depend on `jiti` or Node TypeScript
  stripping.
- Worker results are journaled under `.git` before IPC, so a later session can
  recover completion after a parent/session exit.
- File grouping is deterministic. A model can write commit-message text, but
  it cannot hallucinate which files belong in a commit.

The design and its race/cancellation test contract are documented in
[`docs/reliability-overhaul.md`](docs/reliability-overhaul.md).

## Install

```bash
pi install npm:pi-committer
```

Or from a checkout:

```bash
git clone https://github.com/tmonk/pi-committer.git
cd pi-committer
npm install
pi -e ./src/index.mjs
```

## Enable it

pi-committer is opt-in for automatic triggers. Create
`.pi-committer.toml` in your project:

```toml
[committer]
enabled = true
trigger_mode = "on_goal"
```

Manual `/commit` and the `commit_changes` tool can still be used directly.

## Configuration

```toml
[committer]
enabled = true

# on_goal | agent_sensible | after_tool | manual
trigger_mode = "on_goal"

# Automatic triggers skip change sets smaller than this.
min_changes = 1

# Paths removed from the private snapshot index before the tree is written.
exclude_patterns = ["*.log", "node_modules/", "build/**"]

# Split code/tests/docs/CI/tooling into deterministic groups when useful.
staged_commits = true

# File count at which the immutable snapshot is handed to a detached worker.
# 0 disables background execution.
async_threshold = 5

# agent_with_fallback | agent | deterministic
message_mode = "agent_with_fallback"

# The default reliable mode can always produce a deterministic message when
# the SDK/model is unavailable or returns invalid text.
deterministic_fallback = true

# Optional model override.
# subagent_model = "openai/gpt-4o-mini"

# off | minimal | low | medium | high | xhigh
subagent_thinking_level = "off"

# Include a trimmed recent-conversation tail as message intent.
context_enabled = true

# Inject completion into the session when the parent session is still alive.
# Durable result journals provide recovery when it is not.
notify_async_completion = true
```

JSON config is also supported via `.pi-committer.json` with a top-level
`committer` object.

## Commands

### `/commit`

Capture the current changes and commit them.

The snapshot is taken when the command starts. If a background worker is used,
you can immediately continue editing. Later edits are not part of that commit.

### `/commit-cancel`

Request cancellation for background operations started by the current session.

Cancellation is checked before the ref transaction point. If cancellation wins,
the branch is unchanged.

### `/commit-model`

Choose a model for commit-message generation for the current session.

### `/commit-config`

Reload project configuration and recover any durable background results that
have not yet been delivered.

## `commit_changes` tool

Agents can call `commit_changes` to checkpoint work.

Optional parameters:

- `message`: intent/guidance for the generated message. It is used only where
  supported by the diff.
- `verbatim`: exact conventional commit message. It forces one commit and is
  rejected rather than rewritten if invalid.

For background commits, the tool returns immediately. The agent should
continue working instead of polling Git; completion is delivered through IPC
or recovered from the result journal.

## Background transaction model

A background operation is safe because the worker does not "come back later
and run `git add`".

At capture time pi-committer:

1. copies/initializes an alternate index;
2. stages the current worktree into that private index;
3. applies exclusions there;
4. writes an immutable Git tree;
5. records the current target ref and base HEAD;
6. records the current real-index tree.

The worker then:

1. reads diffs from immutable Git objects;
2. builds deterministic file groups;
3. generates/validates messages;
4. builds commit trees and commits from objects;
5. verifies the target ref still points at the captured base;
6. performs `git update-ref <target> <new> <expected-old>`.

If another process commits first, the compare-and-swap fails. pi-committer does
not overwrite it.

After a successful ref move, the real index is reconciled path-by-path. Newer
staged content is preserved. The replacement uses Git's `index.lock` protocol
and an exact index fingerprint check.

## Durable recovery

Worker results are written atomically to:

```text
<git-dir>/pi-committer-v2/results/<operation-id>.json
```

Cancellation requests are stored at:

```text
<git-dir>/pi-committer-v2/cancel/<operation-id>
```

If the parent session is gone when a worker completes, a later session consumes
the result journal and delivers the completion.

## Multi-repo sessions

The primary repository is the repo containing the session working directory.
pi-committer also inspects recent tool-call paths and can commit other Git
repositories touched by the agent in the same session.

Each repository has its own in-flight operation slot, so overlapping triggers
do not start multiple background workers for the same repo.

## Automatic trigger modes

| Mode | Behavior |
|---|---|
| `on_goal` | Commit when a goal-related custom entry transitions to `complete` |
| `agent_sensible` | Commit after an agent turn |
| `after_tool` | Commit after tool results |
| `manual` | Only `/commit` or `commit_changes` |

## Message generation

File membership and grouping do not come from model output.

When staged commits are enabled, files are conservatively grouped by code,
tests, docs, CI, and project tooling. The model receives one immutable diff for
one already-fixed group and can only generate its message.

`message_mode` controls generation:

- `agent_with_fallback` — try the configured/current model, then deterministic
  generation;
- `agent` — model required; invalid/unavailable output fails closed;
- `deterministic` — no model call.

## Development

```bash
npm install

# Syntax checks + v2 reliability suite
npm test

# v2 real-Git transaction/race suite only
npm run test:reliability

# Actual Pi extension entry, sync + background paths (requires the pi binary)
npm run test:e2e
```

The reliability suite covers immutable snapshots, worktree races, HEAD races,
unrelated and same-path index races, exact plan coverage, cancellation, a real
forked worker, single-result delivery, and durable journals.

GitHub Actions (manual dispatch only) runs the full test suite on the latest
supported Node release.

## License

MIT

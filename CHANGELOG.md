# Changelog

## [0.10.0] — 2026-05-26

### Fixed

- **Async worker crash with no subagent model configured:** Fixed a parameter swap bug in
  `async-commit-worker.ts` where `params.subagentThinkingLevel` (a string like `"off"`) was
  passed in the `onProgress` callback position (position #6) in both `generateCommitGroups()`
  and `generateCommitMessage()` call sites. When the SDK emitted a `message_update` or
  `message_end` event, the callback tried to invoke a string as a function, throwing `TypeError`
  and crashing the worker with "Subprocess exited with code 1". The callback and
  `subagentThinkingLevel` are now in the correct order.

### Added

- **Defensive guards on `onProgress`:** Both `generateCommitMessage` and `generateCommitGroups`
  now use `typeof onProgress === "function"` before calling the progress callback, preventing
  any future type mismatch from crashing the worker.
- **Model-availability shortcut:** Both functions check `!subagentModel` alongside the existing
  `tryLoadSDK()` guard. When no subagent model is configured (common on new installs), the
  worker skips SDK-dependent calls and falls through to deterministic commit messages
  immediately, avoiding unnecessary timeouts.
- **IPC integration tests:** 3 new tests that fork the real worker process and verify
  successful commits with deterministic fallback when no model is configured (grouped mode,
  single-commit mode, staged_commits=false mode).

## [0.9.0] — 2026-05-26

### Added

- **`subagentGroupingMinFiles` config option (default 4):** When `stagedCommits=true` and the
  number of changed files is below this threshold, the expensive subagent grouping step is
  skipped entirely. The commit still uses the subagent for the commit message, but avoids
  the ~90s grouping overhead for small change sets.
- **`subagentThinkingLevel` config option (default `"off"`):** Sets the thinking level on all
  commit subagent sessions to `"off"` by default (accepts: `off`, `minimal`, `low`, `medium`,
  `high`, `xhigh`). The pi SDK defaults to `"medium"` thinking, which generates unnecessary
  reasoning tokens for trivial commit messages.

### Fixed

- **Widget error display for failed grouped commits:** When a grouped commit's `git add` step
  failed (e.g., subagent hallucinated file names that don't exist), the worker no longer crashes
  with "Subprocess exited with code 1". The `git add` loop is wrapped in try/catch, and worker
  IPC uses a callback-based `sendResultAndExit` to avoid a race condition where `process.exit()`
  fired before IPC messages were delivered. In the sync path, grouped commit failures now set
  `progress.error` with a descriptive message instead of showing misleading "done 0 commits".

### Changed

- **Background commit notification simplified:** Removed agent-only instructions ("do not wait
  for it", "do not check git status or git log. Continue with your task") from user-facing
  notification text.

## [0.8.1] — 2026-05-26

### Added

- **Full test coverage for async widget visibility:** 12 new tests verifying the
  committer widget is shown and updated during async commits:
  - 5 widget rendering tests (committing phase, done phase with log, done phase
    with error, cancelled phase, cancelled with partial log)
  - 5 integration tests using fork mock (widget shown on start, full IPC lifecycle,
    error from IPC, error from crash, error from unexpected exit)
  - 1 e2e test (async commit with many files runs in background, verifies commits)

## [0.8.0] — 2026-05-26

### Fixed

- **IPC race condition in async commit worker:** Fixed a bug where `process.exit(N)` was called
  before queued IPC messages (`sendResult`/`sendCommit`) could be delivered to the parent
  process, causing the widget to show "✗ Subprocess exited with code 1" and "0 commits" even
  when the commit had succeeded. The worker now uses a `safeExit()` function that gives the
  event loop 100ms to flush pending IPC messages before terminating.
- **Parent-side fallback:** When the async worker exits with a non-zero code before sending a
  result IPC message, the parent now waits up to 500ms for a delayed result before showing the
  subprocess error (defense-in-depth for the IPC race).

### Added

- **`safeExit()` helper** in `async-commit-worker.ts` — replaces direct `process.exit(N)` after
  IPC sends with a pattern that yields the event loop before terminating.
- **`_getCommitterProgress()` export** in `index.ts` — exposes widget progress state for test
  assertions.
- **2 new unit tests** (126 total): IPC race fix test verifies result-before-exit scenario;
  parent fallback test verifies exit-before-result scenario.

## [0.7.0] — 2026-05-26

### Added

- **Assertive async commit response:** When an async commit is launched, the tool now returns
  "Commit running in background for N file(s). The commit completes automatically — do not
  check git status or git log. Continue with your task." — telling the agent definitively
  not to probe git.
- **Prompt guideline against git probing:** Added guideline to `commit_changes` telling the
  agent "do NOT run git commands (git status, git log, git diff) to check on the commit."

### Changed

- **Notification text aligned:** The session-level notification now reads "Commit running in
  background" with "do not wait for it" guidance instead of "Progress visible in widget".

## [0.6.0] — 2026-05-21

### Added

- **Benchmark suite:** 34 benchmark tests covering all major phases (diff, check-ignore, reset,
  add, diff stat parsing, commit, full pipeline with `stagedCommits` on/off, subagent fallback,
  group parsing) at 3 file sizes (5, 30, 100 files) with per-operation wall-clock timing and
  TAP-formatted summary output. Baseline/optimized result files stored in-repo.
- **Profiling instrumentation:** `_getLastSubagentCallMs()` and `_getLastGroupGenCallMs()` timing
  hooks record real wall-clock duration of subagent message generation and group generation calls
  during actual usage.

### Changed

- **`filterGitignoredFiles`** — batched `git check-ignore --stdin` using a single `execSync` call
  with all paths piped via stdin, replacing `O(n)` per-file `git check-ignore -q` calls.
  **Speedup: ~167×** (2505ms → 15ms for 100 files).
- **`unstageExcludedFiles`** — single `git reset HEAD -- <file1> <file2> ...` call with all
  excluded files, replacing `O(n)` per-file `git reset HEAD` calls, with per-file fallback
  on failure. Applied to both `index.ts` and `async-commit-worker.ts`. **Speedup: ~5×**.
- **`getDiffContent`** — fast path via `execSync` pipe with 10MB `maxBuffer`, replacing
  temp-dir + `--output=<file>` I/O for the common case. Falls back to temp-dir only on
  `ENOBUFS`. Applied to both `index.ts` and `async-commit-worker.ts`.
- **`asyncThreshold` default lowered from 10 to 5** — benchmark-informed decision: at 5 files,
  the optimized pipeline completes in ~90ms vs ~140ms baseline, making async subprocess overhead
  worthwhile at this threshold.

## [0.5.0] — 2026-05-20

### Added

- **Async (background subprocess) commits:** When the number of changed files reaches a
  configurable threshold (`async_threshold`, default 10), `/commit` and `commit_changes`
  now fork the full commit pipeline into a detached child process and return immediately.
  The conversation can continue while the commit runs in the background. A progress widget
  shows real-time status (preparing → analyzing → committing → done). Pressing Esc sends
  SIGTERM to the subprocess and cleans up. The worker has a 5-minute timeout safeguard.

### Changed

- **Bumped version to 0.5.0** — minor release with async commit support.

## [0.4.0] — 2026-05-20

### Fixed

- **ENOBUFS (pipe buffer overflow) on large git diffs:** Replaced pipe-based `execSync` capture
  of `git diff --cached` with file-based `--output=<file>` via a new `getDiffContent()` helper.
  The file-based approach writes the diff directly to a temp file, bypassing the OS pipe buffer
  entirely. This fixes `spawnSync /bin/sh ENOBUFS` errors on macOS when committing repos with
  very large working trees (e.g. monorepos with thousands of changes).
- **Missing `maxBuffer` on git commands:** Added `maxBuffer: 10MB` to all `git diff --cached --stat`
  (3 call sites) and `git status --porcelain` (2 call sites) calls to prevent Node.js buffer
  overflow on large outputs.

### Changed

- **Bumped version to 0.4.0** — minor release with the ENOBUFS fix.

## [0.3.0] — 2026-05-20

### Changed

- **Default `defer_to_goal_audit` is now `false`** (was `true`). `commit_changes` always proceeds
  immediately unless the user explicitly opts in to deferral with `defer_to_goal_audit = true`.
  This fixes a common scenario where the session cwd differs from the project root, causing
  the config file to be missed and `config.deferToGoalAudit` to silently stay at the old default
  of `true`.

### Fixed

- **Defer-to-goal-audit bypass:** Refactored defer check into `shouldDeferToGoalAudit()` function.
  The `commit_changes` tool now correctly honours `defer_to_goal_audit = false` in
  `.pi-committer.toml` — when set to `false`, commits proceed immediately even with an active
  pi-goal goal instead of deferring.
- **Duplicate `try {`:** Fixed syntax artifact in `hasActiveGoal()`.

### Added

- **shouldDeferToGoalAudit(cfg, ctx):** New exported function encapsulating the defer decision
  logic for testability and clarity.
- **Comprehensive defer-logic tests:** 11 new unit tests (107 total) covering every combination
  of `deferToGoalAudit`, trigger mode, goal presence, and goal status, including config file
  round-trips, syntax-error fallbacks, and boolean-string edge cases.
- **`.pi-committer.toml` in pystata-x:** Created project config with `defer_to_goal_audit = false`.

## [0.2.1] — 2026-05-19

### Fixed

- **Gitignore crash:** `git add -- "<file>"` no longer crashes when a changed file matches `.gitignore`. Gitignored files are detected via `git check-ignore -q` and silently skipped before the `git add` call.
- **README typo:** Corrected `completed` → `complete` in trigger mode documentation.

### Added

- **`filterGitignoredFiles(dir, files)`:** New exported function that returns only non-gitignored files from a list, using `git check-ignore -q`.
- **Graceful handling of all-gitignored groups:** Commit groups where every file is gitignored are silently skipped. If all files across all groups are gitignored, the flow returns 0 commits with an informational message.

### Testing

- **21 new unit tests** (96 total, all passing): comprehensive coverage for `filterGitignoredFiles`, `stageAll`, `isDirtyRepo`, and gitignore commit integration (including mid-flow `.gitignore` changes, nested `.gitignore`, and all-ignored edge cases).
- **3 new E2E tests** covering mixed gitignored/non-gitignored files, all-files-gitignored (no crash), and nested `.gitignore` scenarios.

## [0.2.0] — 2026-05-19

### Added

- Subagent-based commit message generation with `pi-subagents`.
- Deterministic commit message fallback for headless/offline environments.
- Auto-commit on goal completion via `pi-goal` lifecycle hooks.
- Abort/cancellation support in the commit workflow.
- Flexible commit grouping via `.pi-committer.toml` or `.pi-committer.json` config.
- Exclusion patterns (`exclude_patterns`) to skip unwanted files.
- Config loading with directory-walking discovery.
- Comprehensive unit and E2E test suite.

[0.5.0]: https://github.com/tmonk/pi-committer/releases/tag/v0.5.0
[0.4.0]: https://github.com/tmonk/pi-committer/releases/tag/v0.4.0
[0.3.0]: https://github.com/tmonk/pi-committer/releases/tag/v0.3.0
[0.2.1]: https://github.com/tmonk/pi-committer/releases/tag/v0.2.1
[0.2.0]: https://github.com/tmonk/pi-committer/releases/tag/v0.2.0

# Changelog

## [0.12.6] — 2026-06-07

### Added

- **`subagentMessageMinFiles` config option (default 3):** Decouples the commit-message
  subagent call from the grouping subagent call. When the number of changed files is
  below this threshold (1-2 files), the subagent is skipped entirely and the fully
  deterministic fallback is used — no LLM call at all. For 3-14 files, a single commit
  is made with a subagent-generated message but without grouping. At 15+ files, both
  grouping and message subagent are used. Configurable via TOML key
  `subagent_message_min_files`.
- **SDK extension runtime caching:** `createExtensionRuntime()` is now called once and
  cached across all subagent sessions (`getCachedRuntime()`), avoiding redundant
  runtime creation on every subagent call.

### Changed

- **`subagentGroupingMinFiles` default raised from 4 to 15:** Empirically determined
  via the expanded benchmark suite. Benchmark data shows non-subagent overhead is
  ~100-200ms regardless of file count, while a grouping subagent call costs ~35s.
  Most routine commits (< 15 files) now skip the grouping subagent entirely.
- **`commitStaged` and `doSingleCommit` accept pre-computed diff stat/content:**
  Pre-computed `git diff --cached --stat` and `diffContent` are passed from the
  caller (`tryCommit`), avoiding redundant `execSync` calls.
- **Async commit worker mirrored:** Both `subagentGroupingMinFiles` and
  `subagentMessageMinFiles` are passed through `CommitWorkerParams`. The worker's
  widget phase, skipSubagent logic, and progress tracking all match the sync path.

### Performance

- **1-2 files: ~269× faster** (~35s subagent → ~130ms deterministic).
- **3-14 files: ~2× faster** (subagent called once instead of twice).
- **Full pipeline at scale: ~8.5× faster** from batch git operations.

## [0.12.5] — 2026-06-06

### Changed

- **`skipSubagent` logic now gates on file count:** The commit-message subagent is
  skipped entirely when the file count is below `subagentMessageMinFiles` (default 3).
  For 1-2 file changes, the fully deterministic fallback is used — no model call.
- **Widget phase string corrected:** The widget now displays "committing" instead of
  "analyzing" when the subagent message phase is active but grouping is skipped.
- **README updated:** Documented `subagent_message_min_files` and updated default
  of `subagent_grouping_min_files` from 4 to 15.

## [0.12.4] — 2026-06-05

### Added

- **Diagnostics at every subagent fallback decision point:** 12 DIAG points across
  both `index.ts` (5 points) and `async-commit-worker.ts` (7 points) log the exact
  reason when the subagent is skipped or falls through — SDK load failure, empty
  SDK result, model unavailable, threshold gate, or grouping produces no groups.
  Diagnostics use `ctx.ui.notify` (sync path) or `console.error` with IPC progress
  (async worker) and never crash.
- **Smart deterministic scope via `findCommonAncestor()`:** When all changed files
  share a common directory ancestor, the commit scope is set to that ancestor.
  When files span unrelated directory trees, no scope is emitted at all.
- **Smart deterministic description via `summarizeChanges()`:** Extracts meaningful
  keywords from file names (strips extensions, skips boilerplate like `__init__`,
  `conftest`), converts snake_case to readable words, caps at 6 terms, and appends
  "and tests" when test files are present. No token-expensive diff analysis.
- **Commit body format:** Description summary line followed by a blank line, then
  a full file list with change stats — replaces the old `"Changes:"`-only body.

### Changed

- **Subagent prompts tightened** in all 4 locations (sync single-commit + grouping,
  async single-commit + grouping):
  - "NEVER comma-join multiple scopes" — stops the subagent from producing
    `chore(experiments/exposure,experiments/exposure/src,...)`.
  - "be specific: 'add regression pipeline and tests', not 'update 27 modules'".
  - "max 72 chars" enforced in prompt.
  - Body format rules: "First line is the description. Then a blank line. Then the
    full file list (one per line)."
- **SDK loading hardened in async worker:** `tryLoadSDK()` now attempts ESM dynamic
  `import()` first, then CJS `require()` as fallback — addresses the case where
  dynamic import fails in forked/jiti child processes.
- **Smart scope replaces comma-joined directories:** The old behavior concatenated
  all changed directories with commas; now `findCommonAncestor()` produces clean
  scopes like `experiments/exposure` instead of
  `experiments/exposure,experiments/exposure/src,.../exposure/tests`.
- **Smart description replaces "update N modules":** The old fallback always said
  "update N modules"; now `summarizeChanges()` produces descriptions like
  "add regression pipeline and tests" from file-name keywords.

### Performance

- Deterministic fallback is still O(1) — no LLM calls, just string analysis.
  `findCommonAncestor()` and `summarizeChanges()` operate in a single pass over
  the file list with negligible overhead.

## [0.12.3] — 2026-05-31

### Changed

- **Unstageable file warnings routed to tool result instead of notification popups:**
  Per-file `ctx.ui.notify()` calls in `batchStageFilesForGroup` callbacks are replaced with
  a single concise summary notification after all groups are processed
  (e.g. "3 file(s) could not be staged"). The individual warnings still
  flow into `details.warnings` for the agent to see in the tool result — the fix removes
  only the visually disruptive per-file floating popups.

### Added

- **Summary notification for unstageable files:** One `ctx.ui.notify()` fires at the end of
  group processing if any files were unstageable ("X file(s) could not be staged") or if
  entire groups were skipped ("Y group(s) skipped (all files unstageable)").
- **Integration tests for warning routing:** 3 tests verify `batchStageFilesForGroup` collects
  warnings via callbacks without calling `ctx.ui.notify()`.

## [0.12.2] — 2026-05-30

### Changed

- **Batch staging pipeline optimized:** `batchStageFilesForGroup` in both `index.ts` and
  `async-commit-worker.ts` now uses batch size 5000 (10× the previous 500), reducing
  subprocess calls from 20 to 2-3 for repos with ~10k changed files. The pre-classify
  (`existsSync`) + `git rm --cached` split was evaluated but the simpler approach of
  just using `git add --ignore-errors` (which natively handles deleted tracked files)
  with a larger batch proved both faster and cleaner.
- **`doSingleCommit` in async-commit-worker.ts** also uses batch size 5000.

### Performance

- **1k staging loop:** 81ms → 19ms (**4.3× faster**)
- **10k full pipeline:** 693ms → 142ms (**4.9× faster**)
- **10k staging loop:** ~360ms → ~57ms (**6.3× faster**)
- **Total vs original per-file baseline:** **814× speedup** (15.5s → 19ms at 1k files)

## [0.12.1] — 2026-05-28

### Added

- **Warning summary for unstageable files in `commit_changes` tool response:**
  When files fail to stage during a commit (e.g. matching `.gitignore`, permission errors,
  or subagent-hallucinated paths), warnings are now collected and surfaced in the IPC
  response text the agent sees after the tool runs — not just in the ephemeral widget.
  The format is: `Skipped N unstageable file(s) (file1, file2, ...)` with optional
  `; N group(s) entirely skipped`. Works in both sync and async commit paths.
  (dedicated by file path).

### Fixed

- **Async worker crash on error paths:** A `let` variable declared inside a `try` block
  was inaccessible in the corresponding `catch` block due to block scoping, causing a
  `ReferenceError` that silently killed the worker process without sending an IPC result
  message. Moved the warnings variable outside the `try` block.
- **`unstageExcludedFiles` defensive guards:** Handles `undefined` `files` and
  `excludePatterns` parameters without crashing.

## [0.12.0] — 2026-05-27

### Fixed

- **Worker crash under node_modules (ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING):**
  Node.js 22's built-in `--experimental-strip-types` refuses to process `.ts` files
  under `node_modules`, causing the async commit worker to exit with code 1 immediately.
  The fix detects when the worker path is under `node_modules` and switches to jiti's ESM
  loader (`--import jiti/lib/jiti-register.mjs`) instead, which has no such restriction.
  The `resolveWorkerExecArgv(workerPath?)` helper encapsulates the decision logic.

### Added

- **Full test coverage for the node_modules fix:**
  - 7 unit tests for `resolveWorkerExecArgv`/`_findJitiRegisterForPath` covering all path
    resolution strategies and edge cases.
  - 4 crash-scenario integration tests reproducing the original `ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING`
    error, verifying jiti succeeds where strip-types fails, and a regression guard.
  - 1 E2E test creating a temp `node_modules` structure with the real worker symlinked in,
    forking with jiti execArgv, and verifying the worker loads and responds.
  - 4 performance benchmarks confirming sub-millisecond overhead for both code paths.

### Changed

- **`forkWorker()` in test infrastructure** now uses `resolveWorkerExecArgv(workerPath)`
  instead of hardcoded `["--experimental-strip-types"]`, matching the production fix.

## [0.11.0] — 2026-05-27

### Fixed

### Fixed

- **Worker always exits with code 0:** Removed the last two `exit code 1` paths in
  `async-commit-worker.ts`. The worker timeout (5-minute watchdog) now calls
  `sendResultAndExit(..., 0)` instead of bare `process.exit(1)`, and the main handler's
  catch block uses exit code 0. All errors (timeout, commit failure, cancellation, worker crash)
  are communicated exclusively through the IPC result message's `error` field, never via the
  process exit code. This eliminates the IPC race where the parent could see
  "Subprocess exited with code 1" before the IPC result message arrived.

### Added

- **Exported worker functions for direct unit testing:** All pure git helpers (`git`, `gitCwd`,
  `getHeadHash`, `unstageAll`, `getDiffContent`, `getChangedFiles`, `isGitignored`,
  `filterGitignoredFiles`, `unstageExcludedFiles`), commit message generators
  (`deterministicCommitMessage`, `parseCommitGroups`), IPC helpers (`sendResultAndExit`), and
  the main commit pipeline functions (`doSingleCommit`, `doGroupedCommits`) are now exported
  from `async-commit-worker.ts`. The pipeline functions accept an optional `ipc` parameter with
  `onProgress` and `onCommit` callbacks, making them testable without a forked IPC environment.
- **40 new comprehensive edge-case tests** in `tests/worker-edge.test.ts` covering:
  - Worker exported git helper functions
  - Deterministic commit message generation
  - Parse commit groups (including hallucinated file filtering)
  - `sendResultAndExit` IPC message delivery
  - Abort/cancel at multiple checkpoints (SIGTERM timing races)
  - Git failure modes (pre-commit hook rejection, empty diffs, missing files, minChanges filter)
  - IPC result guarantees (always exit 0, result message structure, commit log field validation)
  - Large diff handling (getDiffContent with file fallback)
  - Binary file pattern handling (filterGitignoredFiles, unstageExcludedFiles)
  - Widget phase transitions (analyzing, done with error, idle as empty)
  - Exclude pattern glob matching (prefix, suffix, wildcard)

### Changed

- `npm test` now runs both `tests/unit.test.ts` and `tests/worker-edge.test.ts`.

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

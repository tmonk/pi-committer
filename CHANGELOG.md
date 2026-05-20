# Changelog

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

[0.4.0]: https://github.com/tmonk/pi-committer/releases/tag/v0.4.0
[0.3.0]: https://github.com/tmonk/pi-committer/releases/tag/v0.3.0
[0.2.1]: https://github.com/tmonk/pi-committer/releases/tag/v0.2.1
[0.2.0]: https://github.com/tmonk/pi-committer/releases/tag/v0.2.0

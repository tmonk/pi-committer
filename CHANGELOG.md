# Changelog

## [0.3.0] — 2026-05-20

### Fixed

- **Defer-to-goal-audit bypass:** Refactored defer check into `shouldDeferToGoalAudit()` function. The `commit_changes` tool now correctly honours `defer_to_goal_audit = false` in `.pi-committer.toml` — when set to `false`, commits proceed immediately even with an active pi-goal goal instead of deferring.
- **Duplicate `try {`:** Fixed syntax artifact in `hasActiveGoal()`.

### Added

- **shouldDeferToGoalAudit(cfg, ctx):** New exported function encapsulating the defer decision logic for testability and clarity.
- **Comprehensive defer-logic tests:** 11 new unit tests (107 total) covering every combination of `deferToGoalAudit`, trigger mode, goal presence, and goal status, including config file round-trips, syntax-error fallbacks, and boolean-string edge cases.
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

[0.3.0]: https://github.com/tmonk/pi-committer/releases/tag/v0.3.0
[0.2.1]: https://github.com/tmonk/pi-committer/releases/tag/v0.2.1
[0.2.0]: https://github.com/tmonk/pi-committer/releases/tag/v0.2.0

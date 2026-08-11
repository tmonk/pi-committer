# Reliability overhaul

This development branch replaces the previous commit pipeline with a transaction-oriented architecture. The goal is not incremental mitigation; the new runtime is intended to remove the classes of race, worker, and staging failures that made the extension flaky.

## Implemented architecture

### Immutable snapshot capture

Every operation starts by creating a private alternate Git index with `GIT_INDEX_FILE`. The current worktree is staged into that private index only, exclusions are applied there, and `git write-tree` produces an immutable snapshot tree. The user's real index is never used as scratch space.

The snapshot records the repository root, target ref, base HEAD, snapshot tree, original real-index tree, exact changed files, excluded files, operation id, and durable journal paths.

### Race-safe commit transaction

Commit groups are materialized from Git objects with `git commit-tree`; the worker does not run `git add` after capture. Before the branch is moved, the runtime verifies that HEAD still targets the same ref and commit. The branch update uses compare-and-swap `git update-ref <target> <new> <expected-old>`. A concurrent commit therefore wins and pi-committer refuses to overwrite it.

### Concurrent index preservation

After a successful ref move, index reconciliation starts from the current real index, compares captured-path entries with the original index tree, and updates only paths that were not staged concurrently. New unrelated staging and newer staged versions of the same path are preserved. Installation follows Git's `index.lock` protocol and verifies an exact SHA-256 fingerprint before replacing the index.

### Background worker redesign

The active worker is plain `.mjs`; it does not rely on `jiti`, TypeScript stripping, or duplicated legacy pipeline code. It receives the immutable snapshot, fixed configuration, serializable model metadata, context, and commit-message request.

The worker is allowed to outlive the parent session because it cannot absorb later worktree edits. It journals one durable result under `.git/pi-committer-v2/results/<operation>.json` before IPC completion. A later session recovers journals if the parent exited first.

Cancellation requests are journaled under `.git/pi-committer-v2/cancel/<operation>`. Cancellation is checked before the ref transaction point. After the ref move, the commit is considered complete; cleanup is best-effort.

### Deterministic grouping

The model no longer decides file membership. Files are grouped deterministically into conservative code, test, docs, CI, and tooling groups. The model can generate text for an already-fixed immutable group only. Plan validation rejects unknown files, duplicates, and omissions.

### Message generation

Three modes are supported: `agent_with_fallback`, `agent`, and `deterministic`. Agent output is validated as a conventional commit and may be retried once. The default reliable mode falls back to deterministic content-derived messages when the SDK/model is unavailable or invalid.

### Operation-scoped runtime state

The extension tracks at most one in-flight background operation per repository and refuses overlapping triggers for that repository. Session shutdown deliberately does not kill detached workers. Completion can arrive through IPC or later journal recovery.

## Correctness gates implemented before background mode is considered valid

Background commits are part of the implemented architecture only because the following tests exist and pass:

1. Snapshot capture does not mutate the real index.
2. Edits made after capture are not included in the commit.
3. A concurrent commit causes a HEAD/ref race failure instead of being overwritten.
4. Unrelated concurrent staging survives reconciliation.
5. Newer staged content for the same path survives reconciliation.
6. Commit plans cannot invent, duplicate, or omit snapshot files.
7. Cancellation before the transaction point leaves HEAD unchanged.
8. A real forked worker emits exactly one result.
9. Worker results are durably journaled.
10. Deterministic grouping covers every snapshot path exactly once.
11. Exclusion globs are applied to the private index, including nested basename matches.
12. The actual Pi extension entry is covered by sync and background E2E tests.

## CI

GitHub Actions runs syntax checks and the reliability suite on Node 20, 22, and 24. A regression job also runs the TypeScript typecheck and historical unit/worker-edge tests on Node 22 and 24.

## Migration decision

Because this repository is under development rather than a live migration, the package entry is switched directly from the legacy root `index.ts` to `src/index.mjs`. The legacy files remain temporarily as regression fixtures for the existing historical tests, but they are not loaded by Pi.

## Follow-up criteria

Future work should simplify or delete legacy fixtures after equivalent coverage has moved to the new runtime. Any change to snapshot capture, ref movement, reconciliation, cancellation, or worker lifecycle must add or update a race test before merge. Performance optimizations are subordinate to the transaction invariants above.

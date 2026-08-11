# pi-committer reliability overhaul plan

Status: **proposed**  
Scope: architecture, execution model, reliability, tests, observability, and migration  
Primary goal: make commits boring, deterministic, recoverable, and easy to diagnose.

## Executive summary

pi-committer has accumulated a broad feature set quickly, but the failure history shows that reliability problems are architectural rather than isolated bugs. Recent releases have had to fix worker loader failures, IPC result races, session-shutdown races, stale widget timers, positional-argument corruption, and a dirty-repository check that silently returned false. The implementation now carries the same commit logic in both `index.ts` and `async-commit-worker.ts`, substantial mutable module-level state, runtime TypeScript loader branching, detached-process lifecycle handling, UI lifecycle handling, git staging state, model execution, multi-repository discovery, and commit grouping in one extension.

The overhaul should simplify first, then rebuild capabilities on reliable boundaries:

1. **Temporarily remove background/detached commits from the normal path.** A commit operation mutates the git index and should not outlive the session that initiated it until the extension has an immutable work snapshot and an explicit transaction protocol.
2. **Create one shared commit engine.** The synchronous path and any future worker path must call the same implementation rather than maintain mirrored copies of validation, staging, grouping, fallback, and commit logic.
3. **Replace module-level operation state with explicit operation objects.** Every commit gets an operation ID, cancellation signal, repository snapshot, warnings, progress, result, and cleanup ownership.
4. **Make git access a typed adapter using argument arrays.** Remove shell-built commands and centralize error classification, timeouts, output limits, and logging.
5. **Separate planning from mutation.** Build and validate a `CommitPlan` before changing the index; then execute the plan with precondition checks and deterministic cleanup.
6. **Make correctness independent of the LLM.** Message generation can fail without corrupting staging state or producing misleading outcomes. The user should always receive a typed, actionable result.
7. **Replace timing-based confidence with layered deterministic tests and CI.** The default test suite should exercise real git repositories without real models; optional live-model E2E tests should be quarantined from correctness gates.

The target is not merely “fewer flakes.” The target is a system where every failure has a bounded blast radius, a stable error code, preserved user changes, and a reproducible test.

---

## 1. Why an overhaul is warranted

### 1.1 Failure history indicates systemic coupling

The changelog and recent fixes reveal recurring classes of failures:

- async worker startup failing under installed `node_modules` layouts because native TypeScript stripping is unsupported there;
- missing/incorrect worker loader assumptions;
- worker IPC result messages racing process exit;
- the parent handling `exit`, `error`, delayed `message`, widget updates, and completion notification as overlapping terminal paths;
- session shutdown and delayed UI cleanup racing detached workers and stale extension contexts;
- positional arguments binding a request object to a boolean, changing commit-message fallback behavior;
- a nonexistent Node built-in import causing the asynchronous dirty-repo check to silently report repositories as clean;
- multiple rounds of fixes specifically aimed at making tests deterministic under timers and subprocess timing.

These are symptoms of too many lifecycle domains crossing the same functions: pi session state, TUI state, child-process state, git state, model state, and timers.

### 1.2 The implementation has two commit engines

`index.ts` and `async-commit-worker.ts` both implement substantial portions of:

- git helpers;
- diff validation and parsing;
- exclusion handling;
- commit-message validation;
- deterministic message generation;
- grouping logic;
- staging and committing;
- warning accumulation;
- subagent invocation behavior.

Mirrored logic makes parity a permanent maintenance burden. A fix can land in one execution path and not the other, and tests must prove equivalence after every change.

### 1.3 Global mutable state obscures operation ownership

The extension currently tracks operation behavior through module-level variables for configuration, worker process, warnings, UI progress, timers, abort controllers, selected models, completion delivery, goal scan offsets, commit messages, and caches. Even when individually guarded, this makes it difficult to answer basic lifecycle questions:

- Which commit operation owns this timer?
- Can a late worker result update a newer operation?
- Does session reload invalidate this callback?
- Which operation populated this warning list?
- What should cancellation restore?

The stale-widget fixes are an example of compensating for missing operation ownership after the fact.

### 1.4 The async model is unsafe for mutable git state

The current background flow prepares/stages data in the parent, then launches a detached process that may continue after the initiating pi session exits. Meanwhile the user or agent may continue modifying the same repository. That creates an inherent race between:

- the diff the worker was told about;
- the live git index and worktree when it later stages/commits;
- further edits performed after the background job starts.

Even perfect IPC cannot make this model deterministic without an immutable snapshot, lock, or worktree/index transaction protocol.

---

## 2. Reliability principles

The redesign should be judged against these rules.

### 2.1 Never lose or silently alter user work

On failure or cancellation:

- never delete worktree changes;
- never leave an undocumented index mutation;
- never claim success without verifying the resulting commit;
- never report “nothing to commit” when the actual cause is an internal error;
- never substitute a generic commit message when policy says generation must block.

### 2.2 One operation, one owner

All mutable state required by a commit attempt belongs to a single `CommitOperation`. No timer, child process, UI handler, warning list, or terminal callback should exist without an operation ID and cleanup owner.

### 2.3 One implementation of each rule

There should be exactly one implementation of:

- diff parsing;
- exclusion matching;
- message validation;
- commit-plan validation;
- staging execution;
- deterministic fallback;
- commit result formatting.

Different transports may call the engine, but they must not copy it.

### 2.4 Mutation follows validation

The extension should inspect the repository and build a plan before mutating the index. The plan should contain enough information to explain exactly what will happen.

### 2.5 External systems fail explicitly

Git, the model provider, pi APIs, the filesystem, child processes, and hooks all fail differently. Convert failures into typed domain errors rather than swallowing exceptions and returning false/empty values.

### 2.6 Correctness tests use deterministic dependencies

A real LLM is not a correctness oracle. Core behavior must be testable using fixed model responses and real temporary git repositories.

---

## 3. Target architecture

Refactor toward small modules with explicit boundaries. The exact names can change, but the dependency direction should remain stable.

```text
index.ts                    Pi extension adapter only
  |
  +-- runtime/session-controller.ts
  |     owns current session + operation registry
  |
  +-- commit/commit-service.ts
        orchestrates inspect -> plan -> execute -> report
        |
        +-- commit/repository-inspector.ts
        +-- commit/commit-planner.ts
        +-- commit/commit-executor.ts
        +-- commit/message-service.ts
        +-- commit/grouping-service.ts
        +-- git/git-client.ts
        +-- domain/*.ts

widget.ts                   presentation only
config.ts                   parse + validate config only
```

### 3.1 `index.ts`: thin extension adapter

`index.ts` should register commands, tools, and pi events, then delegate. It should not contain git shell calls, message parsing, worker management, grouping algorithms, or substantial business rules.

Target responsibilities:

- load/reload configuration;
- translate pi events into service calls;
- expose tool/command responses;
- connect progress events to the widget;
- own session creation/shutdown wiring.

A useful target is to reduce `index.ts` from a monolithic implementation to a few hundred lines of integration code.

### 3.2 Domain types

Introduce discriminated unions instead of integer/sentinel results such as `-1`, `0`, and positive commit counts.

Example:

```ts
type CommitResult =
  | { kind: "committed"; commits: CommitRecord[]; warnings: CommitWarning[] }
  | { kind: "no_changes" }
  | { kind: "excluded"; files: string[] }
  | { kind: "blocked"; reason: BlockReason; warnings: CommitWarning[] }
  | { kind: "cancelled" }
  | { kind: "failed"; error: CommitError; warnings: CommitWarning[] };
```

Likewise define typed `CommitError` codes such as:

- `NOT_A_REPOSITORY`
- `GIT_STATUS_FAILED`
- `STAGE_FAILED`
- `INDEX_CHANGED`
- `MESSAGE_GENERATION_FAILED`
- `MESSAGE_INVALID`
- `HOOK_REJECTED`
- `COMMIT_FAILED`
- `MODEL_UNAVAILABLE`
- `CANCELLED`

This prevents unrelated failure modes from collapsing into “false,” empty output, or “nothing to commit.”

### 3.3 `CommitOperation`

Every invocation creates an operation-scoped object:

```ts
interface CommitOperation {
  id: string;
  startedAt: number;
  trigger: CommitTrigger;
  request: CommitRequest;
  config: Readonly<CommitterConfig>;
  abortController: AbortController;
  repositories: RepositorySnapshot[];
  warnings: CommitWarning[];
  progress: OperationProgress;
}
```

The session controller maintains at most the operations that are actually allowed concurrently. For the first reliable version, enforce **one mutating commit operation per repository**.

No operation should read mutable global config after it begins; snapshot configuration at operation start.

---

## 4. Phase 0: establish a safety baseline

Do this before large refactors.

### 4.1 Add CI immediately

Add GitHub Actions for at least:

- Node 22 LTS and the current supported Node release;
- Linux and macOS where feasible;
- `npm ci`;
- `npm run typecheck`;
- deterministic unit/integration tests;
- package/install smoke test.

Windows should be added once shell-built git commands are removed. The current use of command strings makes cross-platform confidence weaker than it should be.

### 4.2 Record reliability fixtures

Convert each historical production failure into a named regression fixture/test with a short comment linking it to the failure class. Required fixtures include:

- installed-under-`node_modules` worker loading;
- exit-before-IPC-result;
- late result after UI/session teardown;
- cancellation during model generation;
- cancellation during grouped staging;
- invalid generated message with deterministic fallback off;
- dirty multi-repo detection;
- pre-commit hook rejection;
- ignored and excluded files;
- large diffs;
- filenames containing spaces, quotes, glob characters, Unicode, and leading dashes;
- unborn repositories with no initial commit;
- repository changed between inspection and execution.

### 4.3 Freeze behavior with characterization tests

Before moving functions, write tests around observable tool outcomes, staged state, commit history, and warnings. Avoid tests that merely assert private helper implementation details.

---

## 5. Phase 1: remove background commits from the critical path

This is the highest-leverage reliability change.

### 5.1 Disable async by default, then deprecate the current worker

Change the default `async_threshold` to `0` in the first overhaul release. Keep the old setting temporarily for compatibility, but emit a deprecation warning if enabled.

The preferred next step is to remove the detached TypeScript worker entirely until a safe background design exists.

Reasons:

- it duplicates the engine;
- it requires special TypeScript-loader behavior under `node_modules`;
- it adds child-process + IPC + timeout + exit ordering states;
- it can outlive the session that owns its UI and API context;
- most importantly, it works against a mutable repository that can continue changing while the worker runs.

### 5.2 Keep the interaction responsive without background mutation

If model generation is slow, keep the user informed through progress UI while the operation remains attached to the session. The operation should be cancellable, but the git mutation should occur only after message/group generation has completed and the repository preconditions are revalidated.

### 5.3 Criteria for reintroducing background execution

Background commits should return only after one of these designs is implemented:

**Option A — temporary worktree snapshot:**

- create a temporary worktree at the current HEAD;
- copy/apply the intended diff into that worktree;
- generate and create commits there;
- before updating the real branch, verify the original repository still matches the captured preconditions;
- fast-forward/cherry-pick only if safe.

**Option B — isolated temporary index:**

- use `GIT_INDEX_FILE` with a temporary index;
- build commits using plumbing commands against the captured tree;
- update the branch ref only after a compare-and-swap check on expected HEAD/index/worktree state.

Either design requires tests proving that edits made after background start are never accidentally included, overwritten, staged, or omitted.

---

## 6. Phase 2: build a safe git adapter

### 6.1 Stop constructing shell command strings

Centralize git calls around `execFile`/`spawn` with argument arrays:

```ts
await git.run(["diff", "--cached", "--", file]);
await git.run(["reset", "HEAD", "--", ...files]);
```

Do not use commands such as `execSync(`git reset HEAD -- ${paths}`)` or embed quoted filenames into shell strings.

Benefits:

- correct handling of spaces, quotes, newlines, `$`, backticks, semicolons, and glob characters;
- improved Windows portability;
- clearer logging;
- easier timeout/cancellation handling;
- no shell interpretation layer.

### 6.2 Prefer NUL-delimited git formats

For machine-readable file lists use `-z` formats wherever possible:

- `git status --porcelain=v1 -z` or porcelain v2;
- `git diff --name-status -z`;
- `git check-ignore -z --stdin` where applicable.

Avoid parsing human-oriented `--stat` output as a source of filenames. Rename syntax, unusual filenames, and localization are unnecessary hazards.

### 6.3 Return typed command failures

`GitClient` should capture:

- argv;
- cwd;
- exit code/signal;
- bounded stdout/stderr;
- timeout/cancellation state;
- duration;
- whether the failure appears to be a hook rejection or repository error.

Do not swallow failures in helpers like `isDirtyRepoAsync` and convert them to “clean.” The caller should decide whether an error is recoverable.

### 6.4 Define timeout policy

Use bounded timeouts for read-only git commands. `git commit` may legitimately run hooks, so give it a separate configurable timeout and surface hook output when it fails.

---

## 7. Phase 3: separate inspect, plan, and execute

### 7.1 Inspect without staging

The extension should first capture a `RepositorySnapshot` without mutating the index:

```ts
interface RepositorySnapshot {
  root: string;
  head: string | null;
  branch: string | null;
  status: StatusEntry[];
  indexTree: string;
  candidateFiles: CandidateFile[];
  capturedAt: number;
}
```

Respect the user's pre-existing staged changes. Do not assume the extension owns the entire index.

### 7.2 Decide and document staged-change policy

The current “stage all” model is risky when the user has intentionally staged only part of their work. Pick an explicit policy:

Recommended default:

- preserve pre-existing staged entries;
- determine which unstaged/untracked changes pi-committer is allowed to add;
- never reset unrelated user-staged entries;
- if safe isolation cannot be guaranteed, block with an explanation instead of rewriting the index.

Add a config option only if there is a real use case for “take ownership of the full index.” Do not make destructive index normalization implicit.

### 7.3 Build a `CommitPlan`

Message generation and grouping should produce a plan, not execute git mutations:

```ts
interface CommitPlan {
  repository: RepositoryIdentity;
  expectedHead: string | null;
  expectedIndexTree: string;
  groups: CommitGroupPlan[];
  excludedFiles: string[];
  generator: "verbatim" | "model" | "deterministic";
}

interface CommitGroupPlan {
  files: string[];
  message: string;
}
```

Validate the complete plan before execution:

- every file belongs to the captured candidate set;
- no file appears in multiple groups unless explicitly allowed;
- no path escapes the repository;
- all generated messages pass validation;
- all configured types/scopes are actually enforced;
- empty groups are rejected;
- exclusions remain excluded.

### 7.4 Revalidate before mutation

Immediately before execution, compare:

- HEAD;
- index tree;
- relevant status entries.

If the repository changed since inspection, return `INDEX_CHANGED` / `WORKTREE_CHANGED` and ask for a retry. Do not silently commit a different state than the one the plan described.

### 7.5 Execute with deterministic cleanup

The executor should own every index mutation it performs and record enough state to restore it on failure.

At minimum:

1. capture pre-operation index tree/state;
2. stage exactly the first group;
3. verify staged file set equals the plan;
4. commit;
5. repeat;
6. restore/preserve non-plan staged state;
7. verify resulting HEAD and repository status;
8. return typed records.

If one group fails, stop by default. Continuing after an unknown hook/staging failure can create partial histories that are difficult to reason about.

---

## 8. Phase 4: unify message generation

### 8.1 One `MessageService`

The sync path, future worker, tests, and grouping path should use the same functions and option objects.

Eliminate long positional signatures entirely. Use object parameters for all service methods:

```ts
messageService.generate({
  diff,
  files,
  repoStyle,
  sessionContext,
  userRequest,
  fallbackPolicy,
  signal,
});
```

This directly prevents the class of bug where a request object is accidentally bound to a boolean.

### 8.2 Enforce all config in one place

Audit configuration fields and ensure they are either used or removed. In particular, `custom_types`, `allowed_scopes`, and `detailed_body` should not be accepted/documented without authoritative enforcement in generation and validation.

Add schema validation for numeric ranges and invalid combinations:

- `min_changes >= 1`;
- thresholds `>= 0`;
- recognized thinking levels;
- valid trigger mode;
- non-empty custom types/scopes;
- duplicate/invalid patterns rejected or normalized.

Invalid configuration should produce a visible configuration error instead of silently falling back to defaults when that would change commit behavior.

### 8.3 Separate model failure from validation failure

Expose distinct causes:

- no model available;
- model request failed;
- model timed out;
- empty model response;
- response not conventional;
- response contradicts/contains invalid diff artifacts.

This makes diagnostics useful and lets fallback policy be deliberate.

### 8.4 Treat session context as untrusted hints

The diff is authoritative. Session context may influence wording but never determine files, type, or claims that are absent from the diff. Add adversarial tests where conversation text asks for changes not present in the repository.

---

## 9. Phase 5: deterministic concurrency and lifecycle

### 9.1 Repository-level operation lock

Maintain an in-memory lock keyed by canonical repository root. If another commit trigger fires while one is running:

- coalesce redundant automatic triggers;
- return a clear “commit already in progress” result for an explicit duplicate request;
- optionally queue exactly one follow-up inspection after the operation completes.

Never allow two pi-committer operations to stage/reset the same index concurrently.

### 9.2 Event coalescing

`turn_end`, `tool_result`, goal completion, and explicit `commit_changes` can occur close together. Route them through one trigger coordinator with deduplication instead of scattered booleans such as `committedThisTurn`.

Suggested model:

```text
trigger event
  -> TriggerCoordinator
  -> repository lock
  -> fresh inspect
  -> decide no-op / run
```

Record the triggering session entry/version so repeated lifecycle events with no new repository state do not create redundant work.

### 9.3 Operation-aware UI

The widget consumes progress events tagged with an operation ID. Late events for old operations are ignored naturally because they no longer match the active operation.

Avoid cleanup timers that directly mutate global progress. A presentation controller may schedule a hide for a completed operation ID; if a newer operation exists, hiding the old operation has no effect on it.

### 9.4 Session shutdown

With attached commits, shutdown has a simple rule: cancel current session-owned operations and run deterministic cleanup.

If background operations are later reintroduced, they must not retain a stale `ExtensionContext`. Completion should be delivered through a session-independent durable mechanism or safely dropped; the git operation itself must not rely on UI/session lifetime.

---

## 10. Phase 6: multi-repository behavior

### 10.1 Make repository discovery explicit

Current discovery is based heavily on recent `write`/`edit` tool calls. That misses changes produced by shell commands, scripts, generators, or tools with different argument shapes.

Use a session-scoped repository registry:

- primary cwd repository is registered at session start;
- observe file-mutating tool results when reliable path metadata exists;
- allow explicit registration by the commit tool when a repository path is supplied in the future;
- avoid claiming “all repos the agent touched” unless detection is complete.

### 10.2 Commit repositories independently

Each repository gets its own operation, plan, result, and error. The aggregate tool result should report partial success explicitly:

```text
repo-a: committed 2
repo-b: blocked — message generation failed
repo-c: skipped — no changes
```

Do not conflate aggregate zero with “nothing to commit.”

### 10.3 Never apply one message request blindly to unrelated repositories

If a user supplies a verbatim message and multiple repositories are dirty, either:

- require one target repository; or
- block and explain that a single exact message cannot safely describe multiple independent repositories.

---

## 11. Phase 7: test strategy overhaul

### 11.1 Test pyramid

**Pure unit tests**

Fast, no git process:

- config validation;
- path/exclusion logic;
- diff parsing;
- message validation;
- plan validation;
- result formatting;
- trigger coalescing state machine.

**Git integration tests**

Real temporary repositories, fake message generator:

- staged/unstaged/untracked combinations;
- rename/delete/binary/submodule cases;
- hooks;
- merge/conflict states;
- unborn repositories;
- worktrees;
- filenames with hostile shell characters;
- cancellation and repository-change preconditions;
- grouped commits and partial failures.

These should be the core correctness suite.

**Pi adapter tests**

Fake `ExtensionContext`/API, no real model:

- event wiring;
- commands/tools;
- progress routing;
- shutdown;
- model selection persistence;
- goal-trigger integration.

**Install/package smoke tests**

Pack the npm artifact, install it into a clean fixture, and load the extension exactly as users do. This catches missing runtime dependencies and packaging mistakes without needing the old detached worker.

**Live-model E2E tests**

Small optional suite, scheduled/manual only. Assert broad contract behavior, not exact generated wording. These tests must not be required to establish commit-engine correctness.

### 11.2 Eliminate arbitrary sleeps and long polling

Tests should await explicit signals/events. Where timers are part of UI behavior, use injected clocks/fake timers. A correctness test that allows a six-minute poll window is a signal that the dependency boundary is wrong.

### 11.3 Property/fuzz testing

Add property tests for:

- arbitrary valid git filenames;
- exclusion patterns;
- group assignment invariants;
- message parser/validator inputs;
- IPC/domain serialization if background execution returns later.

The most valuable fuzz target is “a path produced by git can pass through every plan/staging API without shell interpretation or data loss.”

### 11.4 Mutation tests for critical guards

Use mutation testing or targeted negative tests around:

- fallback disabled gate;
- repository precondition checks;
- message validation;
- cancellation before commit;
- exclusions;
- operation ID guards.

The goal is to prove tests fail if those safety conditions are accidentally removed.

---

## 12. Phase 8: observability and supportability

### 12.1 Structured diagnostic events

Replace scattered `console.error("DIAG: ...")` strings with structured events:

```ts
logger.warn("message.invalid", {
  operationId,
  repo,
  generator: "model",
  reason: "diff_artifact",
});
```

Default logs should avoid embedding full diffs, conversation context, credentials, or other sensitive content.

### 12.2 Correlation IDs

Every user-visible error should include a short operation ID, e.g. `commit op 7f3a2c`, so logs, widget state, and tool results can be correlated.

### 12.3 `/commit-doctor`

Add a diagnostic command that performs **read-only** checks:

- config file path and validated settings;
- repository root and HEAD;
- git version;
- pi/package version;
- selected model availability;
- staged/unstaged counts;
- whether another commit operation is active;
- extension runtime dependency status.

It should make bug reports actionable without asking users to reproduce with verbose logs first.

### 12.4 Stable error codes in tool details

Return machine-readable details alongside human text. This lets the agent respond intelligently instead of parsing notification prose.

---

## 13. Product behavior simplification

Reliability improves when there are fewer modes with overlapping semantics.

### 13.1 Recommended defaults

For the first overhaul release:

- `async_threshold = 0`;
- `staged_commits = false` unless grouping is explicitly requested or proven reliable;
- `deterministic_fallback = false` remains acceptable if the product intentionally prioritizes message quality, but failure must be fast and explicit;
- `match_repo_style = false` remains opt-in;
- preserve `manual` as the safest baseline trigger for new users, or clearly justify `on_goal` as the default only when pi-goal is detected.

The exact default trigger is a product decision, but configuration should never imply an integration exists when the companion extension is absent.

### 13.2 Make `/commit` predictable

`/commit` should mean:

1. inspect current repository;
2. explain/block on unsafe state;
3. generate/validate a plan;
4. commit exactly that plan;
5. return commit hashes or a typed failure.

It should not return before a live repository mutation that it initiated is complete unless the future snapshot-safe background architecture is being used.

---

## 14. Migration sequence

Implement the overhaul in small reviewable PRs rather than one rewrite.

### PR 1 — reliability baseline

- add CI;
- add package-install smoke test;
- add regression tests for all known failure classes;
- introduce stable `CommitResult`/`CommitError` domain types without changing behavior.

### PR 2 — safe git client

- introduce `GitClient` based on `execFile` argument arrays;
- use NUL-delimited status/name formats;
- migrate read-only git calls first;
- add hostile-filename tests;
- then migrate mutation commands.

### PR 3 — operation/session controller

- introduce operation IDs and repository locks;
- move warnings/progress/abort state off module globals;
- coalesce duplicate triggers;
- make widget progress operation-aware.

### PR 4 — shared message and diff modules

- extract parsers, validators, deterministic generator, style sampling, and message service from both current execution paths;
- change all long signatures to option objects;
- remove duplicated worker copies of pure logic.

### PR 5 — plan-before-mutate engine

- add `RepositorySnapshot` and `CommitPlan`;
- preserve pre-existing staged state;
- validate plan completely;
- revalidate repository preconditions before execution;
- stop after the first execution failure.

### PR 6 — retire current async worker

- set async default to disabled;
- remove loader resolution, detached child lifecycle, IPC races, and duplicated worker engine;
- remove jiti-specific worker runtime assumptions if no longer needed by the package.

This PR should produce a substantial net deletion of code.

### PR 7 — multi-repo cleanup

- introduce explicit repository registry;
- return per-repository results;
- define exact-message behavior across multiple repositories;
- add shell/script mutation fixtures.

### PR 8 — observability and doctor command

- structured diagnostics;
- operation IDs;
- `/commit-doctor`;
- stable error codes/tool details.

### Future PR — background commits, only if still valuable

Build snapshot-safe background execution behind an experimental flag. Do not reintroduce the old detached-live-worktree design.

---

## 15. Definition of done

The overhaul is complete when all of the following are true.

### Architecture

- one commit engine is used by every execution path;
- no mirrored sync/worker business logic exists;
- `index.ts` is primarily a pi adapter;
- operation state is scoped, not stored in unrelated module globals;
- git commands do not pass filenames through a shell.

### Correctness

- pre-existing staged changes are preserved according to a documented policy;
- a repository changed after planning is detected before commit;
- cancellation cannot create an unreported partial commit;
- every historical bug class has a deterministic regression test;
- hostile filenames work end-to-end;
- hook failures return a specific failure rather than “no changes.”

### Concurrency

- two commit triggers cannot mutate one repository simultaneously;
- late UI/events from an old operation cannot modify a newer operation;
- shutdown cleanup has one deterministic owner;
- no commit process mutates a live repository after returning “background started” unless snapshot isolation is implemented.

### Tests and release

- CI runs on every PR;
- deterministic core tests require no model/API access;
- npm package install/load is tested from a packed artifact;
- live-model E2E is optional and quarantined;
- supported Node/platform matrix is explicit.

### Supportability

- each failed operation has an operation ID and stable error code;
- `/commit-doctor` can collect the major environment/config facts read-only;
- normal diagnostics contain no full diff or conversation content by default.

---

## 16. Success metrics

Track reliability explicitly for several releases after the overhaul:

- zero known cases of lost or unintentionally committed user changes;
- zero worker/IPC/loader failures once the old worker is removed;
- zero timing-dependent flakes in required CI over 100 repeated runs;
- 100% of production bug fixes accompanied by a deterministic regression test;
- median manual commit overhead excluding model time remains within an agreed budget (for example <250 ms for a small repository);
- package-install smoke test passes on every supported Node version;
- decreasing count of mutable module-level variables and duplicated lines between execution paths.

Performance should remain measured, but reliability wins when the two conflict. A commit tool that takes an extra 100 ms and always commits the intended snapshot is better than a background path that returns instantly and occasionally commits the wrong state or silently dies.

---

## 17. Immediate first actions

If only a small amount of engineering time is available, do these first:

1. set `async_threshold` default to `0`;
2. add CI and a packed-install smoke test;
3. introduce `GitClient` with argument arrays and migrate all mutation commands;
4. add a repository lock and operation ID;
5. preserve and test pre-existing staged state;
6. extract shared message/diff logic so the worker contains no copied business rules;
7. then delete the current async worker and its lifecycle machinery.

Those steps remove the highest-risk concurrency and packaging surfaces before any feature expansion.

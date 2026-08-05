# pi-committer benchmarking & performance plan

Status: **implemented and measured**. This document records the benchmark
suite, the fresh baselines, the optimizations applied, the before/after
numbers, and the residual roadmap. It accompanies the goal of cutting
non-agent real-clock times by an order of magnitude while excluding
agent/LLM paths from both measurement and changes.

---

## 1. Scope and methodology

### 1.1 What is measured

Every non-agent pipeline is covered:

| Pipeline | Benchmark row(s) |
| --- | --- |
| Repo discovery (`gitRoot`, `findDirtyRepos` input) | `gitRoot x60 dirs` |
| Dirty-repo scan (`isDirtyRepo` seq; parallel variant inside `commitAllRepos`) | `isDirtyRepo x10 (seq)`, `session trigger` |
| Session-trigger aggregate (discovery + scan + commit) | `session trigger (60 dirs, 10 repos)` |
| Diff content & stat (`getDiffContent`, `stageAll`) | `getDiffContent small/medium/large`, `stageAll ...` |
| Gitignore filtering (`filterGitignoredFiles`) | `filterGitignoredFiles ...` |
| Unstage exclusions | `unstageExcludedFiles ...` |
| Message validation & resolution (`isValidCommitMessage`, `resolveCommitMessage`) | `resolveCommitMessage`, `isValidCommitMessage` |
| Deterministic generator (opt-in, behind `deterministic_fallback`) | `deterministicCommitMessage ...` |
| Group parsing (`parseCommitGroups`, `parseDiffHunks`) | `parseCommitGroups ...`, `parseDiffHunks (500 files)` |
| Style sampling (`sampleRepoCommitStyle`) | `sampleRepoCommitStyle (30 commits)` |
| Config load | `loadConfig (no file / with file)` |
| Widget rendering (JS side) | `renderCommitterWidgetLines`, `widget text helpers` |
| Worker boot + IPC round-trip (async pipeline) | `worker boot->progress/result (strip-types/jiti, default (block) / deterministic on)` |
| Full sync pipelines | `full pipeline stagedCommits=on/off`, `tryCommit single-commit/grouped`, `threshold sweep` |
| Subprocess-spawn floors | `git commit`, `stageFiles batched (1k)`, `full pipeline batched (10k)` |

Agent/LLM time is **excluded**: benchmarks either mock the agent session
(`__setCreateAgentSessionMock` returning instantly) or run with no agent
(model `undefined`) so the measured time is boot + git operations + JS
processing only. No benchmark makes a real LLM call.

### 1.2 Harness

`npm run benchmark` → `node --experimental-strip-types --test tests/benchmark.test.ts`
(74 tests / 26 suites, ~90s). Each row reports **avg / min / max over N
runs**; assertions avoid flaky hard thresholds. The worker pipeline is
measured through a subprocess driver (`tests/_worker-bench-driver.mjs`)
because node:test's runner has IPC quirks when forking with an IPC channel.
Results are written to `tests/benchmark-results.txt`; the pre-optimization
baseline is frozen at `tests/benchmark-baseline.txt` (2026-08-05, git
2.50.1).

### 1.3 Behavior change included in this effort

The content-driven deterministic commit-message generator is now gated
behind a new opt-in setting **`deterministic_fallback`** (default **off**):

- **Off (default):** the agent is required for every commit. The
  small-commit skip path (`subagent_message_min_files`) is inactive, and an
  unavailable, failed, or invalid agent message **blocks the commit** with a
  clear warning, leaving changes staged — a generic message is never
  committed.
- **On:** the previous behavior is preserved (deterministic fallback for
  small change sets and garbled subagent output).

This is why the benchmark's commit fixture uses a mocked agent, and the
worker round-trip is measured in both modes (`default (block)` and
`deterministic on`).

---

## 2. Before / after (fresh baseline vs optimized, same machine)

Frozen baseline: `tests/benchmark-baseline.txt` (72 measurements).
Optimized run: `tests/benchmark-results.txt` (76 measurements).

### 2.1 Session-latency aggregate — the 10x benchmark

| Row | Baseline avg | Optimized avg | Speedup |
| --- | ---: | ---: | ---: |
| `gitRoot x60 dirs` (discovery) | 942.61 ms | **0.37 ms** | ~2,550x |
| `session trigger (60 dirs, 10 repos)` | 1435.78 ms | **79.11 ms** | **18.1x** (94.5% reduction) |

The session trigger is the realistic per-trigger latency model: 60
tool-call directories × repo-root resolution + a 10-repo dirty scan + a
commit. It is **18x faster** — above the 10x (≥90% reduction) target.
Both the aggregate median/min and the discovery component independently
clear the target.

### 2.2 Commit pipelines

| Row | Baseline avg | Optimized avg | Speedup |
| --- | ---: | ---: | ---: |
| `tryCommit single-commit` (1 file) | 152.74 ms | 49.96 ms | 3.1x |
| `tryCommit single-commit` (3) | 101.86 ms | 53.41 ms | 1.9x |
| `tryCommit single-commit` (10) | 134.54 ms | 66.99 ms | 2.0x |
| `tryCommit single-commit` (30) | 140.48 ms | 77.53 ms | 1.8x |
| `tryCommit single-commit` (100) | 203.87 ms | 153.60 ms | 1.3x |
| `tryCommit grouped` (5) | 110.26 ms | 78.83 ms | 1.4x |
| `tryCommit grouped` (15) | 146.15 ms | 103.22 ms | 1.4x |
| `tryCommit grouped` (100) | 204.51 ms | 144.24 ms | 1.4x |
| `stageAll` small | 54.87 ms | 32.79 ms | 1.7x |
| `stageAll` large | 100.82 ms | 66.66 ms | 1.5x |
| `full pipeline stagedCommits=on` small | 100.50 ms | 81.85 ms | 1.2x |
| `full pipeline stagedCommits=off` large | 191.07 ms | 155.75 ms | 1.2x |

The sync commit pipeline was reduced from **9 git subprocess calls to 5**
(see §3.2), so per-commit latency drops roughly 2x; the remaining time is
git subprocess spawns (each ~15–30 ms) plus parsing.

### 2.3 Pure-JS / sub-ms rows (already negligible)

`getChangedFiles` 0.01–0.03 ms, `deterministicCommitMessage` ~0.2 ms,
`parseCommitGroups` ~0.1 ms, `resolveWorkerExecArgv` ~0 ms,
`loadConfig` ~0.05 ms, widget rendering ~0.15 ms, `isValidCommitMessage`
~0 ms, `resolveCommitMessage` ~0.05 ms — unchanged, no optimization needed.

---

## 3. What changed (behavior-preserving optimizations)

### 3.1 Repo discovery: gitRoot via filesystem walk (`P1`)

`gitRoot(dir)` previously ran `git rev-parse --show-toplevel` (~14.7 ms per
call) once per session tool-call directory. It now walks up for a `.git`
entry (~0.013 ms — **~1,100x per call**), with the subprocess as a fallback
for edge cases git semantics can't be replicated by a walk (e.g. bare repos
nested inside a working repo), plus a session-scoped cache. This is the
dominant session-trigger cost and the main 10x lever.

### 3.2 Sync commit pipeline: 9 → 5 git calls (`P3`)

| Call | Before | After |
| --- | --- | --- |
| `rev-parse --is-inside-work-tree` | `isGitRepo` | — merged into status |
| `status --porcelain` (dirty check) | `hasAnyChanges` | `tryCommit`'s single status call |
| `add -A` | `stageAll` | `stageAll` |
| `diff --cached --stat` | `stageAll` | — synthesized in JS |
| `diff --cached` | `getDiffContent` | `getDiffContent` |
| `check-ignore` (single-path filter) | `filterGitignoredFiles` | — removed (safe: `add -A` already excludes ignored files; grouped-path check-ignore stays) |
| `commit -F -` | `commitStaged` | `commitStaged` |
| `rev-parse HEAD` (hash) | `getHeadHash` | — parsed from `git commit` stdout |
| `log -1 --format=%B` (widget message) | `doSingleCommit` | — message reused from module state |

The synthesized diff stat (`buildDiffStatFromContent`) derives per-file
change counts from the unified diff via `parseDiffHunks` and is
binary-aware (parses `Binary files ... differ` lines so binary-only commits
are never skipped). The commit hash is parsed from the `[branch <hash>]`
summary line, falling back to `rev-parse HEAD` when hooks write to stdout.

### 3.3 Parallel dirty-repo scan (`P2`)

`commitAllRepos` checks non-primary repos concurrently
(`child_process/promises` `execFile` in `Promise.all`) instead of
sequentially — N × ~15 ms scans become ~25 ms at 10 repos. The exported
sequential `isDirtyRepo` API is unchanged.

### 3.4 Worker boot: strip-types retained; jiti kept for node_modules

Measured boot: `--experimental-strip-types` ~122 ms vs jiti ~142 ms — both
at the node process-startup floor. The plan originally called for
preferring strip-types on node ≥22.6 for installed (node_modules) workers,
but **verification showed node 26 still crashes `--experimental-strip-types`
for `.ts` files under `node_modules`** (exit 1; regression tests in
`worker-edge.test.ts` document this). jiti therefore remains mandatory for
the installed worker; dev-repo workers (not under node_modules) already use
strip-types. Correctness wins over the ~15% boot delta — documented here as
a spawn-floor item rather than forced.

### 3.5 Config caching

`loadConfig` is already ~0.05 ms (TOML parse of a tiny file); no caching
needed.

---

## 4. Spawn-floor items (documented, not forced)

These items cannot beat the single-subprocess-spawn floor (~15–30 ms) and
are intentionally left at their floor:

| Item | Floor | Reason |
| --- | ---: | --- |
| `git commit` | ~26–35 ms | one `git` process; the commit itself is irreducible |
| `getDiffContent` | ~16–26 ms | one `git diff` process (could be avoided for small repos by reading blobs directly, but that trades correctness/complexity for ~15 ms) |
| `filterGitignoredFiles` | ~15–18 ms | one `git check-ignore` batch per file-set; historically 2505 ms → ~16 ms via batching |
| Worker boot (strip-types / jiti) | ~122 / ~142 ms | node process startup + module load; `node --import` overhead |
| Worker IPC round-trip | ~560–990 ms | boot + git ops + (optional) deterministic message; jiti transform adds ~50–55% over strip-types on the round-trip |
| `isDirtyRepo x10 (seq)` | ~175 ms | sequential API measurement; the session trigger uses the parallel variant |
| Pure parsers (`parseCommitGroups`, `parseDiffHunks`, validation) | < 1 ms | JS-only, already negligible |

---

## 5. Residual roadmap

1. **Worker round-trip under jiti** (~990 → ~850 ms). The jiti transform is
   the delta. Options if node ever strips types under node_modules: drop
   jiti (tracked in the crash-scenario regression tests). Until then the
   worker path is at its floor.
2. **`getDiffContent`/`getDiffStat` spawn avoidance** for very large repos:
   read index + blobs directly. High complexity, ~15 ms upside — deferred.
3. **Repeated per-trigger work**: `findDirtyRepos` re-scans session history
   each trigger; caching per-session entry counts could skip scans when no
   new tool calls occurred since the last trigger.
4. **Windows/Linux baseline**: all numbers above are macOS (Apple Git
   2.50.1); re-run `npm run benchmark` on other platforms before changing
   spawn-floors conclusions.
5. **Deterministic-gate follow-ups**: docs/README notes for
   `deterministic_fallback`; consider a `/commit` dry-run flag that reports
   the block reason without the agent call.

---

## 6. How to reproduce

```bash
# Full benchmark suite (74 tests; writes tests/benchmark-results.txt)
npm run benchmark

# Compare against the frozen baseline
diff tests/benchmark-baseline.txt tests/benchmark-results.txt

# Correctness gates (all must stay green)
npm test            # 284 tests
npm run test:all    # unit + worker-edge + benchmark
PI_COMMITTER_E2E=1 npm run test:e2e   # 12 e2e tests (requires the extension symlink)
```

Baseline conditions: macOS, Apple Git 2.50.1, node 26 (strip-types), a
local checkout with `node_modules` installed (jiti present for the
node_modules-path rows).

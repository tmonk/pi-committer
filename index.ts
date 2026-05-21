import type { ExtensionAPI, ExtensionContext, Model } from "@earendil-works/pi-coding-agent";
import {
  createAgentSession,
  createExtensionRuntime,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import type { ResourceLoader } from "@earendil-works/pi-coding-agent";
import { matchesKey } from "@earendil-works/pi-tui";
import { Type, type Static } from "typebox";
import { execSync, fork } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig, type CommitterConfig } from "./config.ts";
import {
  CommitterWidgetComponent,
  type CommitterProgress,
  type SubagentProgress,
} from "./widget.ts";

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

export { loadConfig, type CommitterConfig } from "./config.ts";

// Tool parameter schemas — exported for isToolCallEventType support
const commitChangesSchema = Type.Object({});
export type CommitChangesInput = Static<typeof commitChangesSchema>;

let config: CommitterConfig;

/** Exported for unit test access. */
export function getConfig(): CommitterConfig {
  return config;
}
/** Exported for unit test access. */
export function setConfig(c: CommitterConfig): void {
  config = c;
}
let lastTurnEntryCount = 0;
let committedThisTurn = false;

// ---------------------------------------------------------------------------
// Async commit subprocess state
// ---------------------------------------------------------------------------

/** Path to the async commit worker script (resolved relative to this module). */
const __workerPath = (() => {
  try {
    return fileURLToPath(new URL("./async-commit-worker.ts", import.meta.url));
  } catch {
    return path.join(process.cwd(), "async-commit-worker.ts");
  }
})();

/** Reference to the forked child process for async commits. */
let __asyncChildProcess: import("node:child_process").ChildProcess | null = null;

// ---------------------------------------------------------------------------
// Profiling instrumentation (used by benchmarks and runtime introspection)
// ---------------------------------------------------------------------------

/** Last subagent call duration in ms (timer started before session creation). */
let __lastSubagentCallMs = 0;
/** Export for benchmarks. */
export function _getLastSubagentCallMs(): number { return __lastSubagentCallMs; }
/** Last commit group generation duration in ms. */
let __lastGroupGenCallMs = 0;
/** Export for benchmarks. */
export function _getLastGroupGenCallMs(): number { return __lastGroupGenCallMs; }

/** Flag set when an async commit is launched, checked by the tool handler. */
let __asyncCommitStarted = false;
let __asyncCommitFileCount = 0;

// ---------------------------------------------------------------------------
// Widget state
// ---------------------------------------------------------------------------

const COMMITTER_WIDGET_KEY = "pi-committer";
let __committerProgress: CommitterProgress | null = null;
let __committerWidgetComponent: CommitterWidgetComponent | null = null;
let __committerAnimationTimer: ReturnType<typeof setInterval> | null = null;
let __committerAbortController: AbortController | null = null;
let __committerTerminalInputUnsub: (() => void) | null = null;

/** Once-per-session flag: warn if on_goal mode is set without pi-goal installed. */
let warnedMissingGoals = false;
/** Exported for unit test access. */
export function _resetWarnedMissingGoals(): void { warnedMissingGoals = false; }

/** Track last known goal status per goal ID for detecting completion transitions. */
const goalStatuses = new Map<string, string>();
let lastGoalScanEntryCount = 0;

let _prevLastGoalScanEntryCount: number | undefined;
/** Clear stored goal statuses (for test setup). */
export function _clearGoalStatuses(): void {
  goalStatuses.clear();
}
/** Called by setUp in tests to snapshot then reset the scan offset. */
export function _resetGoalScanCount(): number {
  _prevLastGoalScanEntryCount = lastGoalScanEntryCount;
  lastGoalScanEntryCount = 0;
  return _prevLastGoalScanEntryCount ?? 0;
}
/** Restore the scan offset after a test that called _resetGoalScanCount. */
export function _restoreGoalScanCount(saved: number): void {
  lastGoalScanEntryCount = saved;
}

/** Exported for unit test access. */
export function _getAsyncCommitStarted(): boolean {
  return __asyncCommitStarted;
}
/** Exported for unit test access. */
export function _getAsyncCommitFileCount(): number {
  return __asyncCommitFileCount;
}

// ---------------------------------------------------------------------------
// Widget helpers
// ---------------------------------------------------------------------------

function startCommitterAnimation(): void {
  stopCommitterAnimation();
  __committerAnimationTimer = setInterval(() => {
    if (__committerWidgetComponent) {
      __committerWidgetComponent.update();
    }
  }, 80);
  __committerAnimationTimer.unref?.();
}

function stopCommitterAnimation(): void {
  if (__committerAnimationTimer) {
    clearInterval(__committerAnimationTimer);
    __committerAnimationTimer = null;
  }
}

function showCommitterWidget(
  ctx: ExtensionContext,
  initial: Omit<CommitterProgress, "startedAt" | "commitLog">,
): void {
  if (__committerProgress) hideCommitterWidget(ctx);

  __committerAbortController = new AbortController();
  __committerProgress = {
    ...initial,
    startedAt: Date.now(),
    commitLog: [],
  };

  if (ctx.hasUI) {
    __committerTerminalInputUnsub = ctx.ui.onTerminalInput((data) => {
      if (
        matchesKey(data, "escape") &&
        __committerProgress &&
        __committerProgress.phase !== "done"
      ) {
        // Kill async subprocess if running
        if (__asyncChildProcess && !__asyncChildProcess.killed) {
          __asyncChildProcess.kill("SIGTERM");
        }
        __committerAbortController?.abort();
        return { consume: true };
      }
      return undefined;
    });

    ctx.ui.setWidget(
      COMMITTER_WIDGET_KEY,
      (tui, theme) => {
        __committerWidgetComponent = new CommitterWidgetComponent({
          tui,
          theme,
          getProgress: () => __committerProgress,
        });
        return __committerWidgetComponent;
      },
      { placement: "aboveEditor" },
    );
    startCommitterAnimation();
  }
}

function updateCommitterWidget(): void {
  __committerWidgetComponent?.update();
}

function killAsyncSubprocess(): void {
  if (__asyncChildProcess && !__asyncChildProcess.killed) {
    try {
      __asyncChildProcess.kill("SIGTERM");
    } catch {
      // Process may have already exited
    }
    __asyncChildProcess = null;
  }
}

function hideCommitterWidget(ctx: ExtensionContext): void {
  stopCommitterAnimation();
  killAsyncSubprocess();
  if (__committerTerminalInputUnsub) {
    __committerTerminalInputUnsub();
    __committerTerminalInputUnsub = null;
  }
  if (ctx.hasUI) {
    ctx.ui.setWidget(COMMITTER_WIDGET_KEY, undefined);
  }
  __committerWidgetComponent = null;
  __committerAbortController = null;
  __committerProgress = null;
  __asyncCommitStarted = false;
  __asyncCommitFileCount = 0;
}

function getAbortSignal(): AbortSignal | undefined {
  return __committerAbortController?.signal;
}

function isAborted(): boolean {
  return __committerAbortController?.signal.aborted ?? false;
}

/** User-selected model override for the commit-message subagent (set via /commit-model). */
let selectedSubagentModel: Model<any> | undefined;

/** Exported for unit test access. Returns current selected model (if any). */
export function getSelectedSubagentModel(): Model<any> | undefined {
  return selectedSubagentModel;
}
/** Exported for unit test access. */
export function setSelectedSubagentModel(m: Model<any> | undefined): void {
  selectedSubagentModel = m;
}

// ---------------------------------------------------------------------------
// Mock injection for unit tests
// ---------------------------------------------------------------------------

/**
 * Override for createAgentSession used in unit tests to avoid real API calls.
 * When set, all functions that call createAgentSession will use this mock instead.
 * Reset to undefined to restore real behaviour.
 */
export let __createAgentSessionMock: typeof createAgentSession | undefined;

/** Set a mock for createAgentSession (replaces the real one in test-scoped calls). */
export function __setCreateAgentSessionMock(
  mock: typeof createAgentSession | undefined,
): void {
  __createAgentSessionMock = mock;
}

/** Resolve the current createAgentSession — mock if set, real otherwise. */
function resolveCreateAgentSession(): typeof createAgentSession {
  return __createAgentSessionMock ?? createAgentSession;
}

// ---------------------------------------------------------------------------
// Fork mock injection for unit tests
// ---------------------------------------------------------------------------

/** Override for fork() used in async commit tests. */
export let __forkMock: typeof fork | undefined;

/** Set a mock for fork (replaces the real one in test-scoped calls). */
export function __setForkMock(mock: typeof fork | undefined): void {
  __forkMock = mock;
}

/** Resolve the current fork — mock if set, real otherwise. */
function resolveFork(): typeof fork {
  return __forkMock ?? fork;
}

// ---------------------------------------------------------------------------
// Git helpers
// ---------------------------------------------------------------------------

export function isGitRepo(dir: string): boolean {
  try {
    execSync("git rev-parse --git-dir", {
      cwd: dir,
      stdio: ["ignore", "pipe", "ignore"],
      encoding: "utf-8",
    });
    return true;
  } catch {
    return false;
  }
}

export function getHeadHash(dir: string): string {
  return execSync("git rev-parse HEAD", {
    cwd: dir,
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "ignore"],
  }).trim();
}

export function getBranch(dir: string): string {
  return execSync("git rev-parse --abbrev-ref HEAD", {
    cwd: dir,
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "ignore"],
  }).trim();
}

/**
 * Get the full staged diff by writing to a temp file via --output, avoiding the
 * OS pipe buffer limit that causes ENOBUFS errors on macOS.
 */
/** @internal exported for benchmarking */
export function getDiffContent(dir: string): string {
  // Fast path: pipe the diff through execSync with a 10MB buffer.
  try {
    return execSync("git diff --cached", {
      cwd: dir,
      encoding: "utf-8",
      maxBuffer: 10 * 1024 * 1024,
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    // Fallback: if pipe buffer limits are hit (ENOBUFS on very large diffs),
    // use the file-based approach that bypasses the pipe entirely.
    const tmpDir = mkdtempSync(path.join(tmpdir(), "pi-committer-"));
    const diffFile = path.join(tmpDir, "diff-cached.txt");
    try {
      execSync(`git diff --cached --output="${diffFile}"`, { cwd: dir, stdio: "ignore" });
      return readFileSync(diffFile, "utf-8").trim();
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  }
}

/** Stage all changes and return the diff. */
export function stageAll(dir: string): { diffStat: string; diffContent: string } {
  execSync("git add -A", { cwd: dir, stdio: "ignore" });
  const diffStat = execSync("git diff --cached --stat", {
    cwd: dir,
    encoding: "utf-8",
    maxBuffer: 10 * 1024 * 1024,
    stdio: ["ignore", "pipe", "ignore"],
  }).trim();
  const diffContent = getDiffContent(dir);
  return { diffStat, diffContent };
}

/** Check for any changes (staged or unstaged). */
export function hasAnyChanges(dir: string): boolean {
  const status = execSync("git status --porcelain", {
    cwd: dir,
    encoding: "utf-8",
    maxBuffer: 10 * 1024 * 1024,
    stdio: ["ignore", "pipe", "ignore"],
  }).trim();
  return status.length > 0;
}

/**
 * Given a list of file paths, return only those that are NOT gitignored.
 * Uses `git check-ignore -q` which exits 0 for ignored files, 1 for non-ignored.
 */
export function filterGitignoredFiles(dir: string, files: string[]): string[] {
  if (files.length === 0) return [];
  // Batched check: feed all paths via stdin so git only runs once.
  try {
    const result = execSync(`git check-ignore --stdin`, {
      cwd: dir,
      input: files.join("\n"),
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
    });
    const ignored = new Set(result.trim().split("\n").filter(Boolean));
    return files.filter((f) => !ignored.has(f));
  } catch {
    // git check-ignore exits with code 1 when nothing is ignored
    return files;
  }
}

/** Extract changed file list from diff stat. */
export function getChangedFiles(diffStat: string): string[] {
  return diffStat
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && l.includes("|"))
    .map((l) => {
      const match = l.match(/^(.+?)\s+\|/);
      return match ? match[1].trim() : "";
    })
    .filter(Boolean);
}

/**
 * Unstage files that match any exclude pattern.
 * Returns the list of files that were NOT excluded.
 */
export function unstageExcludedFiles(
  dir: string,
  files: string[],
  excludePatterns: string[],
): string[] {
  if (excludePatterns.length === 0) return files;

  const kept: string[] = [];
  const toUnstage: string[] = [];

  for (const file of files) {
    const shouldExclude = excludePatterns.some((pattern) => {
      if (pattern.startsWith("*.")) {
        return file.endsWith(pattern.slice(1));
      }
      return file.includes(pattern);
    });

    if (shouldExclude) {
      toUnstage.push(file);
    } else {
      kept.push(file);
    }
  }

  // Batch-unstage all excluded files in one command
  if (toUnstage.length > 0) {
    const paths = toUnstage.map((f) => `${JSON.stringify(f)}`).join(" ");
    try {
      execSync(`git reset HEAD -- ${paths}`, { cwd: dir, stdio: "ignore" });
    } catch {
      // Fallback: some files might be new (never tracked), try git rm
      try {
        execSync(`git rm --cached -- ${paths}`, { cwd: dir, stdio: "ignore" });
      } catch {
        // Ultimate per-file fallback
        for (const f of toUnstage) {
          try {
            execSync(`git reset HEAD -- ${JSON.stringify(f)}`, { cwd: dir, stdio: "ignore" });
          } catch {
            try {
              execSync(`git rm --cached -- ${JSON.stringify(f)}`, {
                cwd: dir,
                stdio: "ignore",
              });
            } catch {
              // ignore
            }
          }
        }
      }
    }
  }

  return kept;
}

/** Reset all staged files (leave working tree untouched). */
export function unstageAll(dir: string): void {
  execSync("git reset HEAD -- .", { cwd: dir, stdio: "ignore" });
}

// ---------------------------------------------------------------------------
// Agent-decided staged commits
// ---------------------------------------------------------------------------

interface CommitGroup {
  /** The full conventional commit message (header + body). */
  message: string;
  /** Files to include in this commit. */
  files: string[];
}

/**
 * Parse the subagent's response into an array of CommitGroup.
 * Expected format:
 *
 * --- COMMIT GROUP 1 ---
 * <type>(<scope>): <description>
 *
 * <body>
 * Files: file1.ts, file2.ts
 *
 * --- COMMIT GROUP 2 ---
 * ...
 */
export function parseCommitGroups(output: string, allFiles: string[]): CommitGroup[] {
  const groups: CommitGroup[] = [];

  // Split on the commit group delimiter
  const blocks = output.split(/---\s*COMMIT\s+GROUP\s+\d+\s*---/);

  for (const block of blocks) {
    const trimmed = block.trim();
    if (!trimmed) continue;

    // Extract the files line
    const filesMatch = trimmed.match(/Files:\s*(.+)$/m);
    let files: string[] = [];
    if (filesMatch) {
      files = filesMatch[1]
        .split(",")
        .map((f) => f.trim())
        .filter((f) => f.length > 0);

      // Only keep files that are actually in the changed set
      files = files.filter((f) => allFiles.includes(f));
    }

    // If no files listed or none matched, skip this group
    if (files.length === 0) continue;

    // The message is everything except the Files: line
    const message = trimmed
      .replace(/Files:\s*.+$/m, "")
      .trim();

    if (message.length < 5) continue;

    groups.push({ message, files });
  }

  return groups;
}

/**
 * If the subagent didn't return parseable commit groups, fall back to
 * treating all remaining files as one group with a generated message.
 */
export function singleGroupFallback(
  ctx: ExtensionContext,
  diffStat: string,
  diffContent: string,
  allFiles: string[],
  repoDir?: string,
  signal?: AbortSignal,
): Promise<CommitGroup[]> {
  // If the signal is already aborted, return a deterministic fallback immediately
  // instead of spawning a new subagent session that will just be cancelled.
  if (signal?.aborted) {
    const message = deterministicCommitMessage(diffStat, diffContent);
    return Promise.resolve([{ message, files: allFiles }]);
  }
  return generateCommitMessageViaSubagent(ctx, diffStat, diffContent, repoDir, undefined, signal).then(
    (message) => [{ message, files: allFiles }],
  );
}

/**
 * Ask the subagent to analyze all changes and split them into logical commit groups.
 * The subagent decides the grouping based on semantic understanding of the diff,
 * rather than hardcoded file-category rules.
 */
export async function generateStagedCommitGroups(
  ctx: ExtensionContext,
  diffStat: string,
  diffContent: string,
  allFiles: string[],
  repoDir?: string,
  onProgress?: (progress: SubagentProgress) => void,
  signal?: AbortSignal,
): Promise<CommitGroup[]> {
  const _ts = performance.now();
  const truncatedDiff =
    diffContent.length > 12000
      ? diffContent.slice(0, 12000) + "\n... (truncated)"
      : diffContent;

  const fileListStr = allFiles.map((f) => `  - ${f}`).join("\n");

  const prompt = [
    "You are organizing a git commit. Given the diff below, split the changes into logical commit groups.",
    "",
    "Rules:",
    "- Group related changes together (same feature, same fix, same refactoring, same area of code)",
    "- Split unrelated changes into separate commits",
    "- Each commit must use conventional commit format: <type>(<scope>): <description>",
    "- Type must be one of: feat, fix, chore, docs, refactor, test, style, perf, ci, build, revert",
    "- Write a short imperative description (max 72 chars) and a body explaining what and why",
    "- Assign each file to EXACTLY ONE group",
    "- Cover ALL files listed below in your groups",
    "",
    `Changed files (${allFiles.length}):`,
    fileListStr,
    "",
    "Diff stat:",
    diffStat,
    "",
    "Diff content:",
    truncatedDiff,
    "",
    "Output format (replace N with group number):",
    "--- COMMIT GROUP 1 ---",
    "<type>(<scope>): <description>",
    "",
    "<body>",
    "Files: <file1>, <file2>",
    "",
    "--- COMMIT GROUP 2 ---",
    "...",
    "",
    "If all changes belong in one commit, output a single COMMIT GROUP.",
  ].join("\n");

  try {
    const model = resolveSubagentModel(ctx);
    const cas = resolveCreateAgentSession();
    const result = await cas({
      cwd: repoDir || ctx.cwd,
      model,
      modelRegistry: ctx.modelRegistry,
      resourceLoader: makeMessageResourceLoader(),
      sessionManager: SessionManager.inMemory(ctx.cwd),
      settingsManager: SettingsManager.inMemory({
        compaction: { enabled: false },
      }),
      tools: [],
    });

    const session = result.session;
    const outputParts: string[] = [];

    // Wire external abort signal to session.abort()
    const abortSession = () => { session.abort(); };
    signal?.addEventListener("abort", abortSession, { once: true });

    const unsubscribe = session.subscribe((event: any) => {
      // Collect output (existing logic)
      if (event.type === "message_end") {
        if (event.message?.role !== "assistant") return;
        for (const part of event.message.content ?? []) {
          if (part.type === "text" && typeof part.text === "string") {
            outputParts.push(part.text);
          }
        }
        // Show accumulated output in progress
        const fullText = outputParts.join("\n\n");
        const lines = fullText.split("\n").filter((l: string) => l.trim());
        onProgress?.({ recentOutput: lines.slice(-8) });
        return;
      }

      // Progress reporting
      if (!onProgress) return;
      if (event.type === "tool_execution_start") {
        onProgress({
          currentTool: event.toolName,
          currentToolArgs:
            typeof event.args === "object" && event.args !== null
              ? JSON.stringify(event.args).slice(0, 120)
              : String(event.args ?? "").slice(0, 120),
          currentToolStartedAt: Date.now(),
          recentOutput: [],
        });
        return;
      }
      if (event.type === "tool_execution_end") {
        onProgress({
          currentTool: undefined,
          currentToolArgs: undefined,
          currentToolStartedAt: undefined,
          recentOutput: [],
        });
        return;
      }
      if (event.type === "message_update") {
        const message = event.message as any;
        if (message?.role === "assistant") {
          const recentLines: string[] = [];
          for (const part of message.content ?? []) {
            if (
              part.type === "text" &&
              typeof part.text === "string" &&
              part.text.trim()
            ) {
              recentLines.push(
                ...part.text
                  .split("\n")
                  .filter((l: string) => l.trim()),
              );
            }
          }
          if (recentLines.length > 0) {
            onProgress({ recentOutput: recentLines.slice(-5) });
          }
        }
      }
    });

    try {
      if (signal?.aborted) {
        __lastGroupGenCallMs = performance.now() - _ts;
        return singleGroupFallback(ctx, diffStat, diffContent, allFiles, repoDir, signal);
      }
      await session.prompt(prompt);
    } finally {
      signal?.removeEventListener("abort", abortSession);
      unsubscribe();
    }

    if (signal?.aborted) {
      __lastGroupGenCallMs = performance.now() - _ts;
      return singleGroupFallback(ctx, diffStat, diffContent, allFiles, repoDir, signal);
    }

    const output = outputParts.join("\n\n").trim();
    if (output.length < 20) {
      __lastGroupGenCallMs = performance.now() - _ts;
      return singleGroupFallback(ctx, diffStat, diffContent, allFiles, repoDir, signal);
    }

    const groups = parseCommitGroups(output, allFiles);

    // Validate: every file should be covered exactly once
    const covered = new Set<string>();
    for (const g of groups) {
      for (const f of g.files) covered.add(f);
    }

    // If some files weren't covered, add them to the last group
    const uncovered = allFiles.filter((f) => !covered.has(f));
    if (uncovered.length > 0 && groups.length > 0) {
      const last = groups[groups.length - 1];
      last.files.push(...uncovered);
      last.message += `\n\n(additional changes: ${uncovered.join(", ")})`;
    }

    if (groups.length === 0) {
      __lastGroupGenCallMs = performance.now() - _ts;
      return singleGroupFallback(ctx, diffStat, diffContent, allFiles, undefined, signal);
    }

    __lastGroupGenCallMs = performance.now() - _ts;
    return groups;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[pi-committer] Staged commit grouping failed: ${msg}`);
    __lastGroupGenCallMs = performance.now() - _ts;
    return singleGroupFallback(ctx, diffStat, diffContent, allFiles, undefined, signal);
  }
}

// ---------------------------------------------------------------------------
// Abort signal helpers
// ---------------------------------------------------------------------------

/**
 * Combine two AbortSignals into one. If either signal is undefined, returns the other.
 * Returns undefined only when both inputs are undefined.
 * Uses AbortSignal.any() (available natively in Node 20.3+).
 */
export function combineAbortSignals(
  a: AbortSignal | undefined,
  b: AbortSignal | undefined,
): AbortSignal | undefined {
  if (!a) return b;
  if (!b) return a;
  return AbortSignal.any([a, b]);
}

// ---------------------------------------------------------------------------
// Goals integration
// ---------------------------------------------------------------------------

/**
 * Track last known status of each goal ID so we can detect completion.
 * Returns true only when a goal transitions to "complete" status.
 * Does NOT throw — returns false on any error, so the integration is non-blocking.
 */
export function checkGoalEvents(ctx: ExtensionContext): boolean {
  try {
    const entries = ctx.sessionManager.getEntries();
    const entryCount = entries.length;

    for (let i = lastGoalScanEntryCount; i < entryCount; i++) {
      const entry = entries[i];

      if (entry.type !== "custom" || entry.customType !== "pi-goal-state") {
        continue;
      }

      const goalData = (entry as any).data?.goal;
      if (!goalData) continue;

      const goalId = goalData.id;
      const currentStatus = goalData.status as string;
      if (!goalId || !currentStatus) continue;

      const previousStatus = goalStatuses.get(goalId);

      if (!previousStatus) {
        goalStatuses.set(goalId, currentStatus);
        continue;
      }

      goalStatuses.set(goalId, currentStatus);

      if (currentStatus === "complete" && previousStatus !== "complete") {
        return true;
      }
    }

    return false;
  } catch {
    return false;
  }
}

export function hasGoalsExtension(ctx: ExtensionContext): boolean {
  try {
    const entries = ctx.sessionManager.getEntries();
    return entries.some(
      (e) => e.type === "custom" && e.customType === "pi-goal-state",
    );
  } catch {
    return false;
  }
}

/**
 * Check if pi-goal has an active (non-complete) goal.
 * Scans session entries for the latest pi-goal-state with a status other than "complete".
 * Returns false if pi-goal is not present or all goals are complete.
 */
export function hasActiveGoal(ctx: ExtensionContext): boolean {
  try {
    const entries = ctx.sessionManager.getEntries();
    // Scan backward to find the latest state entry for each goal
    const seen = new Set<string>();
    for (let i = entries.length - 1; i >= 0; i--) {
      const entry = entries[i];
      if (entry.type === "custom" && entry.customType === "pi-goal-state") {
        const goalData = (entry as any).data?.goal;
        if (goalData && goalData.id && !seen.has(goalData.id)) {
          seen.add(goalData.id);
          if (goalData.status && goalData.status !== "complete") {
            return true;
          }
        }
      }
    }
    return false;
  } catch {
    return false;
  }
}

/**
 * Check if pi-goal is available. Warns once per session when goals
 * extension is missing but the trigger mode requires it.
 * Returns true when pi-goal is present.
 */
export function ensureGoalsExtension(ctx: ExtensionContext): boolean {
  if (hasGoalsExtension(ctx)) return true;
  if (!warnedMissingGoals) {
    warnedMissingGoals = true;
    ctx.ui.notify(
      "[pi-committer] trigger_mode 'on_goal' requires pi-goal extension. " +
      "Install from https://pi.dev/packages/@capyup/pi-goal or switch " +
      "trigger_mode to 'manual' in .pi-committer.toml.",
      "warning",
    );
  }
  return false;
}

/**
 * Determine whether commit_changes should defer to the automatic on_goal
 * trigger instead of committing immediately.
 *
 * Returns true only when ALL of the following hold:
 * 1. config.deferToGoalAudit is true (i.e., the user hasn't opted out)
 * 2. trigger mode is "on_goal"
 * 3. pi-goal extension is present in the session
 * 4. pi-goal has an active (non-complete) goal
 *
 * When deferToGoalAudit is false (set in .pi-committer.toml), this always
 * returns false, allowing commit_changes to proceed immediately.
 */
export function shouldDeferToGoalAudit(
  cfg: CommitterConfig,
  ctx: ExtensionContext,
): boolean {
  return (
    cfg.deferToGoalAudit &&
    cfg.triggerMode === "on_goal" &&
    hasGoalsExtension(ctx) &&
    hasActiveGoal(ctx)
  );
}

// ---------------------------------------------------------------------------
// Commit message generation via subagent
// ---------------------------------------------------------------------------

function makeMessageResourceLoader(): ResourceLoader {
  return {
    getExtensions: () => ({
      extensions: [],
      errors: [],
      runtime: createExtensionRuntime(),
    }),
    getSkills: () => ({ skills: [], diagnostics: [] }),
    getPrompts: () => ({ prompts: [], diagnostics: [] }),
    getThemes: () => ({ themes: [], diagnostics: [] }),
    getAgentsFiles: () => ({ agentsFiles: [] }),
    getSystemPrompt: () =>
      "You generate conventional git commit messages from diffs. Be concise.",
    getAppendSystemPrompt: () => [],
    extendResources: () => {},
    reload: async () => {},
  };
}

/**
 * Select the model for the commit-message subagent.
 * Priority: 1) user-selected via /commit-model  2) config subagent_model  3) current ctx.model
 */
export function resolveSubagentModel(ctx: ExtensionContext): Model<any> | undefined {
  if (selectedSubagentModel) return selectedSubagentModel;

  const cfgModel = config.subagentModel;
  if (cfgModel) {
    const slash = cfgModel.indexOf("/");
    if (slash > 0) {
      const provider = cfgModel.slice(0, slash);
      const id = cfgModel.slice(slash + 1);
      const found = ctx.modelRegistry.find(provider, id);
      if (found) return found;
    } else {
      const matches = ctx.modelRegistry
        .getAvailable()
        .filter((m) => m.id === cfgModel || m.name === cfgModel);
      if (matches.length > 0) return matches[0];
    }
  }

  return ctx.model;
}

/**
 * Spawn a VERY QUICK subagent to generate a conventional commit message.
 * Uses createAgentSession with no tools — the diff is passed inline.
 * Falls back to deterministic generation if the subagent fails.
 */
export async function generateCommitMessageViaSubagent(
  ctx: ExtensionContext,
  diffStat: string,
  diffContent: string,
  repoDir?: string,
  onProgress?: (progress: SubagentProgress) => void,
  signal?: AbortSignal,
): Promise<string> {
  const _ts = performance.now();
  const truncatedDiff =
    diffContent.length > 8000
      ? diffContent.slice(0, 8000) + "\n... (truncated)"
      : diffContent;

  const prompt = [
    "Generate a conventional commit message from this git diff.",
    "",
    "Format:",
    "<type>(<optional-scope>): <short description>",
    "",
    "<detailed body explaining what changed and why>",
    "",
    "Rules:",
    "- Type must be one of: feat, fix, chore, docs, refactor, test, style, perf, ci, build, revert",
    "- Scope is optional, derived from the module/directory changed",
    "- Description is a short imperative sentence (max 72 chars)",
    "- Body explains what and why, not how",
    "- Output ONLY the commit message, nothing else",
    "",
    "Diff stat:",
    diffStat,
    "",
    "Full diff:",
    truncatedDiff,
  ].join("\n");

  try {
    const model = resolveSubagentModel(ctx);
    const cas = resolveCreateAgentSession();
    const result = await cas({
      cwd: repoDir || ctx.cwd,
      model,
      modelRegistry: ctx.modelRegistry,
      resourceLoader: makeMessageResourceLoader(),
      sessionManager: SessionManager.inMemory(ctx.cwd),
      settingsManager: SettingsManager.inMemory({
        compaction: { enabled: false },
      }),
      tools: [],
    });

    const session = result.session;
    const outputParts: string[] = [];

    const unsubscribe = session.subscribe((event: any) => {
      // Collect output (existing logic)
      if (event.type === "message_end") {
        if (event.message?.role !== "assistant") return;
        for (const part of event.message.content ?? []) {
          if (part.type === "text" && typeof part.text === "string") {
            outputParts.push(part.text);
          }
        }
        // Show accumulated output in progress
        const fullText = outputParts.join("\n\n");
        const lines = fullText.split("\n").filter((l: string) => l.trim());
        onProgress?.({ recentOutput: lines.slice(-8) });
        return;
      }

      // Progress reporting
      if (!onProgress) return;
      if (event.type === "tool_execution_start") {
        onProgress({
          currentTool: event.toolName,
          currentToolArgs:
            typeof event.args === "object" && event.args !== null
              ? JSON.stringify(event.args).slice(0, 120)
              : String(event.args ?? "").slice(0, 120),
          currentToolStartedAt: Date.now(),
          recentOutput: [],
        });
        return;
      }
      if (event.type === "tool_execution_end") {
        onProgress({
          currentTool: undefined,
          currentToolArgs: undefined,
          currentToolStartedAt: undefined,
          recentOutput: [],
        });
        return;
      }
      if (event.type === "message_update") {
        const message = event.message as any;
        if (message?.role === "assistant") {
          const recentLines: string[] = [];
          for (const part of message.content ?? []) {
            if (
              part.type === "text" &&
              typeof part.text === "string" &&
              part.text.trim()
            ) {
              recentLines.push(
                ...part.text
                  .split("\n")
                  .filter((l: string) => l.trim()),
              );
            }
          }
          if (recentLines.length > 0) {
            onProgress({ recentOutput: recentLines.slice(-5) });
          }
        }
      }
    });

    // Wire external abort signal to abort the running session (matching pi-goal auditor pattern)
    const abortSession = () => { session.abort(); };
    signal?.addEventListener("abort", abortSession, { once: true });

    try {
      if (signal?.aborted) {
        __lastSubagentCallMs = performance.now() - _ts;
        return deterministicCommitMessage(diffStat, diffContent);
      }
      await session.prompt(prompt);
    } finally {
      signal?.removeEventListener("abort", abortSession);
      unsubscribe();
    }

    const generated = outputParts.join("\n\n").trim();
    if (generated.length > 10) {
      __lastSubagentCallMs = performance.now() - _ts;
      return generated;
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[pi-committer] Subagent message generation failed: ${msg}`);
  }

  __lastSubagentCallMs = performance.now() - _ts;
  return deterministicCommitMessage(diffStat, diffContent);
}

export function deterministicCommitMessage(
  diffStat: string,
  diffContent: string,
): string {
  const files = getChangedFiles(diffStat);

  let type = "chore";
  if (files.some((f) => /\.(test|spec|e2e)\./.test(f) || f.startsWith("test")))
    type = "test";
  else if (files.some((f) => /\.(md|txt|rst)$/.test(f) || f.includes("doc")))
    type = "docs";
  else if (files.some((f) => f.includes("config") || f.includes("package")))
    type = "chore";
  else if (
    diffContent.includes("fix") ||
    diffContent.includes("bug") ||
    diffContent.includes("error")
  )
    type = "fix";
  else if (
    diffContent.includes("feat") ||
    diffContent.includes("add") ||
    diffContent.includes("new")
  )
    type = "feat";

  const dirs = [
    ...new Set(files.map((f) => path.dirname(f)).filter((d) => d !== ".")),
  ];
  const scope = dirs.length > 0 ? dirs.join(",") : undefined;

  const desc =
    files.length === 1
      ? `update ${files[0]}`
      : `update ${files.length} modules`;

  const scopePart = scope ? `(${scope})` : "";
  const header = `${type}${scopePart}: ${desc}`;

  if (!diffStat.trim()) return header;

  const body = ["Changes:"]
    .concat(
      files.map((f) => {
        const statLine = diffStat
          .split("\n")
          .find((l) => l.trim().startsWith(f));
        const changes = statLine?.match(/(\d+) insertions?|\d+ deletions?/g);
        return `- ${f}${changes ? ` (${changes.join(", ")})` : ""}`;
      }),
    )
    .join("\n");

  return `${header}\n\n${body}`;
}

// ---------------------------------------------------------------------------
// Commit trigger logic
// ---------------------------------------------------------------------------

export function shouldCommitOnTrigger(
  mode: string,
  event: "turn_end" | "tool_result" | "goal_event",
): boolean {
  switch (mode) {
    case "on_goal":
      return event === "goal_event";
    case "agent_sensible":
      return event === "turn_end";
    case "after_tool":
      return event === "tool_result";
    case "manual":
      return false;
    default:
      return false;
  }
}

// ---------------------------------------------------------------------------
// Core commit logic
// ---------------------------------------------------------------------------

/**
 * Commit all currently staged files as a single commit.
 * Uses the subagent to generate the commit message.
 */
export async function commitStaged(
  dir: string,
  ctx: ExtensionContext,
  files: string[],
  onProgress?: (progress: SubagentProgress) => void,
  signal?: AbortSignal,
): Promise<string | undefined> {
  const diffStat = execSync("git diff --cached --stat", {
    cwd: dir,
    encoding: "utf-8",
    maxBuffer: 10 * 1024 * 1024,
    stdio: ["ignore", "pipe", "ignore"],
  }).trim();

  if (!diffStat) return undefined;

  const diffContent = getDiffContent(dir);

  try {
    const message = await generateCommitMessageViaSubagent(
      ctx,
      diffStat,
      diffContent,
      dir,
      onProgress,
      signal,
    );

    // Check for abort before actually committing — the subagent may have been
    // aborted mid-flight and returned a fallback message. We must not commit.
    if (signal?.aborted) {
      unstageAll(dir);
      return undefined;
    }

    const finalMessage =
      message.length > 10
        ? message
        : `chore: update ${files.length} file(s)`;

    execSync("git commit -F -", {
      cwd: dir,
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "ignore"],
      input: finalMessage,
    });

    const hash = getHeadHash(dir);
    const shortHash = hash.slice(0, 7);
    const summary = finalMessage.split("\n")[0];

    ctx.ui.notify(`[pi-committer] ✓ ${shortHash} ${summary}`, "success");
    return hash;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    ctx.ui.notify(`[pi-committer] Commit failed: ${msg}`, "error");
    return undefined;
  }
}

/**
 * Try to create one or more commits.
 *
 * When config.stagedCommits is true, delegates to the subagent to split
 * changes into logical commit groups (feature, test, docs, config, etc.)
 * with its own generated message.
 *
 * When false, commits all changes in a single message.
 *
 * Returns the number of successful commits, or 0 on no-op.
 */
export async function tryCommit(
  dir: string,
  ctx: ExtensionContext,
  force = false,
  runtimeSignal?: AbortSignal,
  allowAsync = true,
): Promise<number> {
  if (runtimeSignal?.aborted) return 0;

  if (!isGitRepo(dir)) {
    ctx.ui.notify("[pi-committer] Not a git repository — skipping", "info");
    return 0;
  }

  if (!hasAnyChanges(dir)) {
    if (force) ctx.ui.notify("[pi-committer] No changes to commit", "info");
    return 0;
  }

  // Stage everything so we can inspect the full diff
  const { diffStat, diffContent } = stageAll(dir);

  if (!diffStat) {
    ctx.ui.notify("[pi-committer] No changes to commit", "info");
    return 0;
  }

  let allFiles = getChangedFiles(diffStat);

  // Apply exclusion patterns
  allFiles = unstageExcludedFiles(dir, allFiles, config.excludePatterns);

  // Filter out gitignored files before proceeding
  allFiles = filterGitignoredFiles(dir, allFiles);

  if (allFiles.length === 0) {
    unstageAll(dir);
    ctx.ui.notify("[pi-committer] All changes excluded or gitignored — skipping", "info");
    return 0;
  }

  // Get min changes threshold
  if (!force && allFiles.length < config.minChanges) {
    unstageAll(dir);
    return 0;
  }

  // Check async threshold: for explicit commits (force=true) with enough files,
  // fork the commit into a subprocess so the conversation can continue immediately.
  if (allowAsync && config.asyncThreshold > 0 && force && allFiles.length >= config.asyncThreshold) {
    return tryCommitAsync(dir, ctx, diffStat, diffContent, allFiles, runtimeSignal);
  }

  // Show the committer widget
  const initialPhase = config.stagedCommits && allFiles.length > 1 ? "analyzing" : "committing";
  showCommitterWidget(ctx, {
    phase: initialPhase,
    fileCount: allFiles.length,
    statusMessage:
      initialPhase === "analyzing"
        ? `Analyzing ${allFiles.length} file(s) for logical commit grouping...`
        : `Generating commit message for ${allFiles.length} file(s)...`,
  });

  // Check for abort before starting the commit operation
  if (runtimeSignal?.aborted) {
    unstageAll(dir);
    ctx.ui.notify("[pi-committer] Commit cancelled.", "info");
    return 0;
  }

  let commitCount = 0;

  try {
    if (config.stagedCommits && allFiles.length > 1) {
      // ---- Agent-decided staged commit mode ----

      // Combine runtime signal with widget Esc signal AFTER showCommitterWidget
      // creates the __committerAbortController, so Esc cancellation flows through.
      const opSignal = combineAbortSignals(runtimeSignal, getAbortSignal());

      const groups = await generateStagedCommitGroups(
        ctx,
        diffStat,
        diffContent,
        allFiles,
        dir,
        (subProgress) => {
          if (__committerProgress) {
            __committerProgress.subagent = subProgress;
            updateCommitterWidget();
          }
        },
        opSignal,
      );

      // If aborted, unstage all and cancel fully (not fallthrough to single commit)
      if (runtimeSignal?.aborted || isAborted()) {
        unstageAll(dir);
        ctx.ui.notify("[pi-committer] Commit cancelled.", "info");
        return 0;
      }

      if (__committerProgress) {
        __committerProgress.phase = "committing";
        __committerProgress.totalCommits = groups.length;
        __committerProgress.completedCommits = 0;
        __committerProgress.subagent = undefined;
        updateCommitterWidget();
      }

      for (const group of groups) {
        if (runtimeSignal?.aborted || isAborted()) {
          unstageAll(dir);
          ctx.ui.notify("[pi-committer] Commit cancelled.", "info");
          return commitCount;
        }

        // Only stage this group's files
        unstageAll(dir);

        // Filter out any gitignored files from this group
        const groupFiles = filterGitignoredFiles(dir, group.files);
        if (groupFiles.length === 0) {
          ctx.ui.notify("[pi-committer] Skipping group — all files are gitignored", "info");
          continue;
        }

        for (const f of groupFiles) {
          execSync(`git add -- "${f}"`, { cwd: dir, stdio: "ignore" });
        }

        // Create commit with the group's message
        try {
          execSync("git commit -F -", {
            cwd: dir,
            encoding: "utf-8",
            stdio: ["pipe", "pipe", "ignore"],
            input: group.message,
          });

          const hash = getHeadHash(dir);
          const shortHash = hash.slice(0, 7);
          const summary = group.message.split("\n")[0];

          commitCount++;
          if (__committerProgress) {
            __committerProgress.commitLog.push({
              hash,
              message: group.message,
              success: true,
            });
            __committerProgress.completedCommits = commitCount;
            __committerProgress.statusMessage =
              commitCount < groups.length
                ? `Committing ${commitCount + 1}/${groups.length}...`
                : "All commits created";
            updateCommitterWidget();
          }

          ctx.ui.notify(`[pi-committer] ✓ ${shortHash} ${summary}`, "success");
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          ctx.ui.notify(`[pi-committer] Commit failed: ${msg}`, "error");
          if (__committerProgress) {
            __committerProgress.commitLog.push({
              hash: "",
              message: group.message,
              success: false,
            });
            updateCommitterWidget();
          }
        }
      }

      // Re-stage remaining changes, then re-apply exclusion patterns to prevent
      // previously excluded files from being re-added
      execSync("git add -A", { cwd: dir, stdio: "ignore" });
      if (config.excludePatterns.length > 0) {
        const remainingStat = execSync("git diff --cached --stat", {
          cwd: dir, encoding: "utf-8", maxBuffer: 10 * 1024 * 1024, stdio: ["ignore", "pipe", "ignore"],
        }).trim();
        if (remainingStat) {
          const remainingFiles = getChangedFiles(remainingStat);
          unstageExcludedFiles(dir, remainingFiles, config.excludePatterns);
        }
      }

      if (commitCount === 0) {
        ctx.ui.notify("[pi-committer] No commits created", "info");
      } else if (commitCount > 1) {
        ctx.ui.notify(
          `[pi-committer] ${commitCount} commits created`,
          "success",
        );
      }
    } else {
      // ---- Single commit mode ----
      if (runtimeSignal?.aborted || isAborted()) {
        unstageAll(dir);
        ctx.ui.notify("[pi-committer] Commit cancelled.", "info");
        return 0;
      }
      // Combine signals for single-commit path too, so Esc (via __committerAbortController)
      // and the runtime signal both flow through to abort the subagent and prevent the commit.
      const opSignal = combineAbortSignals(runtimeSignal, getAbortSignal());
      commitCount = await doSingleCommit(dir, ctx, allFiles, __committerProgress, opSignal);
    }
  } finally {
    // Mark as done or cancelled and schedule cleanup
    if (__committerProgress) {
      if (runtimeSignal?.aborted || isAborted()) {
        __committerProgress.phase = "cancelled";
        __committerProgress.error = "Commit cancelled by user.";
      } else {
        __committerProgress.phase = "done";
      }
      __committerProgress.totalCommits = commitCount;
      __committerProgress.completedCommits = commitCount;
      __committerProgress.statusMessage = undefined;
      updateCommitterWidget();
    }

    // Auto-hide the widget after 6 seconds (unless abort was triggered, then hide immediately)
    if (runtimeSignal?.aborted || isAborted()) {
      setTimeout(() => hideCommitterWidget(ctx), 3000);
    } else {
      setTimeout(() => hideCommitterWidget(ctx), 6000);
    }
  }

  return commitCount;
}

/**
 * Fork the commit pipeline into a detached subprocess for large changes.
 * Returns immediately (does not await the subprocess).
 */
async function tryCommitAsync(
  dir: string,
  ctx: ExtensionContext,
  diffStat: string,
  diffContent: string,
  allFiles: string[],
  runtimeSignal?: AbortSignal,
): Promise<number> {
  // Show widget with "preparing" phase — file count visible immediately
  showCommitterWidget(ctx, {
    phase: "preparing",
    fileCount: allFiles.length,
    statusMessage: `Preparing commit for ${allFiles.length} file(s)...`,
  });

  __asyncCommitStarted = true;
  __asyncCommitFileCount = allFiles.length;

  // Resolve model for the subprocess
  const model = resolveSubagentModel(ctx);
  const modelStr = model ? `${model.provider}/${model.id}` : undefined;

  try {
    const child = resolveFork()(__workerPath, [], {
      execArgv: ["--experimental-strip-types"],
      stdio: ["ignore", "ignore", "ignore", "ipc"],
      detached: true,
    });

    __asyncChildProcess = child;

    // Update widget with PID immediately
    if (__committerProgress && child.pid) {
      __committerProgress.subprocessPid = child.pid;
      updateCommitterWidget();
    }

    // Handle early exit (process died before sending result)
    let resultReceived = false;

    child.on("message", (msg: any) => {
      if (!msg || !__committerProgress) return;

      if (msg.type === "progress") {
        __committerProgress.phase = msg.phase;
        if (msg.fileCount !== undefined) __committerProgress.fileCount = msg.fileCount;
        if (msg.statusMessage !== undefined) __committerProgress.statusMessage = msg.statusMessage;
        if (msg.subagent !== undefined) __committerProgress.subagent = msg.subagent;
        if (msg.totalCommits !== undefined) __committerProgress.totalCommits = msg.totalCommits;
        if (msg.completedCommits !== undefined) __committerProgress.completedCommits = msg.completedCommits;
        updateCommitterWidget();
      } else if (msg.type === "commit") {
        __committerProgress.commitLog.push(msg.commit);
        __committerProgress.completedCommits = (__committerProgress.completedCommits ?? 0) + 1;
        updateCommitterWidget();
      } else if (msg.type === "result") {
        resultReceived = true;
        __asyncCommitStarted = false;
        __asyncCommitFileCount = 0;
        if (msg.error) {
          __committerProgress.phase = "done";
          __committerProgress.error = msg.error;
          __committerProgress.totalCommits = msg.commitCount;
          __committerProgress.completedCommits = msg.commitCount;
          __committerProgress.commitLog = msg.commitLog || [];
        } else {
          __committerProgress.phase = "done";
          __committerProgress.totalCommits = msg.commitCount;
          __committerProgress.completedCommits = msg.commitCount;
          __committerProgress.commitLog = msg.commitLog || [];
        }
        updateCommitterWidget();
        setTimeout(() => hideCommitterWidget(ctx), 6000);
        __asyncChildProcess = null;
      }
    });

    child.on("error", (err: Error) => {
      __asyncCommitStarted = false;
      __asyncCommitFileCount = 0;
      if (__committerProgress && !resultReceived) {
        __committerProgress.phase = "done";
        __committerProgress.error = `Subprocess error: ${err.message}`;
        updateCommitterWidget();
        setTimeout(() => hideCommitterWidget(ctx), 6000);
      }
      __asyncChildProcess = null;
    });

    child.on("exit", (code: number | null) => {
      __asyncCommitStarted = false;
      __asyncCommitFileCount = 0;
      if (__committerProgress && !resultReceived) {
        __committerProgress.phase = "done";
        __committerProgress.error = code === 0 ? undefined : `Subprocess exited with code ${code ?? "unknown"}`;
        if (!__committerProgress.error) {
          // Clean exit without result — likely no changes
          __committerProgress.totalCommits = 0;
          __committerProgress.completedCommits = 0;
        }
        updateCommitterWidget();
        setTimeout(() => hideCommitterWidget(ctx), 6000);
      }
      __asyncChildProcess = null;
    });

    // Send params to the worker
    child.send({
      type: "start",
      params: {
        dir,
        diffStat,
        diffContent,
        allFiles,
        stagedCommits: config.stagedCommits,
        excludePatterns: config.excludePatterns,
        minChanges: config.minChanges,
        subagentModel: modelStr,
      },
    });

    // Unref the child so it doesn't keep the process alive if the parent would otherwise exit
    child.unref();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[pi-committer] Failed to fork async worker: ${msg}`);
    // Fall back to sync path
    hideCommitterWidget(ctx);
    __asyncCommitStarted = false;
    __asyncCommitFileCount = 0;
    return 0;
  }

  // Return immediately — the subprocess runs in the background
  ctx.ui.notify(
    `[pi-committer] Commit started in background for ${allFiles.length} file(s). Progress visible in widget.`,
    "info",
  );
  return -1;
}

/**
 * Perform a single commit with subagent-generated message, tracking progress.
 */
async function doSingleCommit(
  dir: string,
  ctx: ExtensionContext,
  allFiles: string[],
  progress: CommitterProgress | null,
  signal?: AbortSignal,
): Promise<number> {
  if (progress) {
    progress.phase = "committing";
    progress.totalCommits = 1;
    progress.completedCommits = 0;
    progress.subagent = undefined;
    updateCommitterWidget();
  }

  const hash = await commitStaged(
    dir,
    ctx,
    allFiles,
    (subProgress) => {
      if (__committerProgress) {
        __committerProgress.subagent = subProgress;
        updateCommitterWidget();
      }
    },
    signal,
  );

  if (hash && progress) {
    // Get the actual commit message from git
    let message = hash;
    try {
      message = execSync("git log -1 --format=%B", {
        cwd: dir,
        encoding: "utf-8",
        stdio: ["ignore", "pipe", "ignore"],
      }).trim();
    } catch {
      // fallback to hash
    }
    progress.commitLog.push({
      hash,
      message,
      success: true,
    });
    progress.completedCommits = 1;
    updateCommitterWidget();
  }

  return hash ? 1 : 0;
}

// ---------------------------------------------------------------------------
// Multi-repo support
// ---------------------------------------------------------------------------

/**
 * Resolve a path to its git repository root.
 * Returns undefined if the path is not inside a git repo.
 */
export function gitRoot(dir: string): string | undefined {
  try {
    return execSync("git rev-parse --show-toplevel", {
      cwd: dir,
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return undefined;
  }
}

/**
 * Scan recent session entries for tool calls that operated in other directories.
 * Returns unique git repo roots that are different from the primary repo.
 */
export function findOtherReposFromSession(
  ctx: ExtensionContext,
  primaryRoot: string,
): string[] {
  const repoRoots = new Set<string>();

  try {
    // Look through the last 30 entries for tool call directories
    const entries = ctx.sessionManager.getEntries().slice(-30);

    for (const entry of entries) {
      // SessionMessageEntry: type === "message", message is AgentMessage
      if (entry.type !== "message") continue;
      const msgEntry = entry as any;
      const agentMsg = msgEntry.message;
      if (!agentMsg || agentMsg.role !== "assistant") continue;

      // Assistant message content: (TextContent | ThinkingContent | ToolCall)[]
      const content = agentMsg.content;
      if (!Array.isArray(content)) continue;

      for (const part of content) {
        // ToolCall: { type: "toolCall", name, arguments }
        if (part.type !== "toolCall") continue;
        const args = part.arguments || {};

        // write/edit: look for path in arguments, resolve its dir
        if (["write", "edit"].includes(part.name) && args.path) {
          const dir = path.dirname(args.path);
          const root = gitRoot(dir);
          if (root && root !== primaryRoot) repoRoots.add(root);
        }
      }
    }
  } catch {
    // Best-effort
  }

  return [...repoRoots];
}

/**
 * Find all dirty git repositories.
 * Detection uses only session tool-call history: repos where the agent
 * created or modified files via write or edit tools are detected and
 * added on top of the primary working directory.
 */
export function findDirtyRepos(ctx: ExtensionContext): string[] {
  const repos = new Set<string>();
  const cwd = ctx.cwd;
  const primaryRoot = gitRoot(cwd);

  // Always include the primary repo
  if (primaryRoot) {
    repos.add(primaryRoot);
  }

  // Session tool call detection for repos outside the cwd tree
  const sessionRepos = findOtherReposFromSession(ctx, primaryRoot ?? cwd);
  for (const r of sessionRepos) repos.add(r);

  // Sort: primary first, then alphabetically
  const sorted = [...repos].sort();
  if (primaryRoot) {
    const idx = sorted.indexOf(primaryRoot);
    if (idx > 0) {
      sorted.splice(idx, 1);
      sorted.unshift(primaryRoot);
    }
  }

  return sorted;
}

/**
 * Check if a repo has any uncommitted changes.
 */
export function isDirtyRepo(repoDir: string): boolean {
  try {
    const status = execSync("git status --porcelain", {
      cwd: repoDir,
      encoding: "utf-8",
      maxBuffer: 10 * 1024 * 1024,
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    return status.length > 0;
  } catch {
    return false;
  }
}

/**
 * Commit changes across all dirty git repos.
 * Returns total commits created across all repos.
 */
export async function commitAllRepos(
  dir: string,
  ctx: ExtensionContext,
  force = false,
  runtimeSignal?: AbortSignal,
): Promise<number> {
  const repos = findDirtyRepos(ctx);
  let totalCommits = 0;

  if (runtimeSignal?.aborted) return 0;

  if (repos.length === 1) {
    // Single repo — normal behavior
    return tryCommit(dir, ctx, force, runtimeSignal);
  }

  // Filter to only dirty repos
  const dirtyRepos = repos.filter((r) => {
    // For the primary repo, check with the force flag semantics
    if (r === repos[0]) return true;
    return isDirtyRepo(r);
  });

  if (dirtyRepos.length <= 1) {
    return tryCommit(dir, ctx, force, runtimeSignal);
  }

  ctx.ui.notify(
    `[pi-committer] Found ${dirtyRepos.length} repo(s) with changes...`,
    "info",
  );

  for (const repoDir of dirtyRepos) {
    if (runtimeSignal?.aborted) break;
    const label = repoDir === dir ? "primary" : repoDir.split("/").pop() ?? "";
    ctx.ui.notify(`[pi-committer] Committing in ${label}...`, "info");
    // Allow async only for single-repo (multi-repo async is out of scope)
    const count = await tryCommit(repoDir, ctx, force, runtimeSignal, false);
    if (count > 0) totalCommits += count;
  }

  return totalCommits;
}

// ---------------------------------------------------------------------------
// Extension entry point
// ---------------------------------------------------------------------------

export default function (pi: ExtensionAPI) {
  config = loadConfig(process.cwd());
  selectedSubagentModel = undefined;

  // -----------------------------------------------------------------------
  // Session start
  // -----------------------------------------------------------------------
  pi.on("session_start", async (_event, ctx) => {
    config = loadConfig(ctx.cwd);
    lastTurnEntryCount = 0;
    lastGoalScanEntryCount = 0;
    goalStatuses.clear();
    committedThisTurn = false;
    warnedMissingGoals = false;
    selectedSubagentModel = undefined;
    // Clean up any stale widget state
    stopCommitterAnimation();
    if (__committerTerminalInputUnsub) {
      __committerTerminalInputUnsub();
      __committerTerminalInputUnsub = null;
    }
    __committerWidgetComponent = null;
    __committerAbortController = null;
    __committerProgress = null;

    // Reconstruct previously selected commit-message model from session entries
    for (const entry of ctx.sessionManager.getEntries()) {
      if (entry.type === "custom" && entry.customType === "pi-committer-model") {
        const data = (entry as any).data ?? {};
        if (data.provider && data.id) {
          const model = ctx.modelRegistry.find(data.provider, data.id);
          if (model) {
            selectedSubagentModel = model;
          }
        }
        break; // latest entry wins
      }
    }

    if (config.enabled) {
      ctx.ui.notify(
        `[pi-committer] Active (mode: ${config.triggerMode})${
          config.stagedCommits ? ", staged commits" : ""
        }`,
        "info",
      );
    }
  });

  // -----------------------------------------------------------------------
  // Model select — update status bar
  // -----------------------------------------------------------------------
  pi.on("model_select", async (event, ctx) => {
    if (!config.enabled) return;
    const modelLabel = selectedSubagentModel
      ? `${selectedSubagentModel.provider}/${selectedSubagentModel.id}`
      : `${event.model.provider}/${event.model.id} (default)`;
    ctx.ui.setStatus("pi-committer", `commit model: ${modelLabel}`);
  });

  // -----------------------------------------------------------------------
  // Turn end
  // -----------------------------------------------------------------------
  pi.on("turn_end", async (_event, ctx) => {
    if (!config.enabled) return;
    committedThisTurn = false;

    if (shouldCommitOnTrigger(config.triggerMode, "turn_end")) {
      await commitAllRepos(ctx.cwd, ctx);
    }

    if (shouldCommitOnTrigger(config.triggerMode, "goal_event")) {
      if (ensureGoalsExtension(ctx) && checkGoalEvents(ctx)) {
        await commitAllRepos(ctx.cwd, ctx);
      }
    }

    lastTurnEntryCount = ctx.sessionManager.getEntries().length;
    lastGoalScanEntryCount = lastTurnEntryCount;
  });

  // -----------------------------------------------------------------------
  // Tool result
  // -----------------------------------------------------------------------
  pi.on("tool_result", async (_event, ctx) => {
    if (!config.enabled || committedThisTurn) return;

    if (shouldCommitOnTrigger(config.triggerMode, "tool_result")) {
      const result = await commitAllRepos(ctx.cwd, ctx);
      if (result > 0) committedThisTurn = true;
    }
  });

  // -----------------------------------------------------------------------
  // Custom tool: commit_changes
  // -----------------------------------------------------------------------
  pi.registerTool({
    name: "commit_changes",
    label: "Commit Changes",
    description:
      "Stage all changes and create one or more conventional commits with subagent-generated messages. " +
      "When staged commits is on (default), the subagent groups changes into logical commits.",
    promptSnippet:
      "Stage and commit changes with conventional commit messages",
    promptGuidelines: [
      "Use commit_changes when the user asks to commit, save progress, or checkpoint work.",
      "Call commit_changes when completing significant work or on user request.",
      "When pi-goal is active with trigger_mode=on_goal, do NOT call commit_changes before marking the goal complete — the automatic on_goal trigger will commit after the goal audit passes. Calling commit_changes preemptively bypasses the audit.",
    ],
    parameters: commitChangesSchema,
    async execute(_toolCallId, _params, signal, _onUpdate, ctx) {
      if (signal?.aborted) {
        return {
          content: [{ type: "text" as const, text: "Commit cancelled." }],
          details: { commitCount: 0, cancelled: true },
        };
      }

        // Defer to goal audit: if on_goal mode is active and pi-goal has an
      // active (non-complete) goal, skip committing and let the automatic
      // on_goal trigger handle it after the goal audit passes.
      if (shouldDeferToGoalAudit(config, ctx)) {
        return {
          content: [
            {
              type: "text" as const,
              text: [
                "Commit deferred: pi-goal has an active goal with on_goal trigger mode.",
                "Changes will be automatically committed when the goal completes and the audit passes.",
                "If you need to commit immediately, set defer_to_goal_audit = false in .pi-committer.toml.",
              ].join("\n"),
            },
          ],
          details: { commitCount: 0, deferred: true },
        };
      }

      const count = await commitAllRepos(ctx.cwd, ctx, true, signal);

      // Async commit started in background
      if (count === -1) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Commit started in background for ${__asyncCommitFileCount} file(s). Progress visible in widget.`,
            },
          ],
          details: { commitCount: 0, async: true },
        };
      }

      // Check for cancellation from any source (runtime signal or Esc via widget)
      if (signal?.aborted || isAborted()) {
        return {
          content: [{ type: "text" as const, text: "Commit cancelled." }],
          details: { commitCount: 0, cancelled: true },
        };
      }
      if (count > 0) {
        return {
          content: [
            {
              type: "text" as const,
              text: `${count} commit(s) created successfully.`,
            },
          ],
          details: { commitCount: count },
        };
      }
      return {
        content: [
          {
            type: "text" as const,
            text: "Nothing to commit — no changes detected or all changes were excluded.",
          },
        ],
        details: {},
      };
    },
  });

  // -----------------------------------------------------------------------
  // Manual command: /commit
  // -----------------------------------------------------------------------
  pi.registerCommand("commit", {
    description: "Create one or more conventional commits",
    handler: async (_args, ctx) => {
      await commitAllRepos(ctx.cwd, ctx, true);
    },
  });

  // -----------------------------------------------------------------------
  // Model selection: /commit-model
  // -----------------------------------------------------------------------
  pi.registerCommand("commit-model", {
    description: "Select which model generates commit messages",
    handler: async (_args, ctx) => {
      const models = ctx.modelRegistry.getAvailable();
      if (models.length === 0) {
        ctx.ui.notify("[pi-committer] No models available", "error");
        return;
      }

      const choices = models.map(
        (m) => `${m.provider}/${m.id}`,
      );

      // Add a "reset to default" option at the top
      const allChoices = ["(default — use current agent model)", ...choices];

      const selected = await ctx.ui.select(
        "Select model for commit message generation:",
        allChoices,
      );

      if (!selected) {
        ctx.ui.notify("[pi-committer] Model selection cancelled", "info");
        return;
      }

      if (selected === "(default — use current agent model)") {
        selectedSubagentModel = undefined;
        config.subagentModel = undefined;
        pi.appendEntry("pi-committer-model", null);
        ctx.ui.notify(
          "[pi-committer] Using default agent model for commit messages",
          "info",
        );
        return;
      }

      // Find the selected model
      const idx = allChoices.indexOf(selected);
      if (idx < 1) return;
      const chosenModel = models[idx - 1];
      selectedSubagentModel = chosenModel;
      pi.appendEntry("pi-committer-model", {
        provider: chosenModel.provider,
        id: chosenModel.id,
      });

      ctx.ui.notify(
        `[pi-committer] Commit messages will use ${chosenModel.provider}/${chosenModel.id}`,
        "success",
      );
    },
  });

  // -----------------------------------------------------------------------
  // Config reload: /commit-config
  // -----------------------------------------------------------------------
  pi.registerCommand("commit-config", {
    description: "Reload pi-committer configuration",
    handler: async (_args, ctx) => {
      config = loadConfig(ctx.cwd);
      // Don't clear the model override from config reload — user's interactive
      // choice via /commit-model takes precedence for the session.
      ctx.ui.notify(
        `[pi-committer] Reloaded. Mode: ${config.triggerMode}`,
        "info",
      );
    },
  });

  // -----------------------------------------------------------------------
  // Session shutdown — clean up per-session state
  // -----------------------------------------------------------------------
  pi.on("session_shutdown", async (_event, _ctx) => {
    // Kill any running async subprocess
    killAsyncSubprocess();
  });
}

/**
 * Async commit worker — runs the commit pipeline in a forked child process.
 *
 * This file is the entry point for the child process. It communicates with
 * the parent via IPC (process.send / process.on('message')).
 *
 * The worker is self-contained: it uses execSync for git operations and
 * dynamically imports the pi SDK if available for subagent message generation.
 * If the SDK is not available, it falls back to deterministic commit messages.
 */

import { execSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface CommitWorkerParams {
  /** Git repo directory */
  dir: string;
  /** Output of `git diff --cached --stat` */
  diffStat: string;
  /** Full diff content */
  diffContent: string;
  /** List of changed files */
  allFiles: string[];
  /** Whether to use staged commits (grouping) */
  stagedCommits: boolean;
  /** Glob patterns to exclude */
  excludePatterns: string[];
  /** Minimum changes threshold */
  minChanges: number;
  /** Resolved model for the subagent (provider/id string, e.g. "openai/gpt-4o-mini") */
  subagentModel?: string;
  /** Minimum changed files to use the subagent for grouping */
  subagentGroupingMinFiles: number;
  /** Minimum changed files to use the subagent for a single commit message */
  subagentMessageMinFiles: number;
  /** Thinking level for the subagent session (off, minimal, low, medium, high, xhigh) */
  subagentThinkingLevel?: string;
}

interface CommitLogEntry {
  hash: string;
  message: string;
  success: boolean;
}

interface WorkerProgress {
  phase: "analyzing" | "committing" | "done" | "cancelled";
  fileCount?: number;
  statusMessage?: string;
  subagent?: {
    currentTool?: string;
    currentToolArgs?: string;
    currentToolStartedAt?: number;
    recentOutput: string[];
  };
  totalCommits?: number;
  completedCommits?: number;
}

// ---------------------------------------------------------------------------
// Abort state — set by SIGTERM from parent
// ---------------------------------------------------------------------------

let aborted = false;

process.on("SIGTERM", () => {
  aborted = true;
});

process.on("SIGHUP", () => {
  aborted = true;
});

// ---------------------------------------------------------------------------
// Timeout safeguard — prevent zombie processes after 5 minutes
// ---------------------------------------------------------------------------

const WORKER_TIMEOUT_MS = 5 * 60 * 1000;
const __workerTimeout = setTimeout(() => {
  sendResultAndExit({ commitCount: 0, commitLog: [], error: "Worker timed out after 5 minutes." }, 0);
}, WORKER_TIMEOUT_MS);

// Clear the timeout when we get a result (handled in process.on('message') handler)
function clearWorkerTimeout(): void {
  clearTimeout(__workerTimeout);
}

// ---------------------------------------------------------------------------
// IPC helpers
// ---------------------------------------------------------------------------

function send(msg: Record<string, unknown>): void {
  if (process.send) {
    process.send(msg);
  }
}

function sendProgress(p: WorkerProgress): void {
  send({ type: "progress", ...p });
}

function sendCommit(entry: CommitLogEntry): void {
  send({ type: "commit", commit: entry });
}

function sendResult(result: {
  commitCount: number;
  commitLog: CommitLogEntry[];
  error?: string;
  warnings?: string[];
}): void {
  send({ type: "result", ...result });
}

/**
 * Send the result IPC message and exit the worker only after the message
 * has been delivered to the parent. Uses process.send's callback to confirm
 * delivery, eliminating the race where process.exit() fires before the
 * queued IPC message reaches the parent.
 */
export function sendResultAndExit(
  result: {
    commitCount: number;
    commitLog: CommitLogEntry[];
    error?: string;
    warnings?: string[];
  },
  exitCode: number,
): void {
  clearWorkerTimeout();
  if (process.send) {
    process.send({ type: "result", ...result }, () => {
      process.exitCode = exitCode;
      // Use setImmediate to let the callback stack unwind before exiting
      setImmediate(() => process.exit());
    });
  } else {
    process.exitCode = exitCode;
    setImmediate(() => process.exit());
  }
}

// ---------------------------------------------------------------------------
// Pure git helpers (execSync-based, no SDK needed)
// ---------------------------------------------------------------------------

export function git(...args: string[]): string {
  return execSync(`git ${args.join(" ")}`, {
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "ignore"],
  }).trim();
}

export function gitCwd(dir: string, ...args: string[]): string {
  return execSync(`git ${args.join(" ")}`, {
    cwd: dir,
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "ignore"],
  }).trim();
}

export function getHeadHash(dir: string): string {
  return gitCwd(dir, "rev-parse", "HEAD");
}

export function unstageAll(dir: string): void {
  try {
    gitCwd(dir, "reset", "HEAD", "--", ".");
  } catch {
    // Ignore errors (e.g., no commits yet)
  }
}

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
    // Fallback: use file-based approach to bypass pipe limits on very large diffs
    const tmpDir = mkdtempSync(path.join(tmpdir(), "pi-committer-worker-"));
    const diffFile = path.join(tmpDir, "diff-cached.txt");
    try {
      execSync(`git diff --cached --output="${diffFile}"`, {
        cwd: dir,
        stdio: "ignore",
      });
      return readFileSync(diffFile, "utf-8").trim();
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  }
}

export function getChangedFiles(diffStat: string): string[] {
  return diffStat
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => {
      // Parse "path/to/file.ext | 1 +" format
      const parts = l.split("|");
      return parts[0]?.trim() ?? "";
    })
    .filter(Boolean);
}

export function isGitignored(dir: string, file: string): boolean {
  try {
    execSync(`git check-ignore -- "${file}"`, {
      cwd: dir,
      stdio: ["ignore", "pipe", "ignore"],
      encoding: "utf-8",
    });
    return true;
  } catch {
    return false;
  }
}

export function filterGitignoredFiles(dir: string, files: string[]): string[] {
  if (files.length === 0) return [];
  try {
    const result = execSync(`git check-ignore --stdin`, {
      cwd: dir,
      input: files.join("\n"),
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
    });
    const ignored = new Set(
      result.trim().split("\n").filter(Boolean),
    );
    return files.filter((f) => !ignored.has(f));
  } catch {
    // If git check-ignore fails (e.g., no .gitignore), nothing is ignored
    return files;
  }
}

export function unstageExcludedFiles(
  dir: string,
  files: string[],
  excludePatterns: string[],
): string[] {
  if (excludePatterns.length === 0) return files;
  const toKeep: string[] = [];
  const toUnstage: string[] = [];

  for (const f of files) {
    const isExcluded = excludePatterns.some((pattern) => {
      // Simple glob match: support * and **
      if (pattern.endsWith("/")) {
        return f.startsWith(pattern) || f.startsWith(pattern.slice(0, -1));
      }
      if (pattern.startsWith("*.")) {
        return f.endsWith(pattern.slice(1));
      }
      if (pattern.includes("*")) {
        const re = new RegExp(
          "^" + pattern.replace(/\*\*/g, ".*").replace(/\*/g, "[^/]*") + "$",
        );
        return re.test(f);
      }
      return f === pattern;
    });

    if (isExcluded) {
      toUnstage.push(f);
    } else {
      toKeep.push(f);
    }
  }

  // Batch-unstage all excluded files in one command
  if (toUnstage.length > 0) {
    const paths = toUnstage.map((f) => `${JSON.stringify(f)}`).join(" ");
    try {
      execSync(`git reset HEAD -- ${paths}`, { cwd: dir, stdio: "ignore" });
    } catch {
      // Per-file fallback
      for (const f of toUnstage) {
        try {
          execSync(`git reset HEAD -- ${JSON.stringify(f)}`, { cwd: dir, stdio: "ignore" });
        } catch {
          // File might not be staged, ignore
        }
      }
    }
  }

  return toKeep;
}

// ---------------------------------------------------------------------------
// Batch staging helper (mirrors the same function in index.ts)
// ---------------------------------------------------------------------------

/**
 * Parse git stderr lines to find file paths that failed.
 */
function parseFailedPaths(stderr: string): Set<string> {
  const failed = new Set<string>();
  for (const line of stderr.split("\n")) {
    const m = line.match(/pathspec '(.+?)' did not match/);
    if (m) { failed.add(m[1]); continue; }
    const m2 = line.match(/Unable to process path '(.+?)'/);
    if (m2) { failed.add(m2[1]); }
  }
  return failed;
}

/**
 * Batch-stage a list of files using `git add --ignore-errors` calls
 * with batch size 5000 to minimize subprocess overhead.
 *
 * `git add --ignore-errors` handles all tracked file states natively:
 * modified files, deleted tracked files (stages the deletion), and
 * new files on disk. For genuinely unstageable files, git reports
 * them on stderr which we parse & report via onWarning.
 *
 * @returns {staged, allFailed}
 */
export function batchStageFilesForGroup(
  dir: string,
  groupFiles: string[],
  onWarning: (filePath: string, msg: string) => void,
  onGroupSkipped: () => void,
): { staged: string[]; allFailed: boolean } {
  if (groupFiles.length === 0) {
    onGroupSkipped();
    return { staged: [], allFailed: true };
  }

  const stagedFiles: string[] = [];
  const warnedFiles = new Set<string>();
  const maxBatchSize = 5000;

  for (let i = 0; i < groupFiles.length; i += maxBatchSize) {
    const batch = groupFiles.slice(i, i + maxBatchSize);
    const quoted = batch.map((f) => JSON.stringify(f)).join(" ");

    try {
      execSync(`git add --ignore-errors -- ${quoted}`, {
        cwd: dir,
        stdio: ["ignore", "pipe", "pipe"],
        encoding: "utf-8",
      });
      stagedFiles.push(...batch);
    } catch (err) {
      const stderr = ((err as any)?.stderr ?? "") as string;
      const failedPaths = parseFailedPaths(stderr);
      for (const f of batch) {
        if (failedPaths.has(f)) {
          if (!warnedFiles.has(f)) {
            warnedFiles.add(f);
            onWarning(f, "could not be staged");
          }
        } else {
          stagedFiles.push(f);
        }
      }
    }
  }

  if (stagedFiles.length === 0) {
    onGroupSkipped();
    return { staged: [], allFailed: true };
  }

  return { staged: stagedFiles, allFailed: false };
}

// ---------------------------------------------------------------------------
// Smart scope & description helpers (mirrors index.ts)
// ---------------------------------------------------------------------------

/**
 * Find the longest common ancestor directory from a list of directory paths.
 * Returns undefined when files are in unrelated directory trees.
 */
export function findCommonAncestor(dirs: string[]): string | undefined {
  if (dirs.length === 0) return undefined;

  const segments = dirs.map((d) => d.split("/"));
  const common = segments[0].slice();

  for (let i = 1; i < segments.length; i++) {
    const other = segments[i];
    let j = 0;
    while (
      j < common.length &&
      j < other.length &&
      common[j] === other[j]
    ) {
      j++;
    }
    common.length = j;
    if (common.length === 0) return undefined;
  }

  return common.join("/");
}

/**
 * Generate a concise description of changes by extracting meaningful
 * keywords from file names. Avoids generic "update N modules".
 */
export function summarizeChanges(
  files: string[],
  _diffContent: string,
  scope?: string,
): string {
  if (files.length === 0) return "update";
  if (files.length === 1) {
    return `update ${path.basename(files[0])}`;
  }

  // Collect meaningful terms from file stems
  const terms: string[] = [];
  const seen = new Set<string>();

  for (const f of files) {
    const stem = path.basename(f).replace(/\.[^.]+$/, "");
    // Skip boilerplate files
    if (
      stem === "__init__" ||
      stem === "conftest" ||
      stem === "index"
    )
      continue;
    // Remove test_/e2e_ prefix, convert separators to spaces
    const cleaned = stem
      .replace(/^test[-_]/, "")
      .replace(/^e2e[-_]/, "")
      .replace(/[-_]/g, " ")
      .trim();
    if (cleaned.length < 2) continue;
    const key = cleaned.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    terms.push(cleaned);
  }

  const maxTerms = 6;
  let desc = terms.slice(0, maxTerms).join(", ");

  // Append "and tests" if test files present but not captured in terms
  const hasTests = files.some(
    (f) => /\.(test|spec|e2e)\./.test(f) || /\/test_/.test(f),
  );
  if (hasTests && !desc.toLowerCase().includes("test")) {
    desc += ", and tests";
  }

  if (scope) {
    const moduleName = scope.split("/").pop() || scope;
    return `update ${moduleName}: ${desc}`;
  }

  return `update ${desc}`;
}

// ---------------------------------------------------------------------------
// Deterministic commit message (fallback when no SDK)
// ---------------------------------------------------------------------------

export function deterministicCommitMessage(
  diffStat: string,
  diffContent: string,
  files: string[],
): string {
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

  // Compute smart scope: longest common ancestor directory, or omit
  const dirs = files.map((f) => path.dirname(f)).filter((d) => d !== ".");
  const scope = findCommonAncestor(dirs);

  // Generate a descriptive summary from file names
  const desc = summarizeChanges(files, diffContent, scope);

  const scopePart = scope ? `(${scope})` : "";
  const header = `${type}${scopePart}: ${desc}`;

  if (!diffStat.trim()) return header;

  // Body: description line + file list
  const bodyLines: string[] = [desc, ""];
  for (const f of files) {
    const statLine = diffStat
      .split("\n")
      .find((l) => l.trim().startsWith(f));
    const changes = statLine?.match(/(\d+) insertions?|\d+ deletions?/g);
    bodyLines.push(`- ${f}${changes ? ` (${changes.join(", ")})` : ""}`);
  }
  const body = bodyLines.join("\n");

  return `${header}\n\n${body}`;
}

// ---------------------------------------------------------------------------
// Subagent-based message generation (SDK-dependent)
// ---------------------------------------------------------------------------

let sdkAvailable = false;
let createAgentSessionFn: any = null;
let SessionManagerCls: any = null;
let SettingsManagerCls: any = null;

async function tryLoadSDK(): Promise<boolean> {
  if (sdkAvailable) return true;
  // Attempt 1: ESM dynamic import (works in native ESM contexts)
  try {
    const sdk = await import("@earendil-works/pi-coding-agent");
    createAgentSessionFn = sdk.createAgentSession;
    SessionManagerCls = sdk.SessionManager;
    SettingsManagerCls = sdk.SettingsManager;
    sdkAvailable = true;
    return true;
  } catch {
    // ESM import failed — attempt CJS require() as fallback.
    // The SDK package exports only ESM, but in jiti/fork contexts
    // CJS require() may resolve where ESM dynamic import does not.
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const sdk = require("@earendil-works/pi-coding-agent");
      createAgentSessionFn = sdk.createAgentSession;
      SessionManagerCls = sdk.SessionManager;
      SettingsManagerCls = sdk.SettingsManager;
      sdkAvailable = true;
      return true;
    } catch {
      return false;
    }
  }
}

function makeResourceLoader() {
  return {
    getExtensions: () => ({
      extensions: [],
      errors: [],
      runtime: { getTools: () => [], getCommands: () => [] },
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
 * Generate a commit message using a subagent (if SDK available).
 * Falls back to deterministic message on any failure.
 */
export async function generateCommitMessage(
  diffStat: string,
  diffContent: string,
  files: string[],
  repoDir: string,
  subagentModel?: string,
  onProgress?: (output: string[]) => void,
  subagentThinkingLevel?: string,
): Promise<string> {
  const _sdkOk = await tryLoadSDK();
  if (!_sdkOk || !subagentModel) {
    console.error(
      `[pi-committer] DIAG: subagent message generation skipped — ${
        !_sdkOk ? "SDK unavailable" : "no model configured"
      } — falling back to deterministic`,
    );
    return deterministicCommitMessage(diffStat, diffContent, files);
  }

  const truncatedDiff =
    diffContent.length > 8000
      ? diffContent.slice(0, 8000) + "\n... (truncated)"
      : diffContent;

  const prompt = [
    "Generate a conventional commit message from this git diff.",
    "",
    "Format:",
    "<type>(<scope>): <short description>",
    "",
    "<detailed body explaining what changed and why>",
    "",
    "Rules:",
    "- Type must be one of: feat, fix, chore, docs, refactor, test, style, perf, ci, build, revert",
    "- Scope: use the single most-specific directory that groups the changes (e.g. 'api', 'config', 'exposure'). NEVER comma-join multiple scopes. If files span unrelated directories, OMIT scope entirely.",
    "- Description: a SHORT imperative phrase summarizing what was done. Be specific: 'add regression pipeline and tests', not 'update 27 modules'.",
    "- Max 72 chars for the header line (type + scope + description combined).",
    "- Body: a brief paragraph explaining what changed and why, then a blank line, then a bullet list of the changed files.",
    "- Output ONLY the commit message, nothing else.",
    "",
    "Diff stat:",
    diffStat,
    "",
    "Full diff:",
    truncatedDiff,
  ].join("\n");

  try {
    // Resolve model
    let model: any = undefined;
    if (subagentModel) {
      const slash = subagentModel.indexOf("/");
      if (slash > 0) {
        const provider = subagentModel.slice(0, slash);
        const id = subagentModel.slice(slash + 1);
        model = { provider, id };
      }
    }

    const cas = createAgentSessionFn;
    const result = await cas({
      cwd: repoDir,
      model,
      thinkingLevel: subagentThinkingLevel as any,
      modelRegistry: {
        getAvailable: () => (model ? [model] : []),
        find: (p: string, i: string) => {
          if (model && model.provider === p && model.id === i) return model;
          return undefined;
        },
      },
      resourceLoader: makeResourceLoader(),
      sessionManager: SessionManagerCls.inMemory(repoDir),
      settingsManager: SettingsManagerCls.inMemory({
        compaction: { enabled: false },
      }),
      tools: [],
    });

    const session = result.session;
    const outputParts: string[] = [];

    const unsubscribe = session.subscribe((event: any) => {
      if (event.type === "message_end") {
        if (event.message?.role !== "assistant") return;
        for (const part of event.message.content ?? []) {
          if (part.type === "text" && typeof part.text === "string") {
            outputParts.push(part.text);
          }
        }
        if (typeof onProgress === "function") {
          const fullText = outputParts.join("\n\n");
          onProgress(fullText.split("\n").filter((l: string) => l.trim()).slice(-8));
        }
        return;
      }
      if (event.type === "message_update" && typeof onProgress === "function") {
        const message = event.message as any;
        if (message?.role === "assistant") {
          const recentLines: string[] = [];
          for (const part of message.content ?? []) {
            if (part.type === "text" && typeof part.text === "string" && part.text.trim()) {
              recentLines.push(...part.text.split("\n").filter((l: string) => l.trim()));
            }
          }
          if (recentLines.length > 0) {
            onProgress(recentLines.slice(-5));
          }
        }
      }
    });

    try {
      if (aborted) return deterministicCommitMessage(diffStat, diffContent, files);
      await session.prompt(prompt);
    } finally {
      unsubscribe();
    }

    const generated = outputParts.join("\n\n").trim();
    if (generated.length > 10) return generated;
    console.error(
      `[pi-committer] DIAG: worker subagent returned empty/short output (${generated.length} chars) — falling back to deterministic`,
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(
      `[pi-committer] DIAG: worker subagent message generation threw — falling back to deterministic (${msg})`,
    );
  }

  return deterministicCommitMessage(diffStat, diffContent, files);
}

/**
 * Generate commit groups using a subagent (if SDK available).
 */
export async function generateCommitGroups(
  diffStat: string,
  diffContent: string,
  allFiles: string[],
  repoDir: string,
  subagentModel?: string,
  onProgress?: (output: string[]) => void,
  subagentThinkingLevel?: string,
): Promise<Array<{ message: string; files: string[] }>> {
  // Fallback: single group (SDK not available or no model configured)
  const _sdkOk = await tryLoadSDK();
  if (!_sdkOk || !subagentModel) {
    console.error(
      `[pi-committer] DIAG: worker subagent grouping skipped — ${
        !_sdkOk ? "SDK unavailable" : "no model configured"
      } — falling back to single commit`,
    );
    const message = deterministicCommitMessage(diffStat, diffContent, allFiles);
    return [{ message, files: [...allFiles] }];
  }

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
    "- Scope: use the single most-specific directory for each group (e.g. 'api', 'exposure', 'config'). NEVER comma-join multiple scopes. If files in a group span unrelated directories, OMIT scope.",
    "- Description: a SHORT imperative phrase summarizing what each group does. Be specific: 'add regression pipeline and tests', not 'update 27 modules'.",
    "- Max 72 chars per header line (type + scope + description combined).",
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
    let model: any = undefined;
    if (subagentModel) {
      const slash = subagentModel.indexOf("/");
      if (slash > 0) {
        model = {
          provider: subagentModel.slice(0, slash),
          id: subagentModel.slice(slash + 1),
        };
      }
    }

    const cas = createAgentSessionFn;
    const result = await cas({
      cwd: repoDir,
      model,
      thinkingLevel: subagentThinkingLevel as any,
      modelRegistry: {
        getAvailable: () => (model ? [model] : []),
        find: (p: string, i: string) => {
          if (model && model.provider === p && model.id === i) return model;
          return undefined;
        },
      },
      resourceLoader: makeResourceLoader(),
      sessionManager: SessionManagerCls.inMemory(repoDir),
      settingsManager: SettingsManagerCls.inMemory({
        compaction: { enabled: false },
      }),
      tools: [],
    });

    const session = result.session;
    const outputParts: string[] = [];

    const unsubscribe = session.subscribe((event: any) => {
      if (event.type === "message_end") {
        if (event.message?.role !== "assistant") return;
        for (const part of event.message.content ?? []) {
          if (part.type === "text" && typeof part.text === "string") {
            outputParts.push(part.text);
          }
        }
        const fullText = outputParts.join("\n\n");
        const lines = fullText.split("\n").filter((l: string) => l.trim());
        if (typeof onProgress === "function") {
          onProgress(lines.slice(-8));
        }
        return;
      }
      if (event.type === "message_update" && typeof onProgress === "function") {
        const message = event.message as any;
        if (message?.role === "assistant") {
          const recentLines: string[] = [];
          for (const part of message.content ?? []) {
            if (part.type === "text" && typeof part.text === "string" && part.text.trim()) {
              recentLines.push(...part.text.split("\n").filter((l: string) => l.trim()));
            }
          }
          if (recentLines.length > 0) {
            onProgress(recentLines.slice(-5));
          }
        }
      }
    });

    try {
      if (aborted) {
        return [{ message: deterministicCommitMessage(diffStat, diffContent, allFiles), files: [...allFiles] }];
      }
      await session.prompt(prompt);
    } finally {
      unsubscribe();
    }

    const output = outputParts.join("\n\n").trim();
    if (output.length < 20) {
      console.error(
        `[pi-committer] DIAG: worker subagent grouping returned empty/short output (${output.length} chars) — falling back to single commit`,
      );
      return [{ message: deterministicCommitMessage(diffStat, diffContent, allFiles), files: [...allFiles] }];
    }

    // Parse commit groups
    const groups = parseCommitGroups(output, allFiles);

    // Validate: every file should be covered
    const covered = new Set<string>();
    for (const g of groups) {
      for (const f of g.files) covered.add(f);
    }
    const uncovered = allFiles.filter((f) => !covered.has(f));
    if (uncovered.length > 0 && groups.length > 0) {
      const last = groups[groups.length - 1];
      last.files.push(...uncovered);
      last.message += `\n\n(additional changes: ${uncovered.join(", ")})`;
    }

    if (groups.length === 0) {
      console.error(
        `[pi-committer] DIAG: worker subagent grouping produced 0 parseable groups — falling back to single commit`,
      );
      return [{ message: deterministicCommitMessage(diffStat, diffContent, allFiles), files: [...allFiles] }];
    }

    return groups;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(
      `[pi-committer] DIAG: worker subagent grouping threw — falling back to single commit (${msg})`,
    );
    return [{ message: deterministicCommitMessage(diffStat, diffContent, allFiles), files: [...allFiles] }];
  }
}

/**
 * Parse commit groups from subagent output.
 */
export function parseCommitGroups(
  output: string,
  allFiles: string[],
): Array<{ message: string; files: string[] }> {
  const groups: Array<{ message: string; files: string[] }> = [];

  // Split on "--- COMMIT GROUP N ---" markers
  const sections = output.split(/---\s*COMMIT\s*GROUP\s*\d+\s*---/);

  for (const section of sections) {
    const trimmed = section.trim();
    if (!trimmed) continue;

    // Extract message (everything up to "Files:")
    const filesMatch = trimmed.match(/Files:\s*(.+)/);
    const messagePart = filesMatch
      ? trimmed.slice(0, filesMatch.index).trim()
      : trimmed;

    // Extract file list
    let fileList: string[] = [];
    if (filesMatch) {
      fileList = filesMatch[1]
        .split(",")
        .map((f) => f.trim())
        .filter(Boolean)
        // Only keep files that are actually in the changed set
        .filter((f) => allFiles.includes(f));
    }

    if (messagePart && fileList.length > 0) {
      groups.push({ message: messagePart, files: fileList });
    }
  }

  // If no groups parsed but there are sections, try simpler approach
  if (groups.length === 0 && sections.length > 1) {
    for (const section of sections) {
      const trimmed = section.trim();
      if (!trimmed) continue;
      // Extract file list after "Files:"
      const filesMatch = trimmed.match(/Files:\s*(.+)/);
      let fileList: string[] = [];
      if (filesMatch) {
        fileList = filesMatch[1]
          .split(",")
          .map((f) => f.trim())
          .filter(Boolean)
          // Only keep files that are actually in the changed set
          .filter((f) => allFiles.includes(f));
      }
      // Extract message (all lines before "Files:")
      const msgLines: string[] = [];
      for (const line of trimmed.split("\n")) {
        if (line.startsWith("Files:")) break;
        if (line.trim()) msgLines.push(line);
      }
      const message = msgLines.join("\n").trim();
      if (message && fileList.length > 0) {
        groups.push({ message, files: fileList });
      }
    }
  }

  return groups;
}

// ---------------------------------------------------------------------------
// Single commit
// ---------------------------------------------------------------------------

export interface CommitCallbacks {
  onProgress?: (p: WorkerProgress) => void;
  onCommit?: (entry: CommitLogEntry) => void;
}

export async function doSingleCommit(
  dir: string,
  ctx: any,
  files: string[],
  params: CommitWorkerParams,
  ipc?: CommitCallbacks,
  skipSubagent = false,
): Promise<CommitLogEntry | undefined> {
  // Batch-stage all files (larger batch = fewer subprocess calls)
  const batchSize = 5000;
  for (let i = 0; i < files.length; i += batchSize) {
    const batch = files.slice(i, i + batchSize);
    const quoted = batch.map((f) => JSON.stringify(f)).join(" ");
    try {
      execSync(`git add --ignore-errors -- ${quoted}`, { cwd: dir, stdio: "pipe" });
    } catch {
      // --ignore-errors can exit non-zero; that's fine.
    }
  }

  const diffStat = execSync("git diff --cached --stat", {
    cwd: dir,
    encoding: "utf-8",
    maxBuffer: 10 * 1024 * 1024,
    stdio: ["ignore", "pipe", "ignore"],
  }).trim();

  if (!diffStat) {
    throw new Error(
      `No changes to stage — all ${files.length} file(s) could not be staged`,
    );
  }

  const diffContent = getDiffContent(dir);

  // Generate commit message — skip subagent for small change sets
  const message = await generateCommitMessage(
    diffStat,
    diffContent,
    files,
    dir,
    skipSubagent ? undefined : params.subagentModel,
    (output) => {
      const onProg = ipc?.onProgress ?? sendProgress;
      onProg({
        phase: "committing",
        statusMessage: `Generating commit message for ${files.length} file(s)...`,
        subagent: { recentOutput: output },
        totalCommits: 1,
        completedCommits: 0,
      });
    },
  );

  if (aborted) {
    unstageAll(dir);
    return undefined;
  }

  const finalMessage = message.length > 10 ? message : `chore: update ${files.length} file(s)`;

  execSync("git commit -F -", {
    cwd: dir,
    encoding: "utf-8",
    stdio: ["pipe", "pipe", "ignore"],
    input: finalMessage,
  });

  const hash = getHeadHash(dir);
  return { hash, message: finalMessage, success: true };
}

// ---------------------------------------------------------------------------
// Grouped commits
// ---------------------------------------------------------------------------

export async function doGroupedCommits(
  dir: string,
  ctx: any,
  allFiles: string[],
  params: CommitWorkerParams,
  ipc?: CommitCallbacks,
): Promise<{ commitCount: number; commitLog: CommitLogEntry[]; warnings: string[] }> {
  const groups = await generateCommitGroups(
    params.diffStat,
    params.diffContent,
    allFiles,
    dir,
    params.subagentModel,
    (output) => {
      const onProgAnalyze = ipc?.onProgress ?? sendProgress;
      onProgAnalyze({
        phase: "analyzing",
        fileCount: allFiles.length,
        statusMessage: `Analyzing ${allFiles.length} file(s) for logical commit grouping...`,
        subagent: { recentOutput: output },
      });
    },
    params.subagentThinkingLevel,
  );

  if (aborted) {
    unstageAll(dir);
    return { commitCount: 0, commitLog: [], warnings: [] };
  }

  let commitCount = 0;
  const commitLog: CommitLogEntry[] = [];
  const warnings: string[] = [];
  const warnedFiles = new Set<string>();

  for (let i = 0; i < groups.length; i++) {
    if (aborted) {
      unstageAll(dir);
      return { commitCount, commitLog, warnings };
    }

    const group = groups[i];

    const groupFiles = filterGitignoredFiles(dir, group.files);
    if (groupFiles.length === 0) continue;

    // Batch-stage all changes via git add -A (handles deletions correctly),
    // then restrict to only this group's files.
    const { staged: stagedFiles, allFailed } = batchStageFilesForGroup(
      dir,
      groupFiles,
      (filePath, msg) => {
        const onProgErr = ipc?.onProgress ?? sendProgress;
        onProgErr({
          phase: "committing",
          statusMessage: `Skipping unstageable file: ${filePath} (${msg})`,
        });
        if (!warnedFiles.has(filePath)) {
          warnedFiles.add(filePath);
          warnings.push(`Skipping unstageable file: ${filePath} (${msg})`);
        }
      },
      () => {
        warnings.push("Skipping group \u2014 all files failed to stage");
      },
    );
    if (allFailed) continue;

    try {
      const diffStat = execSync("git diff --cached --stat", {
        cwd: dir,
        encoding: "utf-8",
        maxBuffer: 10 * 1024 * 1024,
        stdio: ["ignore", "pipe", "ignore"],
      }).trim();

      if (!diffStat) continue;

      const diffContent = getDiffContent(dir);

      // Generate commit message for this group
      const message = await generateCommitMessage(
        diffStat,
        diffContent,
        stagedFiles,
        dir,
        params.subagentModel,
        (output) => {
          const onProgGroup = ipc?.onProgress ?? sendProgress;
          onProgGroup({
            phase: "committing",
            subagent: { recentOutput: output },
            totalCommits: groups.length,
            completedCommits: commitCount,
            statusMessage: `Committing group ${commitCount + 1}/${groups.length}...`,
          });
        },
        params.subagentThinkingLevel,
      );

      if (aborted) {
        unstageAll(dir);
        return { commitCount, commitLog, warnings };
      }

      const finalMessage = message.length > 10 ? message : `chore: update ${stagedFiles.length} file(s)`;

      execSync("git commit -F -", {
        cwd: dir,
        encoding: "utf-8",
        stdio: ["pipe", "pipe", "ignore"],
        input: finalMessage,
      });

      const hash = getHeadHash(dir);
      const entry: CommitLogEntry = { hash, message: finalMessage, success: true };
      commitLog.push(entry);
      commitCount++;
      const onCommitEntry = ipc?.onCommit ?? sendCommit;
      onCommitEntry(entry);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      sendResultAndExit({ commitCount, commitLog, error: `Commit failed: ${msg}`, warnings }, 0);
      return { commitCount, commitLog, warnings };
    }
  }

  return { commitCount, commitLog, warnings };
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

process.on("message", async (msg: any) => {
  if (!msg || msg.type !== "start") return;

  const params: CommitWorkerParams = msg.params;
  const { dir, diffStat, diffContent, allFiles, stagedCommits, excludePatterns, minChanges, subagentGroupingMinFiles, subagentMessageMinFiles, subagentThinkingLevel } = params;

  let _warnings: string[] = [];

  try {
    // Check for abort before starting
    if (aborted) {
      unstageAll(dir);
      sendResultAndExit({ commitCount: 0, commitLog: [], error: "Cancelled." }, 0);
      return;
    }

    // Apply exclusion patterns
    let files = unstageExcludedFiles(dir, [...allFiles], excludePatterns);
    files = filterGitignoredFiles(dir, files);

    if (files.length === 0) {
      unstageAll(dir);
      sendResultAndExit({ commitCount: 0, commitLog: [] }, 0);
      return;
    }

    // Check min changes
    if (files.length < minChanges) {
      unstageAll(dir);
      sendResultAndExit({ commitCount: 0, commitLog: [] }, 0);
      return;
    }

    // Show progress immediately (mimics sync path's initial widget state).
    // Only show 'analyzing' phase when the subagent will actually be called.
    const useSubagent = stagedCommits && files.length > 1 && files.length >= subagentGroupingMinFiles;
    sendProgress({
      phase: useSubagent ? "analyzing" : "committing",
      fileCount: files.length,
      statusMessage: useSubagent
        ? `Analyzing ${files.length} file(s) for logical commit grouping...`
        : `Generating commit message for ${files.length} file(s)...`,
    });

    if (aborted) {
      unstageAll(dir);
      sendResultAndExit({ commitCount: 0, commitLog: [], error: "Cancelled." }, 0);
      return;
    }

    const ctx = {}; // Minimal context (git helpers don't need a context)

    let commitCount = 0;
    let commitLog: CommitLogEntry[] = [];

    _warnings = [];

    if (stagedCommits && files.length > 1 && files.length >= params.subagentGroupingMinFiles) {
      // ---- Agent-decided staged commit mode ----
      const result = await doGroupedCommits(dir, ctx, files, params, { onProgress: sendProgress, onCommit: sendCommit });
      commitCount = result.commitCount;
      commitLog = result.commitLog;
      _warnings = result.warnings;
    } else {
      // ---- Single commit mode ----
      // Small change sets below the message threshold skip the subagent entirely.
      // Above the message threshold but below the grouping threshold, the subagent
      // generates a single commit message (good descriptions, no grouping).
      const skipSubagent = files.length < subagentMessageMinFiles;
      const entry = await doSingleCommit(dir, ctx, files, params, { onProgress: sendProgress }, skipSubagent);
      if (entry) {
        commitCount = 1;
        commitLog = [entry];
        sendCommit(entry);
      }
    }

    if (aborted) {
      unstageAll(dir);
      sendResultAndExit({ commitCount, commitLog, error: "Cancelled." }, 0);
      return;
    }

    // Success
    sendResultAndExit({ commitCount, commitLog, warnings: _warnings }, 0);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    sendResultAndExit({ commitCount: 0, commitLog: [], error: msg, warnings: _warnings }, 0);
  }
});



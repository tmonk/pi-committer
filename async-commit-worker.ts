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
  if (process.send) {
    process.send({ type: "result", commitCount: 0, commitLog: [], error: "Worker timed out after 5 minutes." });
  }
  process.exit(1);
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
}): void {
  send({ type: "result", ...result });
}

// ---------------------------------------------------------------------------
// Pure git helpers (execSync-based, no SDK needed)
// ---------------------------------------------------------------------------

function git(...args: string[]): string {
  return execSync(`git ${args.join(" ")}`, {
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "ignore"],
  }).trim();
}

function gitCwd(dir: string, ...args: string[]): string {
  return execSync(`git ${args.join(" ")}`, {
    cwd: dir,
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "ignore"],
  }).trim();
}

function getHeadHash(dir: string): string {
  return gitCwd(dir, "rev-parse", "HEAD");
}

function unstageAll(dir: string): void {
  try {
    gitCwd(dir, "reset", "HEAD", "--", ".");
  } catch {
    // Ignore errors (e.g., no commits yet)
  }
}

function getDiffContent(dir: string): string {
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

function getChangedFiles(diffStat: string): string[] {
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

function isGitignored(dir: string, file: string): boolean {
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

function filterGitignoredFiles(dir: string, files: string[]): string[] {
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

function unstageExcludedFiles(
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

  for (const f of toUnstage) {
    try {
      execSync(`git reset HEAD -- "${f}"`, { cwd: dir, stdio: "ignore" });
    } catch {
      // File might not be staged, ignore
    }
  }

  return toKeep;
}

// ---------------------------------------------------------------------------
// Deterministic commit message (fallback when no SDK)
// ---------------------------------------------------------------------------

function deterministicCommitMessage(
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
// Subagent-based message generation (SDK-dependent)
// ---------------------------------------------------------------------------

let sdkAvailable = false;
let createAgentSessionFn: any = null;
let SessionManagerCls: any = null;
let SettingsManagerCls: any = null;

async function tryLoadSDK(): Promise<boolean> {
  if (sdkAvailable) return true;
  try {
    const sdk = await import("@earendil-works/pi-coding-agent");
    createAgentSessionFn = sdk.createAgentSession;
    SessionManagerCls = sdk.SessionManager;
    SettingsManagerCls = sdk.SettingsManager;
    sdkAvailable = true;
    return true;
  } catch {
    return false;
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
async function generateCommitMessage(
  diffStat: string,
  diffContent: string,
  files: string[],
  repoDir: string,
  subagentModel?: string,
  onProgress?: (output: string[]) => void,
): Promise<string> {
  if (!(await tryLoadSDK())) {
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
        if (onProgress) {
          const fullText = outputParts.join("\n\n");
          onProgress(fullText.split("\n").filter((l: string) => l.trim()).slice(-8));
        }
        return;
      }
      if (event.type === "message_update" && onProgress) {
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
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // Fall through to deterministic
  }

  return deterministicCommitMessage(diffStat, diffContent, files);
}

/**
 * Generate commit groups using a subagent (if SDK available).
 */
async function generateCommitGroups(
  diffStat: string,
  diffContent: string,
  allFiles: string[],
  repoDir: string,
  subagentModel?: string,
  onProgress?: (output: string[]) => void,
): Promise<Array<{ message: string; files: string[] }>> {
  // Fallback: single group
  if (!(await tryLoadSDK())) {
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
        onProgress?.(lines.slice(-8));
        return;
      }
      if (event.type === "message_update" && onProgress) {
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
      return [{ message: deterministicCommitMessage(diffStat, diffContent, allFiles), files: [...allFiles] }];
    }

    return groups;
  } catch {
    return [{ message: deterministicCommitMessage(diffStat, diffContent, allFiles), files: [...allFiles] }];
  }
}

/**
 * Parse commit groups from subagent output.
 */
function parseCommitGroups(
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
        .filter(Boolean);
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
          .filter(Boolean);
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

async function doSingleCommit(
  dir: string,
  ctx: any,
  files: string[],
  params: CommitWorkerParams,
): Promise<CommitLogEntry | undefined> {
  // Stage all files
  for (const f of files) {
    execSync(`git add -- "${f}"`, { cwd: dir, stdio: "ignore" });
  }

  const diffStat = execSync("git diff --cached --stat", {
    cwd: dir,
    encoding: "utf-8",
    maxBuffer: 10 * 1024 * 1024,
    stdio: ["ignore", "pipe", "ignore"],
  }).trim();

  if (!diffStat) return undefined;

  const diffContent = getDiffContent(dir);

  // Generate commit message
  const message = await generateCommitMessage(
    diffStat,
    diffContent,
    files,
    dir,
    params.subagentModel,
    (output) => {
      sendProgress({
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

async function doGroupedCommits(
  dir: string,
  ctx: any,
  allFiles: string[],
  params: CommitWorkerParams,
): Promise<{ commitCount: number; commitLog: CommitLogEntry[] }> {
  const groups = await generateCommitGroups(
    params.diffStat,
    params.diffContent,
    allFiles,
    dir,
    params.subagentModel,
    (output) => {
      sendProgress({
        phase: "analyzing",
        fileCount: allFiles.length,
        statusMessage: `Analyzing ${allFiles.length} file(s) for logical commit grouping...`,
        subagent: { recentOutput: output },
      });
    },
  );

  if (aborted) {
    unstageAll(dir);
    return { commitCount: 0, commitLog: [] };
  }

  let commitCount = 0;
  const commitLog: CommitLogEntry[] = [];

  for (let i = 0; i < groups.length; i++) {
    if (aborted) {
      unstageAll(dir);
      return { commitCount, commitLog };
    }

    const group = groups[i];

    // Only stage this group's files
    unstageAll(dir);
    const groupFiles = filterGitignoredFiles(dir, group.files);
    if (groupFiles.length === 0) continue;

    for (const f of groupFiles) {
      execSync(`git add -- "${f}"`, { cwd: dir, stdio: "ignore" });
    }

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
        groupFiles,
        dir,
        params.subagentModel,
        (output) => {
          sendProgress({
            phase: "committing",
            subagent: { recentOutput: output },
            totalCommits: groups.length,
            completedCommits: commitCount,
            statusMessage: `Committing group ${commitCount + 1}/${groups.length}...`,
          });
        },
      );

      if (aborted) {
        unstageAll(dir);
        return { commitCount, commitLog };
      }

      const finalMessage = message.length > 10 ? message : `chore: update ${groupFiles.length} file(s)`;

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
      sendCommit(entry);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      sendResult({ commitCount, commitLog, error: `Commit failed: ${msg}` });
      clearWorkerTimeout();
      process.exit(0);
      return { commitCount, commitLog };
    }
  }

  return { commitCount, commitLog };
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

process.on("message", async (msg: any) => {
  if (!msg || msg.type !== "start") return;

  const params: CommitWorkerParams = msg.params;
  const { dir, diffStat, diffContent, allFiles, stagedCommits, excludePatterns, minChanges } = params;

  try {
    // Check for abort before starting
    if (aborted) {
      unstageAll(dir);
      sendResult({ commitCount: 0, commitLog: [], error: "Cancelled." });
      process.exit(0);
      return;
    }

    // Apply exclusion patterns
    let files = unstageExcludedFiles(dir, [...allFiles], excludePatterns);
    files = filterGitignoredFiles(dir, files);

    if (files.length === 0) {
      unstageAll(dir);
      sendResult({ commitCount: 0, commitLog: [] });
      process.exit(0);
      return;
    }

    // Check min changes
    if (files.length < minChanges) {
      unstageAll(dir);
      sendResult({ commitCount: 0, commitLog: [] });
      process.exit(0);
      return;
    }

    // Show analyzing progress immediately (mimics sync path's initial widget state)
    sendProgress({
      phase: "analyzing",
      fileCount: files.length,
      statusMessage: `Analyzing ${files.length} file(s) for logical commit grouping...`,
    });

    if (aborted) {
      unstageAll(dir);
      sendResult({ commitCount: 0, commitLog: [], error: "Cancelled." });
      clearWorkerTimeout();
      process.exit(0);
      return;
    }

    const ctx = {}; // Minimal context (git helpers don't need a context)

    let commitCount = 0;
    let commitLog: CommitLogEntry[] = [];

    if (stagedCommits && files.length > 1) {
      // ---- Agent-decided staged commit mode ----
      const result = await doGroupedCommits(dir, ctx, files, params);
      commitCount = result.commitCount;
      commitLog = result.commitLog;
    } else {
      // ---- Single commit mode ----
      const entry = await doSingleCommit(dir, ctx, files, params);
      if (entry) {
        commitCount = 1;
        commitLog = [entry];
        sendCommit(entry);
      }
    }

    if (aborted) {
      unstageAll(dir);
      sendResult({ commitCount, commitLog, error: "Cancelled." });
      process.exit(0);
      return;
    }

    // Success
    sendResult({ commitCount, commitLog });
    process.exit(0);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    sendResult({ commitCount: 0, commitLog: [], error: msg });
    clearWorkerTimeout();
    process.exit(1);
  }
});



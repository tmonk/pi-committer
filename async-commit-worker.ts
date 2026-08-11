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

/**
 * Resolved subagent model forwarded from the main process over IPC.
 *
 * The main process resolves the full pi `Model` (mirroring the sync path's
 * resolveSubagentModel) and structured-clones it into the worker params; the
 * worker passes it to createAgentSession as-is. Only `provider`/`id` are
 * required by the worker contract, but the full serializable Model travels
 * with it so the session gets every field (api, baseUrl, reasoning, ...).
 */
export interface WorkerSubagentModel {
  provider: string;
  id: string;
  /** Remaining full pi Model fields (name, api, baseUrl, reasoning, cost, ...). */
  [key: string]: unknown;
}

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
  /** Resolved subagent model (full pi Model, JSON-safe) from the main process */
  subagentModel?: WorkerSubagentModel;
  /**
   * Session context (goal/task + recent conversation) collected by the main
   * process when context_enabled is on and no verbatim message is supplied.
   * Empty string = no context (setting off, unavailable, or not collected).
   */
  sessionContext?: string;
  /** Minimum changed files to use the subagent for grouping */
  subagentGroupingMinFiles: number;
  /** Minimum changed files to use the subagent for a single commit message */
  subagentMessageMinFiles: number;
  /** Thinking level for the subagent session (off, minimal, low, medium, high, xhigh) */
  subagentThinkingLevel?: string;
  /**
   * When true, sample the repo's recent commit history (git log) and use it
   * as style context for generated messages. Opt-in, default false.
   */
  matchRepoStyle: boolean;
  /**
   * When true, the content-driven deterministic commit-message generator is
   * available as a fallback (small change sets + garbled-output regeneration).
   * When false (default), the subagent is required for every commit and an
   * unavailable/failed/invalid message blocks the commit, leaving changes
   * staged. Mirrors the deterministic_fallback config setting.
   */
  deterministicFallback: boolean;
  /**
   * Optional commit-message intent passed by the agent via commit_changes:
   * - `message`: short freeform summary of what the commit message should
   *   include or how it should be structured (guides the subagent prompt).
   * - `verbatim`: exact commit message text to use as-is, overriding
   *   subagent/deterministic generation. Never edited or reformatted.
   */
  messageRequest?: MessageRequest;
}

interface MessageRequest {
  message?: string;
  verbatim?: string;
}

export interface CommitLogEntry {
  hash: string;
  message: string;
  success: boolean;
}

export interface WorkerProgress {
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

/** Validate that captured git diff content looks like legitimate git diff output. */
export function isValidDiffContent(content: string): boolean {
  if (!content) return true; // empty diff is fine (no changes)
  // Genuine git diff output starts with "diff --git" at the beginning or after context lines.
  const lines = content.split("\n");
  return lines.some((l) => l.startsWith("diff --git"));
}

/** Validate that captured git diff stat looks legitimate. */
export function isValidDiffStat(stat: string): boolean {
  if (!stat) return true; // empty stat is fine (no changes)
  const lines = stat.split("\n").filter((l) => l.trim().length > 0);
  return lines.every(
    (l) =>
      /\S+\s+\|\s+\d+/.test(l) ||
      /\d+ files? changed/.test(l) ||
      /\d+ deletions?/.test(l) ||
      /\d+ insertions?/.test(l) ||
      /\d+ renames?/.test(l),
  );
}

/**
 * Validate that a commit message looks like a legitimate conventional commit.
 */
export function isValidCommitMessage(message: string, strict = false): boolean {
  if (typeof message !== "string") return false;
  if (message.length < 10) return false;

  const firstLine = message.split("\n")[0];
  const header = /^([a-z]+)(\([^)]+\))?: (.*)$/.exec(firstLine);
  if (!header) return false;

  const desc = header[3].trim();
  if (!desc) return false;
  // Comment-quoted or diff-artifact descriptions are always garbage
  // (e.g. `test: add # ntfy push (optional): ...`).
  if (/^[#\/\*+\-]/.test(desc)) return false;
  if (/^[\u2026.\-_\s]+$/.test(desc)) return false;
  const wordy = desc.replace(/[^\p{L}\p{N}]+/gu, "");
  if (wordy.length < 3) return false;

  // Raw diff lines must never appear inside a commit message.
  if (/^diff --git |^@@ |^index [0-9a-f]+\.\.[0-9a-f]+/m.test(message)) return false;

  if (strict) {
    // Over-truncated descriptions (ellipsis-terminated) are never committed.
    if (/\u2026\s*$/.test(desc) || /\.\.\.\s*$/.test(desc)) return false;
    // Generic filler — the description must say WHAT changed, not just
    // that files were touched. (Verbatim user messages skip this check.)
    if (
      /^(update|updated?|modify|modified?|change[d]?|adjust(ed)?|tweak(ed)?|cleanup|clean up|misc|various|stuff|things?|minor|small|improve[ds]?|bump|refresh|sync)\s*(\d+\s+)?(files?|modules?|things?|stuff|changes?|deps|dependencies?|config|settings?|code|all)?(\s+and\s+(more|other|misc))?\s*$/i.test(
        desc,
      )
    ) {
      return false;
    }
  }
  return true;
}

export function getDiffContent(dir: string): string {
  // Fast path: pipe the diff through execSync with a 10MB buffer.
  let content: string;
  try {
    content = execSync("git diff --cached", {
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
      content = readFileSync(diffFile, "utf-8").trim();
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  }
  // Validate that captured output looks like genuine git diff.
  if (!isValidDiffContent(content)) {
    console.error(
      "[pi-committer] DIAG: getDiffContent returned non-diff content — rejecting to prevent contamination",
    );
    return "";
  }
  return content;
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

/** One file's worth of parsed diff content. */
export interface DiffFileChange {
  /** File path from the diff (b/ side). */
  file: string;
  /** Meaningful added lines (content). */
  added: string[];
  /** Meaningful removed lines (content). */
  removed: string[];
  /** Raw added line count. */
  addedCount: number;
  /** Raw removed line count. */
  removedCount: number;
}

/** Drop noise lines that add no information to a commit message. */
function cleanDiffLine(line: string): string | undefined {
  const t = line.trim();
  if (!t) return undefined;
  if (t.length < 3) return undefined;
  if (/^[{}()\[\];,=+\-*/\\"'`|<>!?.@#%^&]+$/.test(t)) return undefined;
  if (/^diff --git /.test(t)) return undefined;
  if (/^index [0-9a-f]+\.\.[0-9a-f]+/.test(t)) return undefined;
  if (/^@@ /.test(t)) return undefined;
  if (/^(---|\+\+\+) /.test(t)) return undefined;
  return t;
}

/**
 * Parse a unified git diff into per-file change summaries with the actual
 * added/removed content lines. Used to derive detailed, content-driven
 * deterministic commit messages.
 */
export function parseDiffHunks(diffContent: string): DiffFileChange[] {
  const files: DiffFileChange[] = [];
  let current: DiffFileChange | null = null;
  let inHunk = false;

  for (const raw of diffContent.split("\n")) {
    if (raw.startsWith("diff --git ")) {
      if (current) files.push(current);
      const m = raw.match(/diff --git a\/(.*?) b\/(.*)/);
      current = {
        file: m ? m[2] : raw.slice("diff --git ".length),
        added: [],
        removed: [],
        addedCount: 0,
        removedCount: 0,
      };
      inHunk = false;
      continue;
    }
    if (!current) continue;
    if (raw.startsWith("@@ ")) {
      inHunk = true;
      continue;
    }
    if (!inHunk) continue;
    if (raw.startsWith("+++") || raw.startsWith("---")) continue;
    if (raw.startsWith("+")) {
      current.addedCount++;
      const cleaned = cleanDiffLine(raw.slice(1));
      if (cleaned && current.added.length < 8) current.added.push(cleaned);
      continue;
    }
    if (raw.startsWith("-")) {
      current.removedCount++;
      const cleaned = cleanDiffLine(raw.slice(1));
      if (cleaned && current.removed.length < 8) current.removed.push(cleaned);
      continue;
    }
    // context lines: nothing to record
  }
  if (current) files.push(current);
  return files;
}

/** Detect binary-only changes ("Binary files a/x and b/x differ"). */
export function hasBinaryChanges(diffContent: string): boolean {
  return /Binary files? .* differ/.test(diffContent);
}

/** First meaningful snippet across changed files (added preferred, then removed). */
/** Lines that carry no semantic content for a commit description. */
function isNoiseLine(line: string): boolean {
  const t = line.trim().toLowerCase();
  if (!t) return true;
  // Punctuation/formatting only.
  if (/^[{}()\[\];,=+\-*/\\"'`|<>!?.@#%^&]+$/.test(t)) return true;
  // Comments.
  if (/^(\/\/|#|\/\*|\*|\*\/|<!--)/.test(t)) return true;
  // Markdown table rows / diff-format separators.
  if (/^\|/.test(t) || /^\|[-\s|]+\|$/.test(t)) return true;
  // Imports / re-exports.
  if (/^(import\s|from\s+["']|require\s*\(|export\s*\{)/.test(t)) return true;
  // JS/React pragmas ("use strict", "use client", ...).
  if (/^["']?use (strict|client|server)["']?;?$/.test(t)) return true;
  // Config noise: JSON key: value (boilerplate keys), lockfile metadata.
  // Meaningful key=value assignments (e.g. `export NTFY_TOPIC=...`) are
  // informative — they ARE the content of a config change.
  if (/^["']?[a-z_][a-z0-9_]*["']?\s*:/.test(t)) return true; // JSON key
  if (/^(lockfile|package-lock|node_modules|resolved|integrity|sha512|version\s*=|dependencies\s*:|devDependencies\s*:|scripts\s*:)/.test(t)) return true;
  return false;
}

/** Paths whose lines should not dominate the description (config/dotfiles). */
function isConfigPath(file: string): boolean {
  return (
    /(^|\/)\.[a-z0-9-]+(\.example)?$/.test(file) ||
    /\.(json|toml|ya?ml|lock)$/.test(file) ||
    file.includes("config") ||
    file.includes("package")
  );
}

/** First informative line in a set of added/removed lines (skips noise). */
function firstInformativeLine(lines: string[]): string | undefined {
  for (const line of lines) {
    if (!isNoiseLine(line)) return line;
  }
  return undefined;
}

/** First meaningful snippet across changed files (added preferred, then removed). */
function firstMeaningfulSnippet(
  changes: DiffFileChange[],
): { snippet: string; verb: "add" | "remove" } | undefined {
  // Prefer informative content from CODE files; config/dotfile-only changes
  // still fall back to their own lines.
  const codeChanges = changes.filter((c) => !isConfigPath(c.file));
  for (const c of codeChanges) {
    const line = firstInformativeLine(c.added);
    if (line) return { snippet: line, verb: "add" };
  }
  for (const c of codeChanges) {
    const line = firstInformativeLine(c.removed);
    if (line) return { snippet: line, verb: "remove" };
  }
  for (const c of changes) {
    const line = firstInformativeLine(c.added);
    if (line) return { snippet: line, verb: "add" };
  }
  for (const c of changes) {
    const line = firstInformativeLine(c.removed);
    if (line) return { snippet: line, verb: "remove" };
  }
  return undefined;
}

/** Strip a leading action verb so headers never double-prefix ("add add ..."). */
function stripLeadingAction(snippet: string): string {
  return snippet.replace(
    /^(add(ed|s)?|remove(d|s)?|fix(ed|es)?|update[d]?|change[d]?|refactor(ed)?|implement(ed)?|new|support[s]?|enable[d]?|disable[d]?)\s+/i,
    "",
  );
}

/**
 * Derive a header description from actual diff content. Returns "" when the
 * diff has no extractable content (callers must then block the commit).
 */
function describeDiffContent(
  hunks: DiffFileChange[],
  files: string[],
  binaryOnly: boolean,
): string {
  if (binaryOnly) {
    // Binary content changed — the most detailed deterministic description possible
    const names = files
      .slice(0, 3)
      .map((f) => path.basename(f))
      .join(", ");
    return `update binary ${names}${files.length > 3 ? " and more" : ""}`;
  }
  const first = firstMeaningfulSnippet(hunks);
  if (!first) return "";
  // Drop declaration prefixes so headers read naturally ("add sendNotification()",
  // never "add def sendNotification()" or "add const retryCount = 3;").
  const declStripped = first.snippet.replace(
    /^(export\s+)?(async\s+)?(function|def|const|let|var|class|interface|type)\s+/,
    "",
  );
  const stripped = stripLeadingAction(declStripped);
  let snippet = (stripped || first.snippet).replace(/[;,.!?]+$/, "").trim();
  // Truncate cleanly at a word boundary (never mid-word).
  if (snippet.length > 58) {
    const cut = snippet.lastIndexOf(" ", 58);
    snippet = (cut > 30 ? snippet.slice(0, cut) : snippet.slice(0, 58)).trim() + "\u2026";
  }
  return `${first.verb} ${snippet}`;
}

/** Build the structured, always-present body for a deterministic message. */
function buildDeterministicBody(
  hunks: DiffFileChange[],
  files: string[],
  binaryOnly: boolean,
  desc: string,
): string {
  const totalAdd = hunks.reduce((n, h) => n + h.addedCount, 0);
  const totalDel = hunks.reduce((n, h) => n + h.removedCount, 0);
  const fileWord = files.length === 1 ? "file" : "files";
  const lines: string[] = [];

  if (binaryOnly) {
    lines.push(`Summary: binary content changed in ${files.length} ${fileWord}.`);
    for (const f of files.slice(0, 15)) {
      lines.push(`- ${f}: binary content changed`);
    }
    if (files.length > 15) lines.push(`- ... and ${files.length - 15} more`);
    return lines.join("\n");
  }

  lines.push(`Summary: ${desc} — ${files.length} ${fileWord}, +${totalAdd}/-${totalDel}.`);
  for (const h of hunks.slice(0, 15)) {
    const bits: string[] = [];
    const addLine = firstInformativeLine(h.added);
    const remLine = firstInformativeLine(h.removed);
    if (addLine) bits.push(`+${h.addedCount} ${addLine}`);
    if (remLine) bits.push(`-${h.removedCount} ${remLine}`);
    if (bits.length === 0 && h.addedCount > 0) bits.push(`+${h.addedCount} lines`);
    if (bits.length === 0 && h.removedCount > 0) bits.push(`-${h.removedCount} lines`);
    lines.push(`- ${h.file}: ${bits.join(", ")}`);
  }
  if (hunks.length > 15) lines.push(`- ... and ${hunks.length - 15} more files`);
  return lines.join("\n");
}

/** Detect the conventional type from files and diff content, constrained to repo style. */
function detectCommitType(
  diffContent: string,
  files: string[],
  style: RepoCommitStyle,
): string {
  const isTestFile = (f: string) =>
    /\.(test|spec|e2e)\./.test(f) || /(^|\/)(test|tests|__tests__)(\/|$)/.test(f);
  const isDocFile = (f: string) => /\.(md|txt|rst)$/.test(f) || f.includes("doc");
  const isConfigFile = (f: string) =>
    f.includes("config") ||
    f.includes("package") ||
    /\.(json|toml|ya?ml)$/.test(f) ||
    // Dotfiles like .envrc, .gitignore, .envrc.example
    /(^|\/)\.[a-z0-9-]+(\.example)?$/.test(f);

  const testFiles = files.filter(isTestFile);
  const docFiles = files.filter(isDocFile);
  const codeFiles = files.filter(
    (f) => !isTestFile(f) && !isDocFile(f) && !isConfigFile(f),
  );

  // Content evidence FIRST: analyze the actual added lines of the diff,
  // never the file names alone. A feature that ships with its tests is a
  // feat, not a test — the old test-regex-first ordering caused "test:"
  // headers on feature commits (e.g. `test: add # ntfy push ...`).
  const hunks = parseDiffHunks(diffContent).filter(
    (h) => files.length === 0 || files.includes(h.file),
  );
  const addedText = hunks.flatMap((h) => h.added).join("\n").toLowerCase();

  const hasFeatureSignal =
    /(^|\b)(feat|feature|implement|implemented|implements|introduce|introduces|introduced|adds?\b|new (api|endpoint|module|function|class|feature|command|flag))(\b|$)/.test(
      addedText,
    ) ||
    // New definitions/symbols in code lines.
    /^\s*(export\s+)?(async\s+)?function\s+|^\s*(export\s+)?class\s+|^\s*(export\s+)?(const|let|var)\s+[a-z_$][\w$]*\s*=\s*(async\s*)?\(|^\s*(export\s+)?interface\s+|^\s*def\s+[a-z_]\w*\s*\(/m.test(
      addedText,
    );

  const hasFixSignal =
    /(^|\b)(fix(es|ed|ing)?|bug|bugfix|crash|regression|workaround)(\b|$)/.test(addedText);

  let type: string;
  if (hasFeatureSignal && codeFiles.length > 0) {
    type = "feat";
  } else if (hasFixSignal && codeFiles.length > 0) {
    type = "fix";
  } else if (testFiles.length > 0 && codeFiles.length === 0) {
    // Test-only change: no production code touched.
    type = "test";
  } else if (testFiles.length > 0 && testFiles.length > codeFiles.length) {
    // Test-dominated change set (e.g. a test-suite overhaul with small
    // supporting edits) and no stronger code-content signal.
    type = "test";
  } else if (docFiles.length > 0 && codeFiles.length === 0 && testFiles.length === 0) {
    type = "docs";
  } else if (files.length > 0 && codeFiles.length === 0 && testFiles.length === 0 && docFiles.length === 0) {
    // Config/dotfile-only change.
    type = "chore";
  } else {
    type = "chore";
  }

  // Constrain to types the repo actually uses when style sampling is enabled:
  // if the heuristic type never appears in recent history, use the dominant one.
  if (style.types.length > 0 && !style.types.includes(type)) {
    let dominant = "";
    let max = 0;
    for (const [t, n] of Object.entries(style.typeCounts)) {
      if (n > max) {
        max = n;
        dominant = t;
      }
    }
    if (dominant) type = dominant;
  }
  return type;
}

/** Truncate a header to the conventional 72-char limit without losing the type/scope. */
function enforceHeaderLimit(header: string): string {
  if (header.length <= 72) return header;
  const colon = header.indexOf(": ");
  if (colon < 0) return header.slice(0, 72);
  const prefix = header.slice(0, colon + 2);
  const desc = header.slice(colon + 2);
  const maxDesc = Math.max(20, 72 - prefix.length - 1);
  return prefix + desc.slice(0, maxDesc).trim() + "\u2026";
}

// ---------------------------------------------------------------------------
// Repo style sampling (opt-in via config match_repo_style) and prompt builder
// ---------------------------------------------------------------------------

/** Style of recent commits in a repository, sampled via git log. */
export interface RepoCommitStyle {
  /** Full recent commit messages (header + body). */
  history: string[];
  /** Conventional types used in recent history. */
  types: string[];
  /** Type frequency counts (dominant type wins constraints). */
  typeCounts: Record<string, number>;
  /** Scopes used in recent history. */
  scopes: string[];
  /** Whether every sampled commit is header-only (no body). */
  headerOnly: boolean;
  /** First line of the most recent commit. */
  recentHeader: string;
}

/** Empty style — used when style sampling is disabled or a repo has no history. */
export const EMPTY_COMMIT_STYLE: RepoCommitStyle = {
  history: [],
  types: [],
  typeCounts: {},
  scopes: [],
  headerOnly: true,
  recentHeader: "",
};

/**
 * Sample the repo's recent commit style: the last `count` commit messages,
 * plus the conventional types and scopes they actually use. Used to make
 * generated messages consistent with the repository's commit history.
 * Only called when the opt-in `match_repo_style` config is enabled.
 */
export function sampleRepoCommitStyle(dir: string, count = 15): RepoCommitStyle {
  try {
    // NUL-separate messages (%x00) — blank lines are ambiguous because
    // message bodies also contain them.
    const raw = execSync(`git log -${count} --format=%x00%B`, {
      cwd: dir,
      encoding: "utf-8",
      maxBuffer: 10 * 1024 * 1024,
      stdio: ["ignore", "pipe", "ignore"],
    });
    if (!raw.trim()) return EMPTY_COMMIT_STYLE;

    const messages = raw
      .split("\x00")
      .map((m) => m.trim())
      .filter(Boolean)
      .slice(0, count);

    const types = new Set<string>();
    const typeCounts: Record<string, number> = {};
    const scopes = new Set<string>();
    let withBody = 0;

    for (const m of messages) {
      const first = m.split("\n")[0];
      const tm = first.match(/^([a-z]+)(?:\(([^)]+)\))?:/i);
      if (tm) {
        const t = tm[1].toLowerCase();
        types.add(t);
        typeCounts[t] = (typeCounts[t] ?? 0) + 1;
        if (tm[2]) {
          for (const s of tm[2].split(/[,\s]+/)) {
            if (s) scopes.add(s);
          }
        }
      }
      if (m.includes("\n")) withBody++;
    }

    return {
      history: messages,
      types: [...types],
      typeCounts,
      scopes: [...scopes],
      headerOnly: withBody === 0,
      recentHeader: messages[0]?.split("\n")[0] ?? "",
    };
  } catch {
    return EMPTY_COMMIT_STYLE;
  }
}

/**
 * Format the sampled repo style as guidance text for a subagent prompt.
 * Empty when there is no history to sample.
 */
export function formatStyleContext(style: RepoCommitStyle): string {
  if (style.history.length === 0) return "";
  const parts: string[] = [
    "Recent commit style in this repository — MATCH this style (types, scopes, tone):",
  ];
  for (const m of style.history.slice(0, 8)) {
    parts.push(m.split("\n")[0]);
  }
  if (style.types.length > 0) {
    parts.push(`Types used in this repo: ${style.types.join(", ")} — prefer these; deviate only when clearly necessary.`);
  }
  if (style.scopes.length > 0) {
    parts.push(`Scopes used in this repo: ${style.scopes.join(", ")} — prefer these when applicable.`);
  }
  return parts.join("\n");
}

/**
 * Build the subagent prompt for single-commit message generation.
 * Includes the diff, conventional-commit rules, detail requirements with
 * bad/good examples, and the sampled repo style when available.
 */
export function buildCommitMessagePrompt(
  diffStat: string,
  diffContent: string,
  opts: { style?: RepoCommitStyle; request?: MessageRequest; context?: string } = {},
): string {
  const { style = EMPTY_COMMIT_STYLE, request, context } = opts;
  const truncatedDiff =
    diffContent.length > 8000
      ? diffContent.slice(0, 8000) + "\n... (truncated)"
      : diffContent;

  const lines = [
    "Generate a conventional commit message from this git diff.",
    "",
    "Format:",
    "<type>(<scope>): <short description>",
    "",
    "<detailed body explaining what changed and why>",
    "",
    "Rules:",
    "- Type must be one of: feat, fix, chore, docs, refactor, test, style, perf, ci, build, revert",
    "- Choosing the type: feat = new capability or behavior; fix = correcting a bug; refactor = restructuring without behavior change; test = tests only; docs = documentation only; chore = build/config/tooling; perf = performance; style = formatting; ci = CI config; build = build system; revert = undoing a previous change.",
    "- Scope: use the single most-specific directory that groups the changes (e.g. 'api', 'config', 'exposure'). NEVER comma-join multiple scopes. If files span unrelated directories, OMIT scope entirely.",
    "- Description: a SHORT imperative phrase summarizing what was done. Be specific: 'add regression pipeline and tests', not 'update 27 modules'.",
    "- NEVER write generic filler. Rejected examples: 'update file.ts', 'chore: update 3 files', 'feat: misc changes', 'update exposure: config'. The header must say exactly WHAT changed, referencing actual functions/symbols/values from the diff.",
    "- Body: explain what changed and WHY in a short paragraph, referencing specific code from the diff. Never restate the header verbatim.",
    "- Example of a GOOD message:",
    "  feat(api): add retry with exponential backoff",
    "",
    "  Retries failed requests up to 3 times with exponential backoff, surfacing the last error after exhausting attempts.",
    "- Max 72 chars for the header line (type + scope + description combined).",
    "- Output ONLY the commit message, nothing else.",
  ];

  const styleBlock = formatStyleContext(style);
  if (styleBlock) {
    lines.push("", styleBlock);
  }
  const requestText = request?.message?.trim();
  if (requestText) {
    lines.push(
      "",
      "User message request — the commit message MUST cover these points (where they apply to the diff):",
      requestText,
    );
  }
  if (context) {
    lines.push(
      "",
      "Session context — what the user is working on. Align the commit message with this intent where it applies to the diff, but NEVER claim changes the diff does not contain:",
      context,
    );
  }
  lines.push("", "Diff stat:", diffStat, "", "Full diff:", truncatedDiff);
  return lines.join("\n");
}

/**
 * Deterministic commit message generation — used as fallback when the
 * subagent is unavailable or fails. Content-driven: derives the description
 * from the actual added/removed diff lines, never from file names alone, and
 * always includes a structured body. Returns "" when the diff has no
 * extractable content — callers must then skip/block the commit rather than
 * emit a generic message.
 */
export function deterministicCommitMessage(
  diffStat: string,
  diffContent: string,
  files: string[],
  style: RepoCommitStyle = EMPTY_COMMIT_STYLE,
): string {
  const changed = files && files.length > 0 ? files : getChangedFiles(diffStat);

  // Only analyze hunks for the files in this change set (matters for group fallbacks)
  const hunks = parseDiffHunks(diffContent).filter(
    (h) => changed.length === 0 || changed.includes(h.file),
  );
  const binaryOnly =
    hunks.every((h) => h.addedCount === 0 && h.removedCount === 0) &&
    hasBinaryChanges(diffContent);

  const type = detectCommitType(diffContent, changed, style);

  // Scope: longest common ancestor, normalized to a repo-used scope when possible
  const dirs = changed.map((f) => path.dirname(f)).filter((d) => d !== ".");
  const ancestor = findCommonAncestor(dirs);
  let scope = ancestor;
  if (ancestor && style.scopes.length > 0) {
    const leaf = ancestor.split("/").pop() || ancestor;
    if (style.scopes.includes(ancestor)) scope = ancestor;
    else if (style.scopes.includes(leaf)) scope = leaf;
    else if (style.scopes.some((s) => ancestor.endsWith(s)))
      scope = style.scopes.find((s) => ancestor.endsWith(s))!;
  }

  // Description from actual diff content — empty means "block, no generic message"
  const desc = describeDiffContent(hunks, changed, binaryOnly);
  if (!desc) return "";

  const scopePart = scope ? `(${scope})` : "";
  const header = enforceHeaderLimit(`${type}${scopePart}: ${desc}`);
  const body = buildDeterministicBody(hunks, changed, binaryOnly, desc);
  return `${header}\n\n${body}`;
}

/**
 * Resolve the final message to commit: validates conventional format and,
 * only when allowDeterministic is true (deterministic_fallback setting), falls
 * back to the content-driven deterministic generator. Returns undefined to
 * block the commit when no detailed valid message can be produced — a
 * generic message is never committed. No boilerplate-pattern detector is used.
 */
export function resolveCommitMessage(
  message: string,
  diffStat: string,
  diffContent: string,
  files: string[],
  opts: { style?: RepoCommitStyle; allowDeterministic?: boolean } = {},
): string | undefined {
  const { style = EMPTY_COMMIT_STYLE, allowDeterministic = false } = opts;
  if (isValidCommitMessage(message, true)) return message;

  if (!allowDeterministic) {
    console.error(
      "[pi-committer] DIAG: generated message invalid and deterministic fallback is disabled — blocking commit",
    );
    return undefined;
  }

  console.error(
    `[pi-committer] DIAG: generated message invalid — regenerating deterministically: ${JSON.stringify(message.slice(0, 120))}`,
  );
  const fallback = deterministicCommitMessage(diffStat, diffContent, files, style);
  if (!fallback || !isValidCommitMessage(fallback)) {
    // (Lenient check: the deterministic generator's headers may legitimately
    // end in the enforceHeaderLimit truncation marker "…".)
    console.error(
      "[pi-committer] DIAG: deterministic regeneration produced no detailed valid message — blocking commit",
    );
    return undefined;
  }
  return fallback;
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

/**
 * Test seam (mirrors index.ts __setCreateAgentSessionMock): override the
 * SDK's createAgentSession in-process so subagent message generation can be
 * tested without real model calls. Passing undefined restores SDK loading.
 */
export function __setCreateAgentSessionFn(
  fn:
    | ((options?: Record<string, unknown>) => Promise<{ session: any }>)
    | undefined,
): void {
  if (fn) {
    createAgentSessionFn = fn;
    sdkAvailable = true;
  } else {
    createAgentSessionFn = null;
    sdkAvailable = false;
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
      "You write clear, specific, detailed conventional git commit messages that describe exactly what changed and why.",
    getAppendSystemPrompt: () => [],
    getSystemPromptSource: () => undefined,
    getAppendSystemPromptSources: () => [],
    extendResources: () => {},
    reload: async () => {},
  };
}

/**
 * Run one commit-message subagent session. Returns the generated text, or ""
 * when the session threw, was aborted, or returned empty/short output.
 */
async function runWorkerMessageSession(
  prompt: string,
  repoDir: string,
  subagentModel?: WorkerSubagentModel,
  onProgress?: (output: string[]) => void,
  subagentThinkingLevel?: string,
): Promise<string> {
  try {
    if (aborted) return "";

    // The full model object was resolved in the main process (mirrors the
    // sync path's resolveSubagentModel); pass it through as-is.
    const model: any = subagentModel;

    const cas = createAgentSessionFn;
    const result = await cas({
      cwd: repoDir,
      model,
      thinkingLevel: subagentThinkingLevel as any,
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
      if (aborted) return "";
      await session.prompt(prompt);
    } finally {
      unsubscribe();
    }

    const generated = outputParts.join("\n\n").trim();
    if (generated.length > 10) return generated;
    console.error(
      `[pi-committer] DIAG: worker subagent returned empty/short output (${generated.length} chars)`,
    );
    return "";
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(
      `[pi-committer] DIAG: worker subagent message generation threw (${msg})`,
    );
    return "";
  }
}

/**
 * Generate a commit message using a subagent (if SDK available).
 * The prompt demands specific what/why detail (never generic filler).
 * Empty or invalid-format output triggers ONE retry with stricter
 * instructions before escalating to the content-driven deterministic
 * fallback.
 */
/** Options for subagent/deterministic message generation. An options object
 *  (rather than positional trailing args) makes it impossible to pass a
 *  MessageRequest where `allowDeterministic` is expected — the exact bug that
 *  once silently enabled deterministic messages while deterministic_fallback
 *  was off. */
interface MessageGenerationOptions {
  /** Resolved session model for the subagent; unset skips the subagent. */
  subagentModel?: WorkerSubagentModel;
  onProgress?: (output: string[]) => void;
  subagentThinkingLevel?: string;
  style?: RepoCommitStyle;
  /** Mirrors deterministic_fallback: deterministic output only when true. */
  allowDeterministic?: boolean;
  /** User commit-message intent (message/verbatim) forwarded to the prompt. */
  request?: MessageRequest;
  /** Session context (goal/task + recent conversation) for intent alignment. */
  context?: string;
}

export async function generateCommitMessage(
  diffStat: string,
  diffContent: string,
  files: string[],
  repoDir: string,
  opts: MessageGenerationOptions = {},
): Promise<string> {
  const {
    subagentModel,
    onProgress,
    subagentThinkingLevel,
    style = EMPTY_COMMIT_STYLE,
    allowDeterministic = false,
    request,
    context,
  } = opts;
  const _sdkOk = await tryLoadSDK();
  if (!_sdkOk || !subagentModel) {
    console.error(
      `[pi-committer] DIAG: subagent message generation skipped — ${
        !_sdkOk ? "SDK unavailable" : "no model configured"
      }${allowDeterministic ? " — falling back to deterministic" : " — blocking commit (deterministic fallback disabled)"}`,
    );
    return gatedDeterministicMessage({ diffStat, diffContent, files, style, allowDeterministic });
  }

  const prompt = buildCommitMessagePrompt(diffStat, diffContent, { style, request, context });

  let generated = await runWorkerMessageSession(
    prompt,
    repoDir,
    subagentModel,
    onProgress,
    subagentThinkingLevel,
  );
  if (generated && !isValidCommitMessage(generated, true)) {
    console.error(
      "[pi-committer] DIAG: worker subagent output is not a valid conventional commit — retrying once with stricter instructions",
    );
    generated = await runWorkerMessageSession(
      prompt +
        "\n\nYour previous output was rejected: it is not a valid conventional commit message (format: <type>(<scope>): <description> followed by a detailed body). Write a NEW commit message following the format and rules above. Do not repeat the rejected text.",
      repoDir,
      subagentModel,
      onProgress,
      subagentThinkingLevel,
    );
  }

  if (generated && isValidCommitMessage(generated, true)) return generated;

  console.error(
    "[pi-committer] DIAG: worker subagent output empty/invalid after retry" +
      (allowDeterministic ? " — escalating to deterministic content analysis" : " — blocking commit (deterministic fallback disabled)"),
  );
  return gatedDeterministicMessage({ diffStat, diffContent, files, style, allowDeterministic });
}

/** Deterministic message when the deterministic_fallback gate is on, else ""
 *  (the caller's resolveCommitMessage then blocks the commit — the agent is
 *  required for every commit when the gate is off). */
function gatedDeterministicMessage(opts: {
  diffStat: string;
  diffContent: string;
  files: string[];
  style: RepoCommitStyle;
  allowDeterministic: boolean;
}): string {
  const { diffStat, diffContent, files, style, allowDeterministic } = opts;
  return allowDeterministic ? deterministicCommitMessage(diffStat, diffContent, files, style) : "";
}

/**
 * Generate commit groups using a subagent (if SDK available).
 */
export async function generateCommitGroups(
  diffStat: string,
  diffContent: string,
  allFiles: string[],
  repoDir: string,
  opts: MessageGenerationOptions = {},
): Promise<Array<{ message: string; files: string[] }>> {
  const {
    subagentModel,
    onProgress,
    subagentThinkingLevel,
    style = EMPTY_COMMIT_STYLE,
    allowDeterministic = false,
    request,
    context,
  } = opts;
  // Fallback: single group (SDK not available or no model configured)
  const _sdkOk = await tryLoadSDK();
  if (!_sdkOk || !subagentModel) {
    console.error(
      `[pi-committer] DIAG: worker subagent grouping skipped — ${
        !_sdkOk ? "SDK unavailable" : "no model configured"
      } — falling back to single commit`,
    );
    const message = gatedDeterministicMessage({ diffStat, diffContent, files: allFiles, style, allowDeterministic });
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
    "- Choosing each group's type: feat = new capability or behavior; fix = correcting a bug; refactor = restructuring without behavior change; test = tests only; docs = documentation only; chore = build/config/tooling; perf = performance; style = formatting; ci = CI config; build = build system; revert = undoing a previous change.",
    "- Scope: use the single most-specific directory for each group (e.g. 'api', 'exposure', 'config'). NEVER comma-join multiple scopes. If files in a group span unrelated directories, OMIT scope.",
    "- Description: a SHORT imperative phrase summarizing what each group does. Be specific: 'add regression pipeline and tests', not 'update 27 modules'.",
    "- NEVER write generic filler in any group's header. Rejected examples: 'update file.ts', 'chore: update 3 files', 'feat: misc changes'. Each header must say exactly WHAT changed, referencing actual functions/symbols/values from the diff.",
    "- Body: for each group, write a short paragraph explaining what changed and WHY. Never restate the header verbatim.",
    "- Example of a GOOD group header+body:",
    "  feat(api): add retry with exponential backoff",
    "",
    "  Retries failed requests up to 3 times with exponential backoff, surfacing the last error after exhausting attempts.",
    "- Max 72 chars per header line (type + scope + description combined).",
    "- Assign each file to EXACTLY ONE group",
    "- Cover ALL files listed below in your groups",
    "",
    `Changed files (${allFiles.length}):`,
    fileListStr,
  ];

  const requestText = request?.message?.trim();
  if (requestText) {
    prompt.push(
      "",
      "User message request — each commit message MUST cover these points where they apply to its group:",
      requestText,
    );
  }

  if (context) {
    prompt.push(
      "",
      "Session context — what the user is working on. Align each group's commit message with this intent where it applies to that group's diff, but NEVER claim changes the diff does not contain:",
      context,
    );
  }

  prompt.push(
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
  );

  const styleBlock = formatStyleContext(style);
  if (styleBlock) {
    prompt.push("", styleBlock);
  }

  const promptStr = prompt.join("\n");

  try {
    // Full model object resolved in the main process; pass through as-is.
    const model: any = subagentModel;

    const cas = createAgentSessionFn;
    const result = await cas({
      cwd: repoDir,
      model,
      thinkingLevel: subagentThinkingLevel as any,
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
        return [{ message: gatedDeterministicMessage({ diffStat, diffContent, files: allFiles, style, allowDeterministic }), files: [...allFiles] }];
      }
      await session.prompt(promptStr);
    } finally {
      unsubscribe();
    }

    const output = outputParts.join("\n\n").trim();
    if (output.length < 20) {
      console.error(
        `[pi-committer] DIAG: worker subagent grouping returned empty/short output (${output.length} chars) — falling back to single commit`,
      );
      return [{ message: gatedDeterministicMessage({ diffStat, diffContent, files: allFiles, style, allowDeterministic }), files: [...allFiles] }];
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
      return [{ message: gatedDeterministicMessage({ diffStat, diffContent, files: allFiles, style, allowDeterministic }), files: [...allFiles] }];
    }

    return groups;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(
      `[pi-committer] DIAG: worker subagent grouping threw — falling back to single commit (${msg})`,
    );
    return [{ message: gatedDeterministicMessage({ diffStat, diffContent, files: allFiles, style, allowDeterministic }), files: [...allFiles] }];
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
  request?: MessageRequest,
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

  // Opt-in repo-style sampling: only when match_repo_style is enabled do we
  // read the repo's git history for style context (default: no git-log calls).
  const style = params.matchRepoStyle ? sampleRepoCommitStyle(dir) : EMPTY_COMMIT_STYLE;

  // Verbatim path: the caller supplied the exact commit message text.
  // Message generation is skipped entirely and the text is used exactly as
  // provided — never edited, prefixed, or reformatted. An invalid verbatim
  // blocks the commit (changes stay staged) instead of a silent rewrite.
  const verbatimRaw = request?.verbatim ?? "";
  const verbatim = verbatimRaw.trim();
  if (verbatim) {
    if (aborted) {
      unstageAll(dir);
      return undefined;
    }
    if (!isValidCommitMessage(verbatim)) {
      console.error(
        "[pi-committer] DIAG: worker blocked verbatim commit — message is not a valid conventional commit message",
      );
      return {
        hash: "",
        message:
          "Skipped commit: the verbatim commit message is not a valid conventional commit message " +
          "(expected <type>(<scope>): <description>). Changes were left staged.",
        success: false,
      };
    }
    execSync("git commit -F -", {
      cwd: dir,
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "ignore"],
      input: verbatimRaw,
    });
    const hash = getHeadHash(dir);
    return { hash, message: verbatimRaw, success: true };
  }

  // Generate commit message — skip subagent for small change sets
  const message = await generateCommitMessage(
    diffStat,
    diffContent,
    files,
    dir,
    {
      subagentModel: skipSubagent ? undefined : params.subagentModel,
      context: params.sessionContext ?? "",
      onProgress: (output) => {
        const onProg = ipc?.onProgress ?? sendProgress;
        onProg({
          phase: "committing",
          statusMessage: `Generating commit message for ${files.length} file(s)...`,
          subagent: { recentOutput: output },
          totalCommits: 1,
          completedCommits: 0,
        });
      },
      subagentThinkingLevel: params.subagentThinkingLevel,
      style,
      allowDeterministic: params.deterministicFallback,
      request,
    },
  );

  if (aborted) {
    unstageAll(dir);
    return undefined;
  }

  // Validate; regenerate deterministically only when the setting is on, and
  // block (never commit a generic message) when no detailed valid message can
  // be produced. The block leaves changes staged for a retry.
  const finalMessage = resolveCommitMessage(
    message,
    diffStat,
    diffContent,
    files,
    { style, allowDeterministic: params.deterministicFallback },
  );
  if (finalMessage === undefined) {
    console.error(
      "[pi-committer] DIAG: worker blocked commit — could not produce a detailed, valid commit message",
    );
    return {
      hash: "",
      message:
        "Skipped commit: could not produce a detailed, valid commit message (nothing generic was committed). Changes were left staged.",
      success: false,
    };
  }

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
  request?: MessageRequest,
): Promise<{ commitCount: number; commitLog: CommitLogEntry[]; warnings: string[] }> {
  // Opt-in repo-style sampling: only when match_repo_style is enabled do we
  // read the repo's git history for style context (default: no git-log calls).
  const style = params.matchRepoStyle ? sampleRepoCommitStyle(dir) : EMPTY_COMMIT_STYLE;

  const groups = await generateCommitGroups(
    params.diffStat,
    params.diffContent,
    allFiles,
    dir,
    {
      subagentModel: params.subagentModel,
      context: params.sessionContext ?? "",
      onProgress: (output) => {
        const onProgAnalyze = ipc?.onProgress ?? sendProgress;
        onProgAnalyze({
          phase: "analyzing",
          fileCount: allFiles.length,
          statusMessage: `Analyzing ${allFiles.length} file(s) for logical commit grouping...`,
          subagent: { recentOutput: output },
        });
      },
      subagentThinkingLevel: params.subagentThinkingLevel,
      style,
      allowDeterministic: params.deterministicFallback,
      request,
    },
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
        {
          subagentModel: params.subagentModel,
          context: params.sessionContext ?? "",
          onProgress: (output) => {
            const onProgGroup = ipc?.onProgress ?? sendProgress;
            onProgGroup({
              phase: "committing",
              subagent: { recentOutput: output },
              totalCommits: groups.length,
              completedCommits: commitCount,
              statusMessage: `Committing group ${commitCount + 1}/${groups.length}...`,
            });
          },
          subagentThinkingLevel: params.subagentThinkingLevel,
          style,
          allowDeterministic: params.deterministicFallback,
          request,
        },
      );

      if (aborted) {
        unstageAll(dir);
        return { commitCount, commitLog, warnings };
      }

      // Validate; regenerate deterministically only when the setting is on.
      // Skip the group (never commit a generic message) when no detailed valid
      // message can be produced — changes stay staged for a retry.
      const finalMessage = resolveCommitMessage(
        message,
        diffStat,
        diffContent,
        stagedFiles,
        { style, allowDeterministic: params.deterministicFallback },
      );
      if (finalMessage === undefined) {
        warnings.push(
          "Skipped group — could not produce a detailed, valid commit message (nothing generic was committed; changes left staged)",
        );
        continue;
      }

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
  let { dir, diffStat, diffContent, allFiles, stagedCommits, excludePatterns, minChanges, subagentGroupingMinFiles, subagentMessageMinFiles, subagentThinkingLevel } = params;

  // Validate incoming diff content; reset to empty if contaminated
  if (!isValidDiffContent(diffContent)) {
    console.error(
      "[pi-committer] DIAG: async worker received non-diff content — resetting to prevent contamination",
    );
    diffContent = "";
  }
  if (!isValidDiffStat(diffStat)) {
    console.error(
      "[pi-committer] DIAG: async worker received non-diff stat — resetting to prevent contamination",
    );
    diffStat = "";
  }

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
    // Verbatim forces a single commit containing all changes — staged-commits
    // grouping is skipped when the caller supplied an exact message.
    const useSubagent =
      stagedCommits &&
      files.length > 1 &&
      files.length >= subagentGroupingMinFiles &&
      !params.messageRequest?.verbatim?.trim();
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

    if (
      stagedCommits &&
      files.length > 1 &&
      files.length >= params.subagentGroupingMinFiles &&
      !params.messageRequest?.verbatim?.trim()
    ) {
      // ---- Agent-decided staged commit mode ----
      const result = await doGroupedCommits(dir, ctx, files, params, {
        onProgress: sendProgress,
        onCommit: sendCommit,
      }, params.messageRequest);
      commitCount = result.commitCount;
      commitLog = result.commitLog;
      _warnings = result.warnings;
    } else {
      // ---- Single commit mode ----
      // Small change sets below the message threshold skip the subagent entirely.
      // Above the message threshold but below the grouping threshold, the subagent
      // generates a single commit message (good descriptions, no grouping).
      const skipSubagent =
        params.deterministicFallback && files.length < subagentMessageMinFiles;
      const entry = await doSingleCommit(
        dir,
        ctx,
        files,
        params,
        { onProgress: sendProgress },
        skipSubagent,
        params.messageRequest,
      );
      if (entry && entry.success) {
        commitCount = 1;
        commitLog = [entry];
        sendCommit(entry);
      } else if (entry) {
        // Blocked commit (no detailed valid message) — surface as a warning
        _warnings.push(entry.message);
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



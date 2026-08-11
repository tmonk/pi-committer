import { execFileSync } from "node:child_process";
import {
  closeSync,
  copyFileSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import path from "node:path";

const MAX_BUFFER = 64 * 1024 * 1024;
const ZERO_SHA = "0".repeat(40);

export function git(repoDir, args, options = {}) {
  return execFileSync("git", args, {
    cwd: repoDir,
    encoding: "utf8",
    maxBuffer: options.maxBuffer ?? MAX_BUFFER,
    stdio: options.input === undefined ? ["ignore", "pipe", "pipe"] : ["pipe", "pipe", "pipe"],
    input: options.input,
    env: options.env ? { ...process.env, ...options.env } : process.env,
  }).trim();
}

export function tryGit(repoDir, args, options = {}) {
  try {
    return { ok: true, stdout: git(repoDir, args, options) };
  } catch (error) {
    return {
      ok: false,
      stdout: "",
      error,
      stderr: error?.stderr?.toString?.() ?? error?.message ?? String(error),
    };
  }
}

export function gitRoot(dir) {
  const result = tryGit(dir, ["rev-parse", "--show-toplevel"]);
  return result.ok ? result.stdout : undefined;
}

export function gitDir(repoDir) {
  return git(repoDir, ["rev-parse", "--absolute-git-dir"]);
}

export function resolveHead(repoDir) {
  const result = tryGit(repoDir, ["rev-parse", "--verify", "HEAD"]);
  return result.ok ? result.stdout : null;
}

export function resolveTargetRef(repoDir) {
  const symbolic = tryGit(repoDir, ["symbolic-ref", "-q", "HEAD"]);
  return symbolic.ok && symbolic.stdout ? symbolic.stdout : "HEAD";
}

export function resolveRef(repoDir, ref) {
  const result = tryGit(repoDir, ["rev-parse", "--verify", ref]);
  return result.ok ? result.stdout : null;
}

export function hasUnmergedEntries(repoDir) {
  const result = tryGit(repoDir, ["ls-files", "-u"]);
  return result.ok && result.stdout.length > 0;
}

function realIndexPath(repoDir) {
  const value = git(repoDir, ["rev-parse", "--git-path", "index"]);
  return path.isAbsolute(value) ? value : path.resolve(repoDir, value);
}

function indexEnv(indexPath) {
  return { GIT_INDEX_FILE: indexPath };
}

function initializeTempIndex(repoDir, indexPath, baseHead) {
  const currentIndex = realIndexPath(repoDir);
  if (existsSync(currentIndex)) {
    copyFileSync(currentIndex, indexPath);
    return;
  }
  if (baseHead) {
    git(repoDir, ["read-tree", baseHead], { env: indexEnv(indexPath) });
  } else {
    git(repoDir, ["read-tree", "--empty"], { env: indexEnv(indexPath) });
  }
}

function writeIndexTree(repoDir, indexPath) {
  return git(repoDir, ["write-tree"], { env: indexEnv(indexPath) });
}

function writeCurrentIndexTree(repoDir) {
  return git(repoDir, ["write-tree"]);
}

function listIndexChanges(repoDir, indexPath) {
  const output = git(
    repoDir,
    ["diff", "--cached", "--name-only", "-z", "--no-renames"],
    { env: indexEnv(indexPath) },
  );
  return output.split("\0").filter(Boolean);
}

function globToRegExp(pattern) {
  let source = "^";
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i];
    if (ch === "*") {
      if (pattern[i + 1] === "*") {
        source += ".*";
        i++;
      } else {
        source += "[^/]*";
      }
    } else if (ch === "?") {
      source += "[^/]";
    } else if ("\\.^$+{}()|[]".includes(ch)) {
      source += `\\${ch}`;
    } else {
      source += ch;
    }
  }
  if (pattern.endsWith("/")) source += ".*";
  source += "$";
  return new RegExp(source);
}

export function matchesExclude(file, pattern) {
  if (!pattern) return false;
  const normalized = file.split(path.sep).join("/");
  const p = pattern.split(path.sep).join("/");
  if (!p.includes("*") && !p.includes("?")) {
    if (p.endsWith("/")) {
      // Directory pattern: match a directory of that name at any depth,
      // never mid-segment (gitignore semantics for patterns without a
      // leading slash, e.g. "node_modules/" excludes src/node_modules/x).
      const escaped = p.slice(0, -1).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      return new RegExp(`(^|/)${escaped}(/|$)`).test(normalized);
    }
    return normalized === p || normalized.includes(p);
  }
  if (!p.includes("/")) return globToRegExp(p).test(path.basename(normalized));
  return globToRegExp(p).test(normalized);
}

function restoreExcludedPath(repoDir, indexPath, file, baseHead) {
  const env = indexEnv(indexPath);
  if (baseHead) {
    const reset = tryGit(repoDir, ["reset", "-q", baseHead, "--", file], { env });
    if (reset.ok) return;
  }
  tryGit(repoDir, ["rm", "--cached", "-q", "--ignore-unmatch", "--", file], { env });
}

function operationRoot(repoDir) {
  return path.join(gitDir(repoDir), "pi-committer-v2");
}

function ensureOperationDirs(repoDir) {
  const root = operationRoot(repoDir);
  const results = path.join(root, "results");
  const cancel = path.join(root, "cancel");
  mkdirSync(results, { recursive: true });
  mkdirSync(cancel, { recursive: true });
  return { root, results, cancel };
}

export function captureSnapshot(repoDir, options = {}) {
  const root = gitRoot(repoDir);
  if (!root) throw new Error("Not a git repository");
  repoDir = root;

  if (hasUnmergedEntries(repoDir)) {
    throw new Error("Cannot commit while the index contains unmerged/conflicted entries");
  }

  const baseHead = resolveHead(repoDir);
  const targetRef = resolveTargetRef(repoDir);
  const originalIndexTree = writeCurrentIndexTree(repoDir);
  const tmp = mkdtempSync(path.join(tmpdir(), "pi-committer-snapshot-"));
  const tempIndex = path.join(tmp, "index");

  try {
    initializeTempIndex(repoDir, tempIndex, baseHead);
    const env = indexEnv(tempIndex);
    git(repoDir, ["add", "-A", "--", "."], { env });

    const beforeExcludes = listIndexChanges(repoDir, tempIndex);
    const excludePatterns = Array.isArray(options.excludePatterns) ? options.excludePatterns : [];
    const excludedFiles = beforeExcludes.filter((file) =>
      excludePatterns.some((pattern) => matchesExclude(file, pattern)),
    );

    for (const file of excludedFiles) {
      restoreExcludedPath(repoDir, tempIndex, file, baseHead);
    }

    const files = listIndexChanges(repoDir, tempIndex);
    if (files.length === 0) return null;

    const snapshotTree = writeIndexTree(repoDir, tempIndex);
    const dirs = ensureOperationDirs(repoDir);
    const id = randomUUID();

    return Object.freeze({
      version: 2,
      id,
      repoDir,
      targetRef,
      baseHead,
      snapshotTree,
      originalIndexTree,
      files: Object.freeze([...files]),
      excludedFiles: Object.freeze([...excludedFiles]),
      createdAt: new Date().toISOString(),
      resultPath: path.join(dirs.results, `${id}.json`),
      cancelPath: path.join(dirs.cancel, id),
    });
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

function emptyTree(repoDir) {
  return git(repoDir, ["mktree"], { input: "" });
}

export function readSnapshotDiff(snapshot, files = snapshot.files) {
  const base = snapshot.baseHead ?? emptyTree(snapshot.repoDir);
  const args = ["diff", "--binary", "--no-ext-diff", "--no-color", base, snapshot.snapshotTree];
  if (files?.length) args.push("--", ...files);
  return git(snapshot.repoDir, args, { maxBuffer: MAX_BUFFER });
}

function parseTreeEntries(raw) {
  const entries = new Map();
  for (const record of raw.split("\0")) {
    if (!record) continue;
    const tab = record.indexOf("\t");
    if (tab < 0) continue;
    const meta = record.slice(0, tab).split(" ");
    const file = record.slice(tab + 1);
    if (meta.length < 3) continue;
    entries.set(file, { mode: meta[0], type: meta[1], sha: meta[2], file });
  }
  return entries;
}

function treeEntries(repoDir, treeish, files) {
  if (!files.length) return new Map();
  const raw = git(repoDir, ["ls-tree", "-rz", treeish, "--", ...files], { maxBuffer: MAX_BUFFER });
  return parseTreeEntries(raw);
}

function normalizePlan(snapshot, plan) {
  if (!Array.isArray(plan) || plan.length === 0) throw new Error("Commit plan is empty");

  const expected = new Set(snapshot.files);
  const seen = new Set();
  const normalized = [];

  for (const group of plan) {
    const message = typeof group?.message === "string" ? group.message.trim() : "";
    if (!message) throw new Error("Commit plan contains an empty message");
    const files = [...new Set(Array.isArray(group.files) ? group.files : [])];
    if (files.length === 0) throw new Error("Commit plan contains an empty file group");

    for (const file of files) {
      if (!expected.has(file)) throw new Error(`Commit plan referenced unknown file: ${file}`);
      if (seen.has(file)) throw new Error(`Commit plan referenced file more than once: ${file}`);
      seen.add(file);
    }
    normalized.push({ message, files });
  }

  const missing = [...expected].filter((file) => !seen.has(file));
  if (missing.length) {
    throw new Error(`Commit plan omitted ${missing.length} snapshot file(s): ${missing.slice(0, 5).join(", ")}`);
  }

  return normalized;
}

function assertSnapshotTargetUnchanged(snapshot) {
  const currentTarget = resolveTargetRef(snapshot.repoDir);
  if (currentTarget !== snapshot.targetRef) {
    throw Object.assign(
      new Error(`HEAD moved to a different target (${currentTarget}); snapshot targeted ${snapshot.targetRef}`),
      { code: "HEAD_TARGET_CHANGED" },
    );
  }
  const current = resolveRef(snapshot.repoDir, snapshot.targetRef);
  if (current !== snapshot.baseHead) {
    throw Object.assign(
      new Error("Repository HEAD changed after the snapshot; refusing to overwrite concurrent commits"),
      { code: "HEAD_RACE" },
    );
  }
}

function createCommit(repoDir, tree, parent, message) {
  const args = ["commit-tree", tree];
  if (parent) args.push("-p", parent);
  return git(repoDir, args, { input: `${message.trim()}\n` });
}

function applyFilesToIndex(repoDir, indexPath, sourceTree, files) {
  const env = indexEnv(indexPath);
  const entries = treeEntries(repoDir, sourceTree, files);

  for (const file of files) {
    const entry = entries.get(file);
    if (entry) {
      git(
        repoDir,
        ["update-index", "--add", "--cacheinfo", `${entry.mode},${entry.sha},${file}`],
        { env },
      );
    } else {
      tryGit(repoDir, ["update-index", "--force-remove", "--", file], { env });
    }
  }
}

function createCommitChain(snapshot, plan, shouldAbort) {
  const tmp = mkdtempSync(path.join(tmpdir(), "pi-committer-plan-"));
  const indexPath = path.join(tmp, "index");
  const commits = [];
  let parent = snapshot.baseHead;

  try {
    for (let i = 0; i < plan.length; i++) {
      if (shouldAbort()) throw Object.assign(new Error("Commit cancelled"), { code: "CANCELLED" });

      if (parent) {
        git(snapshot.repoDir, ["read-tree", parent], { env: indexEnv(indexPath) });
      } else {
        git(snapshot.repoDir, ["read-tree", "--empty"], { env: indexEnv(indexPath) });
      }

      applyFilesToIndex(snapshot.repoDir, indexPath, snapshot.snapshotTree, plan[i].files);
      const tree = writeIndexTree(snapshot.repoDir, indexPath);
      const hash = createCommit(snapshot.repoDir, tree, parent, plan[i].message);
      commits.push({ hash, message: plan[i].message, files: [...plan[i].files], success: true });
      parent = hash;
    }
    return { commits, finalCommit: parent };
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

function updateTargetRef(snapshot, finalCommit) {
  const expected = snapshot.baseHead ?? ZERO_SHA;
  try {
    git(snapshot.repoDir, ["update-ref", snapshot.targetRef, finalCommit, expected]);
  } catch (error) {
    throw Object.assign(
      new Error("Repository HEAD changed while the commit was being prepared; no branch ref was overwritten"),
      { code: "REF_RACE", cause: error },
    );
  }
}

function indexFingerprint(indexPath) {
  try {
    return createHash("sha256").update(readFileSync(indexPath)).digest("hex");
  } catch {
    return "missing";
  }
}

function stableCurrentIndex(repoDir) {
  const indexPath = realIndexPath(repoDir);
  for (let attempt = 0; attempt < 3; attempt++) {
    const before = indexFingerprint(indexPath);
    const tree = writeCurrentIndexTree(repoDir);
    const after = indexFingerprint(indexPath);
    if (before === after) return { indexPath, tree, fingerprint: after };
  }
  return null;
}

function entrySignature(entry) {
  return entry ? `${entry.mode}:${entry.sha}` : "<absent>";
}

function installIndexWithLock(realPath, expectedFingerprint, desiredIndexPath) {
  const lockPath = `${realPath}.lock`;
  let fd;
  try {
    fd = openSync(lockPath, "wx");
  } catch {
    return { ok: false, reason: "index is locked by another git process" };
  }

  try {
    if (indexFingerprint(realPath) !== expectedFingerprint) {
      return { ok: false, reason: "index changed while reconciliation was being prepared" };
    }
    const desired = readFileSync(desiredIndexPath);
    writeSync(fd, desired);
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    renameSync(lockPath, realPath);
    return { ok: true };
  } catch (error) {
    return { ok: false, reason: `atomic index install failed: ${error?.message ?? String(error)}` };
  } finally {
    if (fd !== undefined) {
      try { closeSync(fd); } catch { /* no-op */ }
    }
    try { unlinkSync(lockPath); } catch { /* renamed or absent */ }
  }
}

function reconcileRealIndex(snapshot, finalCommit) {
  const stable = stableCurrentIndex(snapshot.repoDir);
  if (!stable) return { reconciled: false, reason: "index changed repeatedly during reconciliation" };

  const originalEntries = treeEntries(snapshot.repoDir, snapshot.originalIndexTree, snapshot.files);
  const currentEntries = treeEntries(snapshot.repoDir, stable.tree, snapshot.files);

  const safeFiles = [];
  const concurrentFiles = [];
  for (const file of snapshot.files) {
    if (entrySignature(originalEntries.get(file)) === entrySignature(currentEntries.get(file))) {
      safeFiles.push(file);
    } else {
      concurrentFiles.push(file);
    }
  }

  if (safeFiles.length === 0) {
    return {
      reconciled: false,
      reason: "all committed paths were staged concurrently; their newer index entries were preserved",
      concurrentIndexFiles: concurrentFiles,
    };
  }

  const tmp = mkdtempSync(path.join(tmpdir(), "pi-committer-reconcile-"));
  const indexPath = path.join(tmp, "index");
  try {
    git(snapshot.repoDir, ["read-tree", stable.tree], { env: indexEnv(indexPath) });
    applyFilesToIndex(snapshot.repoDir, indexPath, finalCommit, safeFiles);

    const installed = installIndexWithLock(stable.indexPath, stable.fingerprint, indexPath);
    if (!installed.ok) {
      return { reconciled: false, reason: installed.reason, concurrentIndexFiles: concurrentFiles };
    }

    return concurrentFiles.length === 0
      ? { reconciled: true }
      : {
          reconciled: false,
          partiallyReconciled: true,
          reason: `${concurrentFiles.length} committed path(s) had newer staged content and were preserved`,
          concurrentIndexFiles: concurrentFiles,
        };
  } catch (error) {
    return {
      reconciled: false,
      reason: `index reconciliation failed: ${error?.message ?? String(error)}`,
      concurrentIndexFiles: concurrentFiles,
    };
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

export function applyCommitPlan(snapshot, plan, options = {}) {
  const shouldAbort = options.shouldAbort ?? (() => false);
  const normalized = normalizePlan(snapshot, plan);

  if (shouldAbort()) throw Object.assign(new Error("Commit cancelled"), { code: "CANCELLED" });
  assertSnapshotTargetUnchanged(snapshot);

  const { commits, finalCommit } = createCommitChain(snapshot, normalized, shouldAbort);
  if (!finalCommit) throw new Error("Commit plan produced no commit");

  if (shouldAbort()) throw Object.assign(new Error("Commit cancelled"), { code: "CANCELLED" });
  assertSnapshotTargetUnchanged(snapshot);
  updateTargetRef(snapshot, finalCommit);

  const index = reconcileRealIndex(snapshot, finalCommit);

  return {
    operationId: snapshot.id,
    commitCount: commits.length,
    commits,
    finalCommit,
    indexReconciled: index.reconciled,
    indexPartiallyReconciled: index.partiallyReconciled ?? false,
    indexReconcileReason: index.reason,
    concurrentIndexFiles: index.concurrentIndexFiles ?? [],
  };
}

function atomicWriteJson(filePath, value) {
  mkdirSync(path.dirname(filePath), { recursive: true });
  const temp = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  renameSync(temp, filePath);
}

export function writeOperationResult(snapshot, result) {
  const payload = {
    version: 2,
    operationId: snapshot.id,
    repoDir: snapshot.repoDir,
    createdAt: snapshot.createdAt,
    completedAt: new Date().toISOString(),
    ...result,
  };
  atomicWriteJson(snapshot.resultPath, payload);
  return payload;
}

export function removeOperationResult(snapshot) {
  try { unlinkSync(snapshot.resultPath); } catch { /* consumed */ }
}

export function readOperationResults(repoDir, { consume = true } = {}) {
  const dirs = ensureOperationDirs(repoDir);
  const results = [];

  for (const name of readdirSync(dirs.results)) {
    if (!name.endsWith(".json")) continue;
    const full = path.join(dirs.results, name);
    try {
      const parsed = JSON.parse(readFileSync(full, "utf8"));
      results.push(parsed);
      if (consume) unlinkSync(full);
    } catch {
      // Preserve corrupt journals for manual inspection.
    }
  }

  return results.sort((a, b) => String(a.completedAt ?? "").localeCompare(String(b.completedAt ?? "")));
}

export function requestOperationCancel(snapshot) {
  mkdirSync(path.dirname(snapshot.cancelPath), { recursive: true });
  writeFileSync(snapshot.cancelPath, `${Date.now()}\n`, "utf8");
}

export function isOperationCancelled(snapshot) {
  return existsSync(snapshot.cancelPath);
}

export function clearOperationCancel(snapshot) {
  try { unlinkSync(snapshot.cancelPath); } catch { /* no-op */ }
}

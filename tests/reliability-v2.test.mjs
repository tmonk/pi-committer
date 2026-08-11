import assert from "node:assert/strict";
import { execFileSync, fork } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { applyCommitPlan, captureSnapshot, readOperationResults, requestOperationCancel } from "../src/snapshot-engine.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const workerPath = path.resolve(__dirname, "../src/worker.mjs");
const git = (dir, args) => execFileSync("git", args, { cwd: dir, encoding: "utf8" }).trim();

function repo() {
  const dir = mkdtempSync(path.join(tmpdir(), "pi-committer-v2-"));
  git(dir, ["init", "-q"]);
  git(dir, ["config", "user.email", "test@example.com"]);
  git(dir, ["config", "user.name", "Pi Committer Test"]);
  writeFileSync(path.join(dir, "a.txt"), "one\n");
  writeFileSync(path.join(dir, "b.txt"), "base\n");
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "-qm", "initial"]);
  return dir;
}

const message = "fix: commit immutable snapshot\n\nExercise the race-safe transaction.";

test("snapshot capture never mutates the real index", () => {
  const dir = repo();
  try {
    writeFileSync(path.join(dir, "b.txt"), "staged\n");
    git(dir, ["add", "b.txt"]);
    writeFileSync(path.join(dir, "a.txt"), "worktree\n");
    const before = git(dir, ["write-tree"]);
    const snapshot = captureSnapshot(dir, {});
    assert.equal(git(dir, ["write-tree"]), before);
    assert.deepEqual(new Set(snapshot.files), new Set(["a.txt", "b.txt"]));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("later worktree edits are excluded from the commit", () => {
  const dir = repo();
  try {
    writeFileSync(path.join(dir, "a.txt"), "captured\n");
    const snapshot = captureSnapshot(dir, {});
    writeFileSync(path.join(dir, "a.txt"), "later\n");
    const result = applyCommitPlan(snapshot, [{ files: snapshot.files, message }]);
    assert.equal(result.commitCount, 1);
    assert.equal(git(dir, ["show", "HEAD:a.txt"]), "captured");
    assert.match(git(dir, ["status", "--porcelain"]), /M a\.txt/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("concurrent commit wins and snapshot refuses to overwrite HEAD", () => {
  const dir = repo();
  try {
    writeFileSync(path.join(dir, "a.txt"), "captured\n");
    const snapshot = captureSnapshot(dir, {});
    git(dir, ["commit", "--allow-empty", "-qm", "concurrent"]);
    const head = git(dir, ["rev-parse", "HEAD"]);
    assert.throws(() => applyCommitPlan(snapshot, [{ files: snapshot.files, message }]), (e) => e.code === "HEAD_RACE");
    assert.equal(git(dir, ["rev-parse", "HEAD"]), head);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("unrelated concurrent staging is preserved", () => {
  const dir = repo();
  try {
    writeFileSync(path.join(dir, "a.txt"), "captured\n");
    const snapshot = captureSnapshot(dir, {});
    writeFileSync(path.join(dir, "b.txt"), "new staged\n");
    git(dir, ["add", "b.txt"]);
    applyCommitPlan(snapshot, [{ files: snapshot.files, message }]);
    assert.equal(git(dir, ["diff", "--cached", "--name-only"]), "b.txt");
    assert.equal(git(dir, ["show", ":b.txt"]), "new staged");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("same-path newer staged content wins over reconciliation", () => {
  const dir = repo();
  try {
    writeFileSync(path.join(dir, "a.txt"), "captured\n");
    const snapshot = captureSnapshot(dir, {});
    writeFileSync(path.join(dir, "a.txt"), "newer staged\n");
    git(dir, ["add", "a.txt"]);
    const result = applyCommitPlan(snapshot, [{ files: snapshot.files, message }]);
    assert.deepEqual(result.concurrentIndexFiles, ["a.txt"]);
    assert.equal(git(dir, ["show", "HEAD:a.txt"]), "captured");
    assert.equal(git(dir, ["show", ":a.txt"]), "newer staged");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("plan validation rejects invented, duplicate, and omitted files", () => {
  const dir = repo();
  try {
    writeFileSync(path.join(dir, "a.txt"), "a2\n");
    writeFileSync(path.join(dir, "b.txt"), "b2\n");
    const snapshot = captureSnapshot(dir, {});
    assert.throws(() => applyCommitPlan(snapshot, [{ files: ["a.txt", "missing"], message }]), /unknown file/);
    assert.throws(() => applyCommitPlan(snapshot, [{ files: ["a.txt"], message }, { files: ["a.txt", "b.txt"], message }]), /more than once/);
    assert.throws(() => applyCommitPlan(snapshot, [{ files: ["a.txt"], message }]), /omitted/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("cancel before transaction point leaves HEAD unchanged", () => {
  const dir = repo();
  try {
    writeFileSync(path.join(dir, "a.txt"), "cancel\n");
    const snapshot = captureSnapshot(dir, {});
    const before = git(dir, ["rev-parse", "HEAD"]);
    requestOperationCancel(snapshot);
    assert.throws(() => applyCommitPlan(snapshot, [{ files: snapshot.files, message }], { shouldAbort: () => true }), (e) => e.code === "CANCELLED");
    assert.equal(git(dir, ["rev-parse", "HEAD"]), before);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("real detached worker emits one result and journals it", async () => {
  const dir = repo();
  try {
    mkdirSync(path.join(dir, "docs"), { recursive: true });
    writeFileSync(path.join(dir, "a.txt"), "background\n");
    writeFileSync(path.join(dir, "docs", "note.md"), "# note\n");
    const snapshot = captureSnapshot(dir, {});
    const child = fork(workerPath, [], { stdio: ["ignore", "ignore", "ignore", "ipc"], serialization: "advanced" });
    const seen = [];
    const result = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("worker timeout")), 15000);
      child.on("message", (m) => { seen.push(m); if (m?.type === "result") { clearTimeout(timer); resolve(m); } });
      child.on("error", reject);
      child.send({ type: "start", params: { snapshot, config: { stagedCommits: true, messageMode: "deterministic", deterministicFallback: true }, request: {} } });
    });
    assert.equal(result.ok, true);
    assert.equal(seen.filter((m) => m?.type === "result").length, 1);
    assert.deepEqual(result.commits.flatMap((c) => c.files).sort(), [...snapshot.files].sort());
    const journals = readOperationResults(dir, { consume: true });
    assert.equal(journals.length, 1);
    assert.equal(journals[0].operationId, snapshot.id);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

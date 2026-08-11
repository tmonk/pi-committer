import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  buildFileGroups,
  deterministicMessage,
  generateCommitPlan,
  isValidCommitMessage,
  serializableModel,
} from "../src/message-engine.mjs";
import { captureSnapshot, matchesExclude, applyCommitPlan } from "../src/snapshot-engine.mjs";

const git = (dir, args) => execFileSync("git", args, { cwd: dir, encoding: "utf8" }).trim();

function repo() {
  const dir = mkdtempSync(path.join(tmpdir(), "pi-committer-msg-"));
  git(dir, ["init", "-q"]);
  git(dir, ["config", "user.email", "test@example.com"]);
  git(dir, ["config", "user.name", "Pi Committer Test"]);
  writeFileSync(path.join(dir, "base.txt"), "base\n");
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "-qm", "initial"]);
  return dir;
}

test("isValidCommitMessage accepts real conventional commits", () => {
  assert.equal(isValidCommitMessage("feat(api): add user authentication"), true);
  assert.equal(isValidCommitMessage("fix: correct the retry window\n\nBody with evidence."), true);
  assert.equal(isValidCommitMessage("docs: document the snapshot engine"), true);
});

test("isValidCommitMessage rejects generic, empty, and diff-artifact text", () => {
  assert.equal(isValidCommitMessage("update files"), false);
  assert.equal(isValidCommitMessage(""), false);
  assert.equal(isValidCommitMessage("  "), false);
  assert.equal(isValidCommitMessage("not conventional"), false);
  assert.equal(isValidCommitMessage("wat: unknown type here"), false);
  assert.equal(isValidCommitMessage("fix: update things"), false);
  assert.equal(isValidCommitMessage("fix: update files"), false);
  assert.equal(isValidCommitMessage("feat: ok\n\ndiff --git a/x.ts b/x.ts\n@@ -1 +1 @@"), false);
});

test("buildFileGroups partitions every snapshot path exactly once (gate 10)", () => {
  const files = [
    "src/server.ts",
    "src/client.ts",
    "tests/server.test.ts",
    "tests/client.test.ts",
    "docs/README.md",
    ".github/workflows/ci.yml",
    "package.json",
    "tsconfig.json",
  ];
  const groups = buildFileGroups(files, true);
  const seen = groups.flatMap((g) => g.files);
  assert.deepEqual([...seen].sort(), [...files].sort());
  assert.equal(new Set(seen).size, files.length, "no path may appear twice");
  assert.deepEqual(groups.map((g) => g.category), ["code", "test", "docs", "ci", "chore"]);
});

test("buildFileGroups returns a single group below the grouping threshold", () => {
  const groups = buildFileGroups(["src/server.ts"], true);
  assert.deepEqual(groups, [{ category: "code", files: ["src/server.ts"] }]);
});

test("buildFileGroups with stagedCommits=false never splits", () => {
  const files = ["src/server.ts", "tests/server.test.ts", "docs/README.md"];
  assert.deepEqual(buildFileGroups(files, false), [{ category: "code", files }]);
});

test("deterministicMessage output always passes validation", () => {
  const files = ["src/server.ts", "src/client.ts"];
  const message = deterministicMessage({ category: "code", files, diff: "+++ b/src/server.ts\n+export function retry() {}\n" });
  assert.equal(isValidCommitMessage(message), true);
  assert.match(message, /^fix\(src\): /);
  assert.ok(message.includes("captured immutable snapshot"));
});

test("deterministicMessage maps categories to conventional types", () => {
  for (const [category, file] of [
    ["docs", "docs/guide.md"],
    ["test", "tests/x.test.ts"],
    ["ci", ".github/workflows/ci.yml"],
    ["chore", "package.json"],
  ]) {
    const message = deterministicMessage({ category, files: [file], diff: "" });
    assert.equal(isValidCommitMessage(message), true, message);
    const header = message.split("\n")[0];
    assert.match(header, /^[a-z]+(\([^)]+\))?: .+/, message);
    assert.ok(header.startsWith(`${category}:`) || header.startsWith(`${category}(`), message);
  }
});

test("matchesExclude handles nested basename, prefix, and literal patterns (gate 11)", () => {
  assert.equal(matchesExclude("nested/deep/build.log", "*.log"), true);
  assert.equal(matchesExclude("a/b/x.log", "*.log"), true);
  assert.equal(matchesExclude("a/b/x.txt", "*.log"), false);
  assert.equal(matchesExclude("node_modules/pkg/index.js", "node_modules/"), true);
  assert.equal(matchesExclude("src/node_modules/x.js", "node_modules/"), true);
  assert.equal(matchesExclude("src/my-node_modules/x.js", "node_modules/"), false);
  assert.equal(matchesExclude("docs/guide.md", "docs/"), true);
  assert.equal(matchesExclude("src/docs/guide.md", "docs/"), true);
  assert.equal(matchesExclude("README.md", "CHANGELOG.md"), false);
  assert.equal(matchesExclude("a/CHANGELOG.md", "CHANGELOG.md"), true);
  assert.equal(matchesExclude("src/a.ts", "src/**"), true);
  assert.equal(matchesExclude("docs/guide.md", "build/**"), false);
});

test("exclusion globs are applied to the private snapshot index (gate 11, real git)", () => {
  const dir = repo();
  try {
    writeFileSync(path.join(dir, "a.ts"), "export const a = 1;\n");
    writeFileSync(path.join(dir, "build.log"), "artifact\n");
    const before = git(dir, ["write-tree"]);
    const snapshot = captureSnapshot(dir, { excludePatterns: ["*.log"] });
    assert.ok(snapshot, "snapshot exists");
    assert.equal(git(dir, ["write-tree"]), before, "real index must stay untouched");
    assert.deepEqual(snapshot.files, ["a.ts"]);
    assert.deepEqual(snapshot.excludedFiles, ["build.log"]);

    const result = applyCommitPlan(snapshot, [{ files: snapshot.files, message: "feat: add a" }]);
    assert.equal(result.commitCount, 1);
    assert.equal(git(dir, ["rev-list", "--count", "HEAD"]), "2");
    assert.match(git(dir, ["status", "--porcelain"]), /build\.log/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("generateCommitPlan produces a validated plan covering all files (no model)", async () => {
  const dir = repo();
  try {
    writeFileSync(path.join(dir, "server.ts"), "export function retry() {}\n");
    writeFileSync(path.join(dir, "server.test.ts"), "import test from 'node:test';\n");
    const snapshot = captureSnapshot(dir, {});
    const plan = await generateCommitPlan({
      snapshot,
      config: { stagedCommits: true, messageMode: "deterministic", deterministicFallback: true },
      request: {},
    });
    const planned = plan.flatMap((g) => g.files);
    assert.deepEqual([...planned].sort(), [...snapshot.files].sort());
    for (const group of plan) assert.equal(isValidCommitMessage(group.message), true);
    assert.ok(plan.length >= 2, "code + test files should group");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("serializableModel strips non-serializable values", () => {
  assert.equal(serializableModel(undefined), undefined);
  // Functions are dropped by the JSON round-trip; provider+id survives.
  assert.deepEqual(serializableModel({ provider: "openai", id: "gpt-4o", run: () => {} }), {
    provider: "openai",
    id: "gpt-4o",
  });
  const safe = serializableModel({ provider: "openai", id: "gpt-4o", meta: { x: 1 }, run: () => {} });
  assert.deepEqual(safe, { provider: "openai", id: "gpt-4o", meta: { x: 1 } });
});

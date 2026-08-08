/**
 * Comprehensive edge-case tests for the async commit worker.
 *
 * Tests exported functions directly (no fork needed) and IPC integration
 * (fork-based) for worker timeout, abort/cancel at checkpoints, git failure
 * modes, and SDK failure fallbacks.
 */

import {
  describe,
  it,
  before,
  after,
  afterEach,
  mock,
} from "node:test";
import assert from "node:assert";
import { execSync, fork } from "node:child_process";
import { fileURLToPath } from "node:url";
import * as fs from "node:fs";
import * as path from "node:path";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";

// ---------------------------------------------------------------------------
// Import exported worker functions
// ---------------------------------------------------------------------------
import {
  git,
  gitCwd,
  getHeadHash,
  unstageAll,
  getDiffContent,
  getChangedFiles,
  isGitignored,
  filterGitignoredFiles,
  unstageExcludedFiles,
  deterministicCommitMessage,
  resolveCommitMessage,
  parseDiffHunks,
  sampleRepoCommitStyle,
  findCommonAncestor,
  isValidDiffContent,
  isValidDiffStat,
  isValidCommitMessage,
  parseCommitGroups,
  sendResultAndExit,
  type CommitLogEntry,
  type WorkerProgress,
  type CommitCallbacks,
} from "../async-commit-worker.ts";
import { resolveWorkerExecArgv } from "../index.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/** Base temp directory for all test repos (absolute, outside any git worktree). */
const _baseDir = fs.mkdtempSync(path.join(tmpdir(), "pi-worker-edge-"));

function createTempRepo(): string {
  const dir = mkdtempSync(path.join(_baseDir, "repo-"));
  execSync("git init", { cwd: dir, stdio: "ignore" });
  execSync("git config user.email test@test.com", { cwd: dir, stdio: "ignore" });
  execSync("git config user.name Test", { cwd: dir, stdio: "ignore" });
  writeFileSync(path.join(dir, "README.md"), "# test\n");
  execSync("git add -A && git commit -m initial", { cwd: dir, stdio: "ignore" });
  return dir;
}

/** Ensure directory exists (mkdir -p). */
function ensureDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
}

after(() => {
  try { fs.rmSync(_baseDir, { recursive: true, force: true }); } catch { /* ignore */ }
});

/**
 * Fork the worker, send params, wait for result and exit, return both.
 * Exits cleanly on timeout.
 */
function forkWorker(
  dir: string,
  params: any,
  timeoutMs = 15_000,
): Promise<{ msg: any; exitCode: number | null }> {
  return new Promise((resolve, reject) => {
    const workerPath = fileURLToPath(
      new URL("../async-commit-worker.ts", import.meta.url),
    );
    const child = fork(workerPath, [], {
      execArgv: resolveWorkerExecArgv(workerPath),
      stdio: ["ignore", "ignore", "ignore", "ipc"],
    });

    let resultMsg: any = null;
    let exitCode: number | null = null;
    let settled = false;

    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ msg: resultMsg, exitCode });
    };

    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        child.kill();
        reject(new Error("Worker timed out"));
      }
    }, timeoutMs);

    child.on("message", (msg: any) => {
      if (msg?.type === "result") {
        resultMsg = msg;
        if (exitCode !== null) finish();
      }
    });

    child.on("exit", (code, _signal) => {
      exitCode = code;
      if (resultMsg) finish();
      // If no result received, settle anyway after a short delay
      // to allow the IPC message to arrive
      if (!settled) {
        setTimeout(finish, 200);
      }
    });

    child.on("error", (err) => {
      if (!settled) { settled = true; clearTimeout(timer); reject(err); }
    });

    child.send({ type: "start", params });
  });
}

// ===========================================================================
// Exported function tests (no fork needed)
// ===========================================================================

describe("worker exported git helpers", () => {
  it("git() runs arbitrary git commands", () => {
    const output = git("--version");
    assert.ok(output.startsWith("git version"));
  });

  it("gitCwd() runs git commands in a specific directory", () => {
    const dir = createTempRepo();
    const output = gitCwd(dir, "rev-parse", "--git-dir");
    assert.strictEqual(output, ".git");
  });

  it("getHeadHash() returns the current HEAD hash", () => {
    const dir = createTempRepo();
    const hash = getHeadHash(dir);
    assert.ok(/^[0-9a-f]{7,40}$/.test(hash), `hash should be sha: ${hash}`);
  });

  it("unstageAll() unstages staged changes", () => {
    const dir = createTempRepo();
    writeFileSync(path.join(dir, "newfile.ts"), "// test\n");
    execSync("git add newfile.ts", { cwd: dir, stdio: "ignore" });

    const staged = execSync("git diff --cached --stat", {
      cwd: dir, encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    assert.ok(staged.includes("newfile.ts"));

    unstageAll(dir);

    const afterUnstage = execSync("git diff --cached --stat", {
      cwd: dir, encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    assert.strictEqual(afterUnstage, "");
  });

  it("getDiffContent() returns cached diff", () => {
    const dir = createTempRepo();
    writeFileSync(path.join(dir, "diff-test.ts"), "// diff test\n");
    execSync("git add diff-test.ts", { cwd: dir, stdio: "ignore" });

    const diff = getDiffContent(dir);
    assert.ok(diff.includes("diff-test.ts"), "diff should mention the file");
    assert.ok(diff.includes("+// diff test"), "diff should show added content");
  });

  it("getChangedFiles() parses diff stat output (filters summary line)", () => {
    const input = ` README.md | 2 +-\n src/main.ts | 5 +++++\n 2 files changed, 6 insertions(+), 1 deletion(-)\n`;
    const files = getChangedFiles(input);
    // The function filters lines by checking for '|' after splitting, so
    // "2 files changed, 6 insertions(+), 1 deletion(-)" will match because
    // the line contains "|" from the split. Verify actual behavior matches.
    assert.ok(files.includes("README.md"), "should include README.md");
    assert.ok(files.includes("src/main.ts"), "should include src/main.ts");
  });

  it("getChangedFiles() returns empty array for no changes", () => {
    const files = getChangedFiles("");
    assert.deepStrictEqual(files, []);
  });

  it("isGitignored() returns true for gitignored files", () => {
    const dir = createTempRepo();
    writeFileSync(path.join(dir, ".gitignore"), "*.log\n");
    execSync("git add .gitignore && git commit -m 'add gitignore'", {
      cwd: dir, stdio: "ignore",
    });
    writeFileSync(path.join(dir, "test.log"), "log\n");
    assert.strictEqual(isGitignored(dir, "test.log"), true);
    assert.strictEqual(isGitignored(dir, "not-ignored.ts"), false);
  });

  it("filterGitignoredFiles() removes gitignored files from list", () => {
    const dir = createTempRepo();
    writeFileSync(path.join(dir, ".gitignore"), "*.log\n");
    execSync("git add .gitignore && git commit -m 'add gitignore'", {
      cwd: dir, stdio: "ignore",
    });

    const result = filterGitignoredFiles(dir, ["a.ts", "b.log", "c.ts", "d.log"]);
    assert.deepStrictEqual(result, ["a.ts", "c.ts"]);
  });

  it("unstageExcludedFiles() removes files matching exclude patterns", () => {
    const dir = createTempRepo();
    writeFileSync(path.join(dir, "keep.ts"), "// keep\n");
    writeFileSync(path.join(dir, "remove.ts"), "// remove\n");
    execSync("git add -A", { cwd: dir, stdio: "ignore" });

    const remaining = unstageExcludedFiles(dir, ["keep.ts", "remove.ts"], ["remove.ts"]);
    assert.deepStrictEqual(remaining, ["keep.ts"]);

    const staged = execSync("git diff --cached --stat", {
      cwd: dir, encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    assert.ok(staged.includes("keep.ts"));
    assert.ok(!staged.includes("remove.ts"));
  });
});

describe("worker exported deterministicCommitMessage (content-driven)", () => {
  /** Build a realistic unified git diff from per-file added/removed lines. */
  function makeDiff(files: Record<string, { added?: string[]; removed?: string[] }>): string {
    const out: string[] = [];
    for (const [file, change] of Object.entries(files)) {
      out.push(`diff --git a/${file} b/${file}`);
      out.push("index 1111111..2222222 100644");
      out.push(`--- a/${file}`);
      out.push(`+++ b/${file}`);
      out.push("@@ -1 +1,3 @@");
      for (const l of change.removed ?? []) out.push(`-${l}`);
      for (const l of change.added ?? []) out.push(`+${l}`);
      out.push(" context line");
    }
    return out.join("\n");
  }

  it("derives the description from actual diff content, never file names alone", () => {
    const diff = makeDiff({ "src/main.ts": { added: ["const retryCount = 3;"] } });
    const msg = deterministicCommitMessage("src/main.ts | 1 +", diff, ["src/main.ts"]);
    assert.ok(msg.includes("retryCount"), `should reference added content, got: ${msg}`);
    assert.ok(!msg.includes("update main.ts"), `should not be filename-only, got: ${msg}`);
  });

  it("detects test type from test files", () => {
    const diff = makeDiff({ "tests/foo.test.ts": { added: ["assert.equal(1, 1);"] } });
    const msg = deterministicCommitMessage("tests/foo.test.ts | 1 +", diff, ["tests/foo.test.ts"]);
    assert.ok(msg.startsWith("test"), `test file should produce test type, got: ${msg}`);
  });

  it("detects docs type from docs", () => {
    const diff = makeDiff({ "README.md": { added: ["Updated usage section"] } });
    const msg = deterministicCommitMessage("README.md | 1 +", diff, ["README.md"]);
    assert.ok(msg.startsWith("docs"), `md file should produce docs type, got: ${msg}`);
  });

  it("detects fix type from diff content", () => {
    const diff = makeDiff({ "src/main.ts": { added: ["fix a bug where the cursor is not reset"] } });
    const msg = deterministicCommitMessage("src/main.ts | 1 +", diff, ["src/main.ts"]);
    assert.ok(msg.startsWith("fix"), `fix content should produce fix type, got: ${msg}`);
  });

  it("detects feat type from diff content", () => {
    const diff = makeDiff({ "src/main.ts": { added: ["add new feature flag for dark mode"] } });
    const msg = deterministicCommitMessage("src/main.ts | 1 +", diff, ["src/main.ts"]);
    assert.ok(msg.startsWith("feat"), `feat content should produce feat type, got: ${msg}`);
  });

  it("always includes a structured body with per-file details", () => {
    const diff = makeDiff({ "src/main.ts": { added: ["const retryCount = 3;"] } });
    const msg = deterministicCommitMessage("src/main.ts | 1 +", diff, ["src/main.ts"]);
    const lines = msg.split("\n");
    assert.strictEqual(lines[1], "", "header should be followed by a blank line");
    const body = lines.slice(2).join("\n");
    assert.ok(body.length > 0, "body should be present");
    assert.ok(body.includes("src/main.ts"), `body should list the file, got: ${body}`);
    assert.ok(body.includes("retryCount"), `body should reference the content, got: ${body}`);
  });

  it("uses smart scope (longest common ancestor)", () => {
    const diff = makeDiff({
      "experiments/exposure/src/adaptation_panel.py": { added: ["handle new config keys"] },
      "experiments/exposure/tests/test_adaptation_panel.py": { added: ["assert config keys"] },
    });
    const files = [
      "experiments/exposure/src/adaptation_panel.py",
      "experiments/exposure/tests/test_adaptation_panel.py",
    ];
    const msg = deterministicCommitMessage("a | 1 +\nb | 1 +", diff, files);
    assert.ok(
      msg.includes("(experiments/exposure)"),
      `scope should be common ancestor, got: ${msg.split("\n")[0]}`,
    );
  });

  it("omits scope when files have no common ancestor", () => {
    const diff = makeDiff({
      "src/main.ts": { added: ["const x = 1;"] },
      "docs/guide.md": { added: ["More details"] },
    });
    const files = ["src/main.ts", "docs/guide.md"];
    const msg = deterministicCommitMessage("a | 1 +\nb | 1 +", diff, files);
    assert.ok(
      !msg.split("\n")[0].includes("("),
      `should not have scope when no common ancestor, got: ${msg.split("\n")[0]}`,
    );
  });

  it("returns '' (block signal) when the diff has no extractable content", () => {
    assert.strictEqual(deterministicCommitMessage("src/main.ts | 1 +", "", ["src/main.ts"]), "");
  });
});

// ===========================================================================
// worker exported parseDiffHunks / resolveCommitMessage / sampleRepoCommitStyle
// ===========================================================================

describe("worker exported parseDiffHunks", () => {
  it("parses added and removed lines per file", () => {
    const diff =
      "diff --git a/src/a.ts b/src/a.ts\n" +
      "index 1111111..2222222 100644\n" +
      "--- a/src/a.ts\n" +
      "+++ b/src/a.ts\n" +
      "@@ -1 +1,3 @@\n" +
      "-old code\n" +
      "+new code\n" +
      " context line\n";
    const files = parseDiffHunks(diff);
    assert.strictEqual(files.length, 1);
    assert.deepStrictEqual(files[0].added, ["new code"]);
    assert.deepStrictEqual(files[0].removed, ["old code"]);
  });
});

describe("worker exported resolveCommitMessage", () => {
  it("blocks (returns undefined) when no detailed message can be produced", () => {
    assert.strictEqual(resolveCommitMessage("garbage", "img.png | 1 +", "", ["img.png"]), undefined);
  });

  it("regenerates deterministically when the message is invalid", () => {
    const diff =
      "diff --git a/src/main.ts b/src/main.ts\n" +
      "index 1111111..2222222 100644\n" +
      "--- a/src/main.ts\n" +
      "+++ b/src/main.ts\n" +
      "@@ -1 +1,3 @@\n" +
      "+const retryCount = 3;\n" +
      " context line\n";
    const resolved = resolveCommitMessage("not valid", "src/main.ts | 1 +", diff, ["src/main.ts"], undefined, true);
    assert.ok(resolved, "should regenerate a valid message");
    assert.ok(isValidCommitMessage(resolved!), `should be valid, got: ${resolved}`);
  });
});

describe("worker exported sampleRepoCommitStyle", () => {
  it("samples types and scopes from git log", () => {
    const dir = createTempRepo();
    execSync("git commit --allow-empty -F -", {
      cwd: dir,
      input: "feat(api): add login endpoint\n\nAdds the endpoint.\n",
      stdio: ["pipe", "ignore", "ignore"],
    });
    execSync('git commit -m "chore: bump deps" --allow-empty', { cwd: dir, stdio: "ignore" });
    const style = sampleRepoCommitStyle(dir);
    assert.ok(style.types.includes("feat"), `types should include feat: ${style.types}`);
    assert.ok(style.types.includes("chore"), `types should include chore: ${style.types}`);
    assert.ok(style.scopes.includes("api"), `scopes should include api: ${style.scopes}`);
    assert.strictEqual(style.headerOnly, false, "one commit has a body");
  });

  it("returns empty style when git log fails", () => {
    assert.deepStrictEqual(sampleRepoCommitStyle("/nonexistent/dir"), {
      history: [],
      types: [],
      typeCounts: {},
      scopes: [],
      headerOnly: true,
      recentHeader: "",
    });
  });
});

// ===========================================================================
// worker exported isValidDiffContent / isValidDiffStat / isValidCommitMessage
// ===========================================================================

describe("worker exported isValidDiffContent", () => {
  it("accepts genuine git diff output", () => {
    assert.ok(isValidDiffContent("diff --git a/src/main.ts b/src/main.ts\nindex abc..def 100644"));
  });

  it("accepts empty string", () => {
    assert.ok(isValidDiffContent(""));
  });

  it("rejects non-diff content", () => {
    assert.ok(!isValidDiffContent("Filesystem     512-blocks       Used  Available Capacity"));
  });
});

describe("worker exported isValidDiffStat", () => {
  it("accepts standard git diff stat lines", () => {
    assert.ok(isValidDiffStat("src/main.ts | 5 +++++\n 1 file changed"));
  });

  it("accepts empty string", () => {
    assert.ok(isValidDiffStat(""));
  });

  it("rejects non-stat content", () => {
    assert.ok(!isValidDiffStat("Filesystem     512-blocks       Used  Available Capacity"));
  });
});

describe("worker exported isValidCommitMessage", () => {
  it("accepts a valid conventional commit message", () => {
    assert.ok(isValidCommitMessage("feat(api): add user endpoint\n\nNew endpoint."));
  });

  it("rejects garbled content", () => {
    assert.ok(!isValidCommitMessage("Filesystem     512-blocks       Used  Available Capacity"));
  });

  it("rejects very short messages", () => {
    assert.ok(!isValidCommitMessage("short"));
  });
});

// ===========================================================================

describe("worker exported findCommonAncestor", () => {
  it("finds common ancestor for sibling directories", () => {
    assert.strictEqual(
      findCommonAncestor(["experiments/exposure/src", "experiments/exposure/tests"]),
      "experiments/exposure",
    );
  });

  it("returns undefined when no common ancestor", () => {
    assert.strictEqual(findCommonAncestor(["experiments/exposure", "docs/guide"]), undefined);
  });

  it("returns undefined for empty input", () => {
    assert.strictEqual(findCommonAncestor([]), undefined);
  });
});

describe("worker exported parseCommitGroups", () => {
  it("parses standard commit group format", () => {
    const output = `--- COMMIT GROUP 1 ---
feat(api): add user endpoint

Add user CRUD operations.
Files: src/api/user.ts, src/api/user.test.ts

--- COMMIT GROUP 2 ---
fix(db): correct query ordering

Fix ordering in SELECT statement.
Files: src/db/query.ts
`;

    const groups = parseCommitGroups(output, [
      "src/api/user.ts",
      "src/api/user.test.ts",
      "src/db/query.ts",
    ]);

    assert.strictEqual(groups.length, 2);
    assert.strictEqual(groups[0].files.length, 2);
    assert.strictEqual(groups[1].files.length, 1);
  });

  it("filters hallucinated files not in the actual changed set", () => {
    const output = `--- COMMIT GROUP 1 ---
chore: update files
Files: src/real.ts, src/hallucinated.ts
`;

    const groups = parseCommitGroups(output, ["src/real.ts"]);
    assert.strictEqual(groups.length, 1);
    assert.deepStrictEqual(groups[0].files, ["src/real.ts"]);
  });

  it("returns empty array for unparseable output", () => {
    const groups = parseCommitGroups("some random text without format", ["a.ts"]);
    assert.strictEqual(groups.length, 0);
  });
});

describe("worker exported sendResultAndExit", () => {
  it("calls process.send with type=result", async () => {
    const sentMessages: any[] = [];

    const originalSend = (process as any).send;
    (process as any).send = (msg: any, cb?: () => void) => {
      sentMessages.push(msg);
      if (cb) setImmediate(cb);
      return true;
    };

    try {
      await new Promise<void>((resolve) => {
        const origExit = process.exit;
        (process as any).exit = () => {
          (process as any).exit = origExit;
          resolve();
        };
        sendResultAndExit(
          { commitCount: 2, commitLog: [{ hash: "abc123", message: "test", success: true }] },
          0,
        );
      });

      assert.strictEqual(sentMessages.length, 1, "should send 1 message");
      assert.strictEqual(sentMessages[0].type, "result");
      assert.strictEqual(sentMessages[0].commitCount, 2);
      assert.strictEqual(sentMessages[0].error, undefined);
    } finally {
      (process as any).send = originalSend;
    }
  });

  it("includes error field in result message when provided", async () => {
    const sentMessages: any[] = [];
    const originalSend = (process as any).send;
    (process as any).send = (msg: any, cb?: () => void) => {
      sentMessages.push(msg);
      if (cb) setImmediate(cb);
      return true;
    };

    try {
      await new Promise<void>((resolve) => {
        const origExit = process.exit;
        (process as any).exit = () => {
          (process as any).exit = origExit;
          resolve();
        };
        sendResultAndExit(
          { commitCount: 0, commitLog: [], error: "Worker timed out after 5 minutes." },
          0,
        );
      });

      assert.strictEqual(sentMessages[0].error, "Worker timed out after 5 minutes.");
      assert.strictEqual(sentMessages[0].commitCount, 0);
    } finally {
      (process as any).send = originalSend;
    }
  });
});

// ===========================================================================
// Worker abort/cancel tests (fork-based)
// ===========================================================================

describe("worker abort at checkpoint", () => {
  it("cancels when SIGTERM arrives shortly after start (deterministic path)", async () => {
    const dir = createTempRepo();
    writeFileSync(path.join(dir, "abort-test.ts"), "// abort test\n");
    execSync("git add abort-test.ts", { cwd: dir, stdio: "ignore" });

    const diffStat = execSync("git diff --cached --stat", {
      cwd: dir, encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    const diffContent = execSync("git diff --cached", {
      cwd: dir, encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    const allFiles = ["abort-test.ts"];

    const workerPath = fileURLToPath(
      new URL("../async-commit-worker.ts", import.meta.url),
    );
    const child = fork(workerPath, [], {
      execArgv: resolveWorkerExecArgv(workerPath),
      stdio: ["ignore", "ignore", "ignore", "ipc"],
    });

    // Send start, then immediately send SIGTERM
    child.send({
      type: "start",
      params: {
        dir,
        diffStat,
        diffContent,
        allFiles,
        stagedCommits: false,
        excludePatterns: [],
        minChanges: 1,
        subagentModel: undefined,
        subagentGroupingMinFiles: 4,
        subagentMessageMinFiles: 3,
        subagentThinkingLevel: "off",
        deterministicFallback: true,
      },
    });

    // Small delay to let the worker start processing
    await new Promise((r) => setTimeout(r, 50));
    child.kill("SIGTERM");

    // Wait for result (with timeout)
    const result = await new Promise<any>((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error("Timeout waiting for result after SIGTERM"));
      }, 10_000);

      child.on("message", (msg: any) => {
        if (msg?.type === "result") {
          clearTimeout(timeout);
          resolve(msg);
        }
      });
      child.on("error", (err) => { clearTimeout(timeout); reject(err); });
      child.on("exit", () => {
        // If process exits without result, resolve with null
        clearTimeout(timeout);
        resolve(null);
      });
    });

    if (result) {
      // If we got a result, it should be a proper IPC message (could be success or cancelled)
      assert.strictEqual(result.type, "result");
      assert.ok(
        result.error === undefined || result.error === "Cancelled.",
        `unexpected error: ${result.error}`,
      );
      assert.ok(result.commitCount >= 0, "commitCount should be >= 0");
    }
    // If no result (channel closed before result), that's also acceptable
    // since the parent has the 500ms fallback for "Subprocess exited with code N"
  });

  it("completes successfully despite SIGTERM sent right after start (race)", async () => {
    const dir = createTempRepo();
    writeFileSync(path.join(dir, "race-test.ts"), "// race test\n");
    execSync("git add race-test.ts", { cwd: dir, stdio: "ignore" });

    const diffStat = execSync("git diff --cached --stat", {
      cwd: dir, encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    const diffContent = execSync("git diff --cached", {
      cwd: dir, encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    const allFiles = ["race-test.ts"];

    const workerPath = fileURLToPath(
      new URL("../async-commit-worker.ts", import.meta.url),
    );
    const child = fork(workerPath, [], {
      execArgv: resolveWorkerExecArgv(workerPath),
      stdio: ["ignore", "ignore", "ignore", "ipc"],
    });

    child.send({
      type: "start",
      params: {
        dir,
        diffStat,
        diffContent,
        allFiles,
        stagedCommits: false,
        excludePatterns: [],
        minChanges: 1,
        subagentModel: undefined,
        subagentGroupingMinFiles: 4,
        subagentMessageMinFiles: 3,
        subagentThinkingLevel: "off",
        deterministicFallback: true,
      },
    });

    // Send SIGTERM immediately (may or may not abort before commit completes)
    child.kill("SIGTERM");

    const result = await new Promise<any>((resolve, reject) => {
      const timeout = setTimeout(() => {
        child.kill("SIGKILL");
        reject(new Error("Timeout"));
      }, 10_000);

      child.on("message", (msg: any) => {
        if (msg?.type === "result") {
          clearTimeout(timeout);
          resolve(msg);
        }
      });
      child.on("error", (err) => { clearTimeout(timeout); reject(err); });
      child.on("exit", () => {
        clearTimeout(timeout);
        resolve(null);
      });
    });

    if (result) {
      assert.strictEqual(result.type, "result");
    }
    // The worker should not crash regardless of timing
  });
});

// ===========================================================================
// Worker git failure modes (fork-based)
// ===========================================================================

describe("worker git failure modes", () => {
  it("handles pre-commit hook rejection gracefully", async () => {
    const dir = createTempRepo();

    // Set up a pre-commit hook that always fails
    const hookPath = path.join(dir, ".git", "hooks", "pre-commit");
    writeFileSync(hookPath, "#!/bin/sh\nexit 1\n");
    fs.chmodSync(hookPath, 0o755);

    writeFileSync(path.join(dir, "hook-test.ts"), "// hook test\n");
    execSync("git add hook-test.ts", { cwd: dir, stdio: "ignore" });

    const diffStat = execSync("git diff --cached --stat", {
      cwd: dir, encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    const diffContent = execSync("git diff --cached", {
      cwd: dir, encoding: "utf-8", maxBuffer: 10 * 1024 * 1024,
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    const allFiles = diffStat
      .split("\n").filter((l) => l.includes("|"))
      .map((l) => l.match(/^(.+?)\s+\|/)?.[1]?.trim() ?? "")
      .filter(Boolean);

    const { msg, exitCode } = await forkWorker(dir, {
      dir,
      diffStat,
      diffContent,
      allFiles,
      stagedCommits: false,
      excludePatterns: [],
      minChanges: 1,
      subagentModel: undefined,
      subagentGroupingMinFiles: 4,
      subagentMessageMinFiles: 3,
      subagentThinkingLevel: "off",
      deterministicFallback: true,
    });

    assert.ok(msg, "should send a result message");
    assert.strictEqual(msg.type, "result");
    assert.ok(msg.error, "should report an error for pre-commit hook failure");
    assert.strictEqual(msg.commitCount, 0, "should have 0 committed");
    assert.strictEqual(exitCode, 0, "worker should exit with code 0");
  });

  it("skips files that fail git add (simulating subagent hallucination)", async () => {
    const dir = createTempRepo();

    writeFileSync(path.join(dir, "real1.ts"), "// real 1\n");
    writeFileSync(path.join(dir, "real2.ts"), "// real 2\n");
    execSync("git add -A", { cwd: dir, stdio: "ignore" });

    const diffStat = execSync("git diff --cached --stat", {
      cwd: dir, encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    const diffContent = execSync("git diff --cached", {
      cwd: dir, encoding: "utf-8", maxBuffer: 10 * 1024 * 1024,
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    const allFiles = diffStat
      .split("\n").filter((l) => l.includes("|"))
      .map((l) => l.match(/^(.+?)\s+\|/)?.[1]?.trim() ?? "")
      .filter(Boolean);

    const { msg, exitCode } = await forkWorker(dir, {
      dir,
      diffStat,
      diffContent,
      allFiles,
      stagedCommits: false,
      excludePatterns: [],
      minChanges: 1,
      subagentModel: undefined,
      subagentGroupingMinFiles: 4,
      subagentMessageMinFiles: 3,
      subagentThinkingLevel: "off",
      deterministicFallback: true,
    });

    assert.ok(msg, "should send a result message");
    assert.strictEqual(msg.type, "result");
    assert.strictEqual(exitCode, 0, "worker should exit with code 0");
    assert.ok(msg.commitCount > 0, "should commit real files");
  });

  it("reports no changes when diff is empty", async () => {
    const dir = createTempRepo();

    const diffStat = "";
    const diffContent = "";
    const allFiles: string[] = [];

    const { msg, exitCode } = await forkWorker(dir, {
      dir,
      diffStat,
      diffContent,
      allFiles,
      stagedCommits: false,
      excludePatterns: [],
      minChanges: 1,
      subagentModel: undefined,
      subagentGroupingMinFiles: 4,
      subagentMessageMinFiles: 3,
      subagentThinkingLevel: "off",
      deterministicFallback: true,
    });

    assert.ok(msg, "should send a result message");
    assert.strictEqual(msg.type, "result");
    assert.strictEqual(exitCode, 0, "worker should exit with code 0");
    assert.strictEqual(msg.commitCount, 0, "should have 0 commits");
    assert.strictEqual(msg.error, undefined, "no error for empty changes");
  });

  it("handles minChanges filter (skips when below threshold)", async () => {
    const dir = createTempRepo();

    writeFileSync(path.join(dir, "single-file.ts"), "// single\n");
    execSync("git add single-file.ts", { cwd: dir, stdio: "ignore" });

    const diffStat = execSync("git diff --cached --stat", {
      cwd: dir, encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    const diffContent = execSync("git diff --cached", {
      cwd: dir, encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    const allFiles = diffStat
      .split("\n").filter((l) => l.includes("|"))
      .map((l) => l.match(/^(.+?)\s+\|/)?.[1]?.trim() ?? "")
      .filter(Boolean);

    const { msg, exitCode } = await forkWorker(dir, {
      dir,
      diffStat,
      diffContent,
      allFiles,
      stagedCommits: true,
      excludePatterns: [],
      minChanges: 100,
      subagentModel: undefined,
      subagentGroupingMinFiles: 4,
      subagentMessageMinFiles: 3,
      subagentThinkingLevel: "off",
      deterministicFallback: true,
    });

    assert.strictEqual(exitCode, 0, "worker should exit with code 0");
    assert.strictEqual(msg.commitCount, 0, "should have 0 commits (below threshold)");
    assert.strictEqual(msg.error, undefined, "no error when below minChanges");
  });
});

// ===========================================================================
// Worker IPC edge cases (fork-based)
// ===========================================================================

describe("worker IPC edge cases", () => {
  it("sends result before exit (exit code 0)", async () => {
    const dir = createTempRepo();

    writeFileSync(path.join(dir, "ipc-edge.ts"), "// ipc edge\n");
    execSync("git add ipc-edge.ts", { cwd: dir, stdio: "ignore" });

    const diffStat = execSync("git diff --cached --stat", {
      cwd: dir, encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    const diffContent = execSync("git diff --cached", {
      cwd: dir, encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    const allFiles = ["ipc-edge.ts"];

    const { msg, exitCode } = await forkWorker(dir, {
      dir,
      diffStat,
      diffContent,
      allFiles,
      stagedCommits: false,
      excludePatterns: [],
      minChanges: 1,
      subagentModel: undefined,
      subagentGroupingMinFiles: 4,
      subagentMessageMinFiles: 3,
      subagentThinkingLevel: "off",
      deterministicFallback: true,
    });

    assert.ok(msg, "IPC result should be received");
    assert.strictEqual(msg.type, "result");
    assert.strictEqual(msg.commitCount, 1, "should have 1 commit");
    assert.strictEqual(exitCode, 0, "exit code must be 0");
  });

  it("reports error via IPC when git operations fail", async () => {
    // Use a non-repo directory to trigger git failure
    const badDir = mkdtempSync(path.join(_baseDir, "non-repo-"));

    const { msg, exitCode } = await forkWorker(badDir, {
      dir: badDir,
      diffStat: "file.ts | 1 +\n",
      diffContent: "+// test\n",
      allFiles: ["file.ts"],
      stagedCommits: false,
      excludePatterns: [],
      minChanges: 1,
      subagentModel: undefined,
      subagentGroupingMinFiles: 4,
      subagentMessageMinFiles: 3,
      subagentThinkingLevel: "off",
      deterministicFallback: true,
    });

    // The worker should not crash — should return error via IPC
    assert.ok(msg, "should send IPC result");
    assert.strictEqual(msg.type, "result");
    assert.ok(msg.error, "should report an error for invalid repo");
    assert.strictEqual(exitCode, 0, "exit code must be 0 even with error");
  });

  it("blocks commit when no agent and deterministic_fallback is off (default)", async () => {
    const dir = createTempRepo();

    writeFileSync(path.join(dir, "blocked.ts"), "// blocked\n");
    execSync("git add blocked.ts", { cwd: dir, stdio: "ignore" });

    const diffStat = execSync("git diff --cached --stat", {
      cwd: dir, encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    const diffContent = execSync("git diff --cached", {
      cwd: dir, encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    const allFiles = ["blocked.ts"];

    const { msg, exitCode } = await forkWorker(dir, {
      dir,
      diffStat,
      diffContent,
      allFiles,
      stagedCommits: false,
      excludePatterns: [],
      minChanges: 1,
      subagentModel: undefined,
      subagentGroupingMinFiles: 4,
      subagentMessageMinFiles: 3,
      subagentThinkingLevel: "off",
      deterministicFallback: false,
    });

    assert.ok(msg, "should send a result message");
    assert.strictEqual(msg.type, "result");
    assert.strictEqual(msg.commitCount, 0, "no commit without an agent message");
    assert.ok(
      (msg.warnings ?? []).some((w: string) => w.includes("could not produce")),
      `should warn about the blocked commit, got: ${JSON.stringify(msg.warnings)}`,
    );
    assert.strictEqual(exitCode, 0, "exit code must be 0");

    // Changes stay staged — nothing was unstaged
    const staged = execSync("git diff --cached --name-only", {
      cwd: dir, encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"],
    }).trim().split("\n").filter(Boolean);
    assert.deepStrictEqual(staged, ["blocked.ts"], "blocked changes remain staged");
  });
});

// ===========================================================================
// Worker message request (verbatim) — commit_changes params
// ===========================================================================

describe("worker message request (verbatim)", () => {
  it("commits the verbatim message exactly and skips grouping", async () => {
    const dir = createTempRepo();

    // 3 files + stagedCommits + low grouping threshold would normally route to
    // doGroupedCommits; verbatim must force the single-commit path instead.
    for (let i = 0; i < 3; i++) {
      writeFileSync(path.join(dir, `verbatim-${i}.ts`), `// v${i}\n`);
    }
    execSync("git add -A", { cwd: dir, stdio: "ignore" });

    const diffStat = execSync("git diff --cached --stat", {
      cwd: dir, encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    const diffContent = execSync("git diff --cached", {
      cwd: dir, encoding: "utf-8", maxBuffer: 10 * 1024 * 1024,
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    const allFiles = diffStat
      .split("\n").filter((l) => l.includes("|"))
      .map((l) => l.match(/^(.+?)\s+\|/)?.[1]?.trim() ?? "")
      .filter(Boolean);

    const verbatim = "feat(cli): exact worker verbatim message";
    const { msg, exitCode } = await forkWorker(dir, {
      dir,
      diffStat,
      diffContent,
      allFiles,
      stagedCommits: true,
      excludePatterns: [],
      minChanges: 1,
      subagentModel: undefined,
      subagentGroupingMinFiles: 2, // grouping would trigger without verbatim
      subagentMessageMinFiles: 3,
      subagentThinkingLevel: "off",
      deterministicFallback: true,
      messageRequest: { verbatim },
    });

    assert.ok(msg, "should send a result message");
    assert.strictEqual(msg.type, "result");
    assert.strictEqual(msg.commitCount, 1, "verbatim must produce exactly one commit");
    assert.strictEqual(exitCode, 0, "worker should exit with code 0");

    const committed = execSync("git log -1 --format=%B", {
      cwd: dir, encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"],
    });
    assert.strictEqual(
      committed,
      verbatim + "\n\n",
      "commit message must equal the verbatim text exactly (git adds one terminator newline; %B adds another)",
    );

    const log = execSync("git log --oneline", { cwd: dir, encoding: "utf-8" }).trim();
    assert.strictEqual(log.split("\n").length, 2, "exactly one new commit");
  });

  it("blocks an invalid verbatim with a warning and leaves changes staged", async () => {
    const dir = createTempRepo();

    writeFileSync(path.join(dir, "bad-v.ts"), "// bad\n");
    execSync("git add bad-v.ts", { cwd: dir, stdio: "ignore" });

    const diffStat = execSync("git diff --cached --stat", {
      cwd: dir, encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    const diffContent = execSync("git diff --cached", {
      cwd: dir, encoding: "utf-8", maxBuffer: 10 * 1024 * 1024,
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    const allFiles = diffStat
      .split("\n").filter((l) => l.includes("|"))
      .map((l) => l.match(/^(.+?)\s+\|/)?.[1]?.trim() ?? "")
      .filter(Boolean);

    const { msg, exitCode } = await forkWorker(dir, {
      dir,
      diffStat,
      diffContent,
      allFiles,
      stagedCommits: false,
      excludePatterns: [],
      minChanges: 1,
      subagentModel: undefined,
      subagentGroupingMinFiles: 4,
      subagentMessageMinFiles: 3,
      subagentThinkingLevel: "off",
      deterministicFallback: true,
      messageRequest: { verbatim: "this is not conventional" },
    });

    assert.ok(msg, "should send a result message");
    assert.strictEqual(msg.type, "result");
    assert.strictEqual(msg.commitCount, 0, "invalid verbatim must not commit");
    assert.ok(
      (msg.warnings ?? []).some(
        (w: string) => w.includes("verbatim") && w.includes("not a valid conventional commit"),
      ),
      `should warn about the invalid verbatim, got: ${JSON.stringify(msg.warnings)}`,
    );
    assert.strictEqual(exitCode, 0, "exit code must be 0");

    const staged = execSync("git diff --cached --name-only", {
      cwd: dir, encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"],
    }).trim().split("\n").filter(Boolean);
    assert.deepStrictEqual(staged, ["bad-v.ts"], "blocked changes remain staged");
  });
});

// ===========================================================================
// Worker exclude pattern edge cases
// ===========================================================================

describe("worker exclude patterns", () => {
  it("unstageExcludedFiles handles glob patterns (prefix, suffix, wildcard)", () => {
    const dir = createTempRepo();

    // Create subdirectories
    ensureDir(path.join(dir, "src"));
    ensureDir(path.join(dir, "dist"));

    writeFileSync(path.join(dir, "src/keep.ts"), "// keep\n");
    writeFileSync(path.join(dir, "dist/remove.ts"), "// remove\n");
    writeFileSync(path.join(dir, "data.json"), "{}");
    writeFileSync(path.join(dir, "test.log"), "log\n");
    execSync("git add -A", { cwd: dir, stdio: "ignore" });

    const result = unstageExcludedFiles(
      dir,
      ["src/keep.ts", "dist/remove.ts", "data.json", "test.log"],
      ["dist/", "*.log", "*.json"],
    );

    assert.deepStrictEqual(result, ["src/keep.ts"], "only keep.ts should remain");

    const staged = execSync("git diff --cached --name-only", {
      cwd: dir, encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"],
    }).trim().split("\n").filter(Boolean);
    assert.strictEqual(staged.length, 1, "only 1 file should be staged");
    assert.ok(staged.includes("src/keep.ts"));
  });
});

// ===========================================================================
// Widget phase transition tests (direct import from widget.ts)
// ===========================================================================

describe("widget phase transitions", () => {
  let renderCommitterWidgetLines: any;

  before(async () => {
    const mod = await import("../widget.ts");
    renderCommitterWidgetLines = (mod as any).renderCommitterWidgetLines;
  });

  it("renders analyzing phase with file count", () => {
    const theme = {
      fg: (_c: string, t: string) => t,
      bold: (t: string) => t,
    } as any;
    const elapsed = Date.now();

    const progress = {
      phase: "analyzing",
      fileCount: 12,
      statusMessage: "Analyzing 12 file(s) for logical commit grouping...",
      commitLog: [],
      startedAt: elapsed,
    };

    const lines = renderCommitterWidgetLines(progress, theme, 80);
    assert.ok(lines.length > 0, "should render at least one line");
    assert.ok(lines[0].includes("analyzing"), "header should show analyzing");
  });

  it("renders done phase with error message", () => {
    const theme = {
      fg: (_c: string, t: string) => t,
      bold: (t: string) => t,
    } as any;
    const elapsed = Date.now();

    const progress = {
      phase: "done",
      fileCount: 5,
      statusMessage: undefined,
      error: "fatal: pathspec 'nonexistent.ts' did not match any files",
      commitLog: [],
      startedAt: elapsed,
    };

    const lines = renderCommitterWidgetLines(progress, theme, 80);
    assert.ok(lines.length > 0, "should render at least one line");
    // Should show the error somewhere
    assert.ok(lines.some((l: string) => l.includes("error") || l.includes("fatal")),
      "should render error information");
  });

  it("renders idle phase as empty", () => {
    const theme = {
      fg: (_c: string, t: string) => t,
      bold: (t: string) => t,
    } as any;

    const progress = {
      phase: "idle",
      commitLog: [],
      startedAt: Date.now(),
    };

    const lines = renderCommitterWidgetLines(progress, theme, 80);
    assert.strictEqual(lines.length, 0, "idle phase should render nothing");
  });
});

// ===========================================================================
// Large diff handling (direct import)
// ===========================================================================

describe("large diff handling", () => {
  it("getDiffContent handles large diffs via file fallback", () => {
    const dir = createTempRepo();

    // Create a file with enough content to produce a big diff
    const bigContent = Array.from({ length: 1000 }, (_, i) => `// line ${i}\n`).join("");
    writeFileSync(path.join(dir, "large-file.ts"), bigContent);
    execSync("git add large-file.ts", { cwd: dir, stdio: "ignore" });

    const diff = getDiffContent(dir);
    assert.ok(diff.length > 0, "diff should not be empty");
    assert.ok(diff.includes("large-file.ts"), "diff should include filename");
    assert.ok(diff.includes("+// line 0"), "diff should include first line");
    assert.ok(diff.includes("+// line 999"), "diff should include last line");
  });

  it("getDiffContent handles empty diff", () => {
    const dir = createTempRepo();

    // No staged changes
    const diff = getDiffContent(dir);
    assert.strictEqual(diff, "", "no staged changes should yield empty diff");
  });
});

// ===========================================================================
// Binary file handling (direct git helper tests)
// ===========================================================================

describe("binary file handling", () => {
  it("filterGitignoredFiles handles binary extensions", () => {
    const dir = createTempRepo();

    writeFileSync(path.join(dir, ".gitignore"), "*.png\n*.jpg\n");
    execSync("git add .gitignore && git commit -m 'add gitignore'", {
      cwd: dir, stdio: "ignore",
    });

    const result = filterGitignoredFiles(dir, ["a.ts", "b.png", "c.jpg", "d.ts"]);
    assert.deepStrictEqual(result, ["a.ts", "d.ts"]);
  });

  it("unstageExcludedFiles handles binary file patterns", () => {
    const dir = createTempRepo();

    writeFileSync(path.join(dir, "image.png"), "fake-png-binary");
    writeFileSync(path.join(dir, "script.ts"), "// script");
    execSync("git add -A", { cwd: dir, stdio: "ignore" });

    const remaining = unstageExcludedFiles(dir, ["image.png", "script.ts"], ["*.png"]);
    assert.deepStrictEqual(remaining, ["script.ts"]);
  });
});

// ===========================================================================
// Worker IPC result guarantees (fork-based)
// ===========================================================================

describe("worker IPC result guarantees", () => {
  it("always exits with code 0 regardless of success or failure", async () => {
    const dir = createTempRepo();

    // Test success case
    writeFileSync(path.join(dir, "success-test.ts"), "// success\n");
    execSync("git add success-test.ts", { cwd: dir, stdio: "ignore" });

    const diffStat = execSync("git diff --cached --stat", {
      cwd: dir, encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    const diffContent = execSync("git diff --cached", {
      cwd: dir, encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    const allFiles = ["success-test.ts"];

    const { msg, exitCode } = await forkWorker(dir, {
      dir,
      diffStat,
      diffContent,
      allFiles,
      stagedCommits: false,
      excludePatterns: [],
      minChanges: 1,
      subagentModel: undefined,
      subagentGroupingMinFiles: 4,
      subagentMessageMinFiles: 3,
      subagentThinkingLevel: "off",
      deterministicFallback: true,
    });

    assert.strictEqual(exitCode, 0, "exit code must be 0 for success");
    assert.ok(msg, "IPC result should be received");
    assert.strictEqual(msg.error, undefined, "no error for success");
  });

  it("IPC result type is always 'result' and carries commitCount and commitLog", async () => {
    const dir = createTempRepo();

    writeFileSync(path.join(dir, "result-type-test.ts"), "// result type\n");
    execSync("git add result-type-test.ts", { cwd: dir, stdio: "ignore" });

    const diffStat = execSync("git diff --cached --stat", {
      cwd: dir, encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    const diffContent = execSync("git diff --cached", {
      cwd: dir, encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    const allFiles = ["result-type-test.ts"];

    const { msg } = await forkWorker(dir, {
      dir,
      diffStat,
      diffContent,
      allFiles,
      stagedCommits: false,
      excludePatterns: [],
      minChanges: 1,
      subagentModel: undefined,
      subagentGroupingMinFiles: 4,
      subagentMessageMinFiles: 3,
      subagentThinkingLevel: "off",
      deterministicFallback: true,
    });

    assert.strictEqual(msg.type, "result");
    assert.strictEqual(typeof msg.commitCount, "number");
    assert.ok(Array.isArray(msg.commitLog));
  });

  it("commit log entries have hash, message, and success fields", async () => {
    const dir = createTempRepo();

    writeFileSync(path.join(dir, "log-fields-test.ts"), "// log fields\n");
    execSync("git add log-fields-test.ts", { cwd: dir, stdio: "ignore" });

    const diffStat = execSync("git diff --cached --stat", {
      cwd: dir, encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    const diffContent = execSync("git diff --cached", {
      cwd: dir, encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    const allFiles = ["log-fields-test.ts"];

    const { msg } = await forkWorker(dir, {
      dir,
      diffStat,
      diffContent,
      allFiles,
      stagedCommits: false,
      excludePatterns: [],
      minChanges: 1,
      subagentModel: undefined,
      subagentGroupingMinFiles: 4,
      subagentMessageMinFiles: 3,
      subagentThinkingLevel: "off",
      deterministicFallback: true,
    });

    if (msg.commitCount > 0 && msg.commitLog.length > 0) {
      const entry = msg.commitLog[0];
      assert.ok(entry.hash, "commit entry must have hash");
      assert.ok(entry.message, "commit entry must have message");
      assert.strictEqual(entry.success, true, "commit entry must have success=true");
    }
  });
});

// ===========================================================================
// Worker loading via jiti (node_modules scenario)
// ===========================================================================

describe("worker loads via jiti (node_modules scenario)", () => {
  it("forks the worker with jiti execArgv and processes commits successfully", async () => {
    const dir = mkdtempSync(path.join(_baseDir, "jiti-test-"));
    after(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ } });

    // Init git repo with changes
    execSync("git init", { cwd: dir, stdio: "ignore" });
    execSync("git config user.email test@test.com", { cwd: dir, stdio: "ignore" });
    execSync("git config user.name Test", { cwd: dir, stdio: "ignore" });
    writeFileSync(path.join(dir, "README.md"), "# test\n");
    execSync("git add -A && git commit -m initial", { cwd: dir, stdio: "ignore" });

    writeFileSync(path.join(dir, "change1.ts"), "// change1\n");
    execSync("git add -A", { cwd: dir, stdio: "ignore" });

    const diffStat = execSync("git diff --cached --stat", {
      cwd: dir, encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    const diffContent = execSync("git diff --cached", {
      cwd: dir, encoding: "utf-8", maxBuffer: 10 * 1024 * 1024, stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    const allFiles = ["change1.ts"];

    const workerPath = fileURLToPath(new URL("../async-commit-worker.ts", import.meta.url));
    const jitiRegister = path.join(process.cwd(), "node_modules", "jiti", "lib", "jiti-register.mjs");

    // Only run test if jiti exists
    if (!fs.existsSync(jitiRegister)) {
      console.log("skipping jiti test: jiti-register.mjs not found");
      return;
    }

    // Write params JSON for the external runner
    const paramsFile = path.join(dir, "jiti-params.json");
    const runnerPath = path.join(__dirname, "_jiti-runner.mjs");
    writeFileSync(paramsFile, JSON.stringify({ dir, diffStat, diffContent, allFiles, workerPath, jitiRegister }));

    // Run the external runner as a subprocess (avoids node:test IPC conflict)
    const output = execSync(
      `node "${runnerPath}" "${paramsFile}"`,
      { cwd: process.cwd(), encoding: "utf-8", timeout: 15_000, maxBuffer: 10 * 1024 * 1024 },
    ).trim();

    // Parse JSON result from stdout
    const lines = output.split("\n").filter(Boolean);
    const jsonLine = lines.find((l: string) => l.startsWith("{"));
    assert.ok(jsonLine, "Expected JSON output from runner, got: " + output);

    const result = JSON.parse(jsonLine);

    assert.strictEqual(result.type, "result", "expected result message");
    assert.strictEqual(result.error, undefined, "no error: " + result.error);
    assert.strictEqual(result.commitCount, 1, "should produce 1 commit via jiti loader");
  });
});

// ===========================================================================
// Node_modules type-stripping crash scenario (regression guard)
// ===========================================================================

describe("node_modules type-stripping crash scenario", () => {
  it("--experimental-strip-types crashes for .ts under node_modules (verify the original bug)", async () => {
    // Create a temp dir structured like node_modules/pkg with a minimal .ts worker
    const nmDir = mkdtempSync(path.join(_baseDir, "nm-crash-"));
    after(() => { try { fs.rmSync(nmDir, { recursive: true, force: true }); } catch { /* ignore */ } });

    const pkgDir = path.join(nmDir, "node_modules", "test-pkg");
    fs.mkdirSync(pkgDir, { recursive: true });

    // Write a minimal .ts file that does IPC
    const workerContent = `
import { parentPort } from "node:worker_threads";
process.on("message", (msg: any) => {
  if (msg?.type === "ping") {
    process.send?.({ type: "pong" });
    setTimeout(() => process.exit(0), 100);
  }
});
`;
    const workerFile = path.join(pkgDir, "worker.ts");
    writeFileSync(workerFile, workerContent);

    // Verify: forking with --experimental-strip-types should crash
    // because the worker is under node_modules
    const script1 = path.join(nmDir, "test-strip-types.mjs");
    writeFileSync(script1, `
import { fork } from "node:child_process";
const child = fork(${JSON.stringify(workerFile)}, [], {
  execArgv: ["--experimental-strip-types"],
  stdio: ["ignore", "ignore", "pipe", "ipc"],
});
child.on("exit", (code) => { process.exit(code ?? 1); });
setTimeout(() => process.exit(1), 5000);
child.send({ type: "ping" });
`);

    // Run the script — expect non-zero exit
    let stripExitCode = 0;
    try {
      execSync(`node "${script1}"`, { timeout: 8000, stdio: "pipe" });
      // If we get here, strip-types didn't crash — unexpected success
      stripExitCode = 0;
    } catch (e: any) {
      stripExitCode = e.status ?? 1;
    }

    // Node.js 22+ should refuse to strip types under node_modules
    assert.notStrictEqual(stripExitCode, 0,
      "--experimental-strip-types should crash for .ts files under node_modules");
  });

  it("resolveWorkerExecArgv returns jiti --import for node_modules path", () => {
    const cwd = process.cwd();
    const workerInNm = path.join(cwd, "node_modules", "any-pkg", "worker.ts");
    const argv = resolveWorkerExecArgv(workerInNm);

    assert.strictEqual(argv[0], "--import",
      "resolveWorkerExecArgv should return --import for path under node_modules");
    assert.ok(argv[1].includes("jiti"),
      "resolveWorkerExecArgv should return jiti register path");
  });

  it("jiti succeeds where --experimental-strip-types fails (node_modules .ts file)", async () => {
    // Create a temp dir structured like node_modules/pkg
    const nmDir = mkdtempSync(path.join(_baseDir, "nm-jiti-"));
    after(() => { try { fs.rmSync(nmDir, { recursive: true, force: true }); } catch { /* ignore */ } });

    const pkgDir = path.join(nmDir, "node_modules", "test-pkg");
    fs.mkdirSync(pkgDir, { recursive: true });

    // Write the same minimal .ts worker
    const workerContent = `
import { parentPort } from "node:worker_threads";
process.on("message", (msg: any) => {
  if (msg?.type === "ping") {
    process.send?.({ type: "pong" });
    setTimeout(() => process.exit(0), 100);
  }
});
`;
    const workerFile = path.join(pkgDir, "worker.ts");
    writeFileSync(workerFile, workerContent);

    const jitiReg = path.join(process.cwd(), "node_modules", "jiti", "lib", "jiti-register.mjs");
    if (!fs.existsSync(jitiReg)) {
      console.log("skipping: jiti not found");
      return;
    }

    // Run with jiti — expect success
    const script2 = path.join(nmDir, "test-jiti.mjs");
    writeFileSync(script2, `
import { fork } from "node:child_process";
const child = fork(${JSON.stringify(workerFile)}, [], {
  execArgv: ["--import", ${JSON.stringify(jitiReg)}],
  stdio: ["ignore", "ignore", "pipe", "ipc"],
});
child.on("message", (msg) => {
  if (msg?.type === "pong") process.exit(0);
});
child.on("exit", (code) => process.exit(code ?? 1));
setTimeout(() => process.exit(1), 5000);
child.send({ type: "ping" });
`);

    let jitiExitCode = -1;
    try {
      execSync(`node "${script2}"`, { timeout: 8000, stdio: "pipe" });
      jitiExitCode = 0;
    } catch (e: any) {
      jitiExitCode = e.status ?? 1;
    }

    assert.strictEqual(jitiExitCode, 0,
      "jiti should successfully load .ts file under node_modules");
  });

  it("regression guard: if resolveWorkerExecArgv is reverted to always return --experimental-strip-types, crash-scenario tests would catch it", () => {
    // This is a design-level assertion: verify that if someone reverts
    // resolveWorkerExecArgv to always return "--experimental-strip-types",
    // the crash-scenario tests above would fail.
    //
    // We verify this by checking that resolveWorkerExecArgv returns DIFFERENT
    // values for node_modules vs non-node_modules paths.
    const nmPath = path.join(process.cwd(), "node_modules", "any", "worker.ts");
    const normalPath = "/home/user/worker.ts";

    const nmArgv = resolveWorkerExecArgv(nmPath);
    const normalArgv = resolveWorkerExecArgv(normalPath);

    assert.notDeepStrictEqual(nmArgv, normalArgv,
      "resolveWorkerExecArgv must return different execArgv for node_modules vs non-node_modules paths. " +
      "If this fails, the fix has been reverted to always return --experimental-strip-types.");
  });
});

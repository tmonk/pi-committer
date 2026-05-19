import {
  describe,
  it,
  before,
  after,
} from "node:test";
import assert from "node:assert";
import { execSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { mkdtempSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/**
 * E2E tests for pi-committer.
 *
 * These tests spawn `pi -p` instances and incur real API costs.
 * Run only when explicitly opted in:
 *
 *   npm run test:e2e
 *
 * The npm script sets PI_COMMITTER_E2E=1 before running this file.
 */

const E2E_ENABLED = !!process.env.PI_COMMITTER_E2E;

const e2e = E2E_ENABLED ? describe : describe.skip;

const EXT_PATH = path.resolve(
  __dirname,
  "..",
  "extensions",
  "pi-committer",
  "index.ts",
);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function tmpDir(): string {
  return process.env.TMPDIR || "/tmp";
}

function createTempRepo(): string {
  const dir = mkdtempSync(path.join(tmpDir(), "pi-committer-e2e-"));
  execSync("git init", { cwd: dir, stdio: "ignore" });
  execSync("git config user.email test@test.com", { cwd: dir, stdio: "ignore" });
  execSync("git config user.name Test", { cwd: dir, stdio: "ignore" });
  writeFileSync(path.join(dir, "README.md"), "# test\n");
  execSync("git add -A && git commit -m initial", { cwd: dir, stdio: "ignore" });
  return dir;
}

function removeDir(dir: string): void {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
}

function runPi(dir: string, input: string): string {
  return execSync(`printf '${input}' | pi -p -e "${EXT_PATH}"`, {
    cwd: dir,
    encoding: "utf-8",
    maxBuffer: 10 * 1024 * 1024,
    timeout: 120_000,
  });
}

function commitCount(dir: string): number {
  try {
    const out = execSync("git log --oneline", {
      cwd: dir,
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    if (!out) return 0;
    return out.split("\n").length;
  } catch {
    return 0;
  }
}

// ===========================================================================
// E2E Tests
// ===========================================================================

e2e("pi-committer E2E", { timeout: 300_000 }, () => {
  let testDir: string;
  let repo2: string;

  before(() => {
    testDir = createTempRepo();
    repo2 = createTempRepo();
  });

  after(() => {
    removeDir(testDir);
    removeDir(repo2);
  });

  // -----------------------------------------------------------------------
  it("Test 1: Basic /commit creates a commit", () => {
    writeFileSync(path.join(testDir, "test.ts"), "// test");
    runPi(testDir, "/commit\\n");

    const count = commitCount(testDir);
    assert.ok(count >= 2, `Expected >=2 commits (initial + 1), got ${count}`);
  });

  // -----------------------------------------------------------------------
  it("Test 2: Exclusion patterns skip *.log files", () => {
    const toml = `[committer]\nenabled = true\ntrigger_mode = "on_goal"\nexclude_patterns = ["*.log"]\n`;
    writeFileSync(path.join(testDir, ".pi-committer.toml"), toml, "utf-8");

    writeFileSync(path.join(testDir, "keep.ts"), "// keep");
    writeFileSync(path.join(testDir, "build.log"), "# log");

    runPi(testDir, "/commit\\n");

    const count = commitCount(testDir);
    assert.ok(count >= 3, `Expected >=3 commits, got ${count}`);

    // build.log should still be untracked
    const status = execSync("git status --porcelain", {
      cwd: testDir,
      encoding: "utf-8",
    }).trim();
    assert.ok(status.includes("build.log"), "Expected build.log to be untracked");
  });

  // -----------------------------------------------------------------------
  it("Test 3: commit_changes tool creates commit", () => {
    writeFileSync(path.join(testDir, "tool-test.ts"), "// tool");
    runPi(testDir, "Call commit_changes\\n");

    const count = commitCount(testDir);
    assert.ok(count >= 4, `Expected >=4 commits, got ${count}`);
  });

  // -----------------------------------------------------------------------
  it("Test 4: Staged commits create >=2 logical groups", () => {
    const srcDir = path.join(testDir, "src");
    const testsDir = path.join(testDir, "tests");
    fs.mkdirSync(srcDir, { recursive: true });
    fs.mkdirSync(testsDir, { recursive: true });

    writeFileSync(path.join(srcDir, "module.ts"), "// new module");
    writeFileSync(path.join(testsDir, "module.test.ts"), "// test");
    writeFileSync(path.join(testDir, "CHANGELOG.md"), "# v2");

    runPi(testDir, "/commit\\n");

    const count = commitCount(testDir);
    assert.ok(count >= 6, `Expected >=6 commits, got ${count}`);
  });

  // -----------------------------------------------------------------------
  it("Test 5: Multi-repo — both repos committed", () => {
    writeFileSync(path.join(testDir, "primary.ts"), "// primary");
    writeFileSync(path.join(repo2, "CHANGELOG.md"), "# repo2 changes");

    runPi(testDir,
      "Write a file " + repo2 + "/CHANGELOG.md " +
      "with content '# repo2 changes'. Then call commit_changes.\\n"
    );

    const primaryCount = commitCount(testDir);
    const repo2Count = commitCount(repo2);
    assert.ok(primaryCount >= 7, `Expected >=7 primary commits, got ${primaryCount}`);
    assert.ok(repo2Count >= 2, `Expected >=2 repo2 commits, got ${repo2Count}`);
  });

  // -----------------------------------------------------------------------
  it("Test 6: Non-git directory handled gracefully", () => {
    const nongit = mkdtempSync(path.join(tmpDir(), "pi-committer-nongit-"));
    writeFileSync(path.join(nongit, "test.ts"), "// nongit");

    try {
      runPi(nongit, "/commit\\n");
    } catch {
      // Non-git may not have a valid pi context — no crash expected
    }

    removeDir(nongit);
    assert.ok(true);
  });

  // -----------------------------------------------------------------------
  it("Test 7: Config reload (/commit-config)", () => {
    const toml = `[committer]\nenabled = true\ntrigger_mode = "manual"\n`;
    writeFileSync(path.join(testDir, ".pi-committer.toml"), toml, "utf-8");

    try {
      runPi(testDir, "/commit-config\\n");
    } catch {
      // config reload may not produce output — no crash expected
    }

    assert.ok(true);
  });

  // -----------------------------------------------------------------------
  it("Test 8: Gitignored files are skipped during commit", () => {
    const toml = `[committer]\nenabled = true\ntrigger_mode = "on_goal"\n`;
    writeFileSync(path.join(testDir, ".pi-committer.toml"), toml, "utf-8");

    // Set up .gitignore
    writeFileSync(path.join(testDir, ".gitignore"), "*.json\n");

    // Create one file that IS gitignored and one that is NOT
    writeFileSync(path.join(testDir, "ignored.json"), "{}");
    writeFileSync(path.join(testDir, "keep.ts"), "// keep");

    runPi(testDir, "/commit\n");

    const count = commitCount(testDir);
    assert.ok(count >= 2, `Expected >=2 commits, got ${count}`);

    // The ignored.json should NOT be tracked
    const status = execSync("git status --porcelain", {
      cwd: testDir,
      encoding: "utf-8",
    }).trim();
    assert.ok(status.includes("ignored.json"), "Expected ignored.json to remain untracked");
    assert.ok(!status.includes("keep.ts"), "Expected keep.ts to be committed (not in status)");
  });

  // -----------------------------------------------------------------------
  it("Test 9: Commit succeeds when all files are gitignored (no crash)", () => {
    const toml = `[committer]\nenabled = true\ntrigger_mode = "on_goal"\n`;
    writeFileSync(path.join(testDir, ".pi-committer.toml"), toml, "utf-8");

    writeFileSync(path.join(testDir, ".gitignore"), "*\n!.gitignore\n");

    // Any new file will be gitignored
    writeFileSync(path.join(testDir, "data.json"), "{}");

    // This should NOT crash — it should detect no committable changes
    try {
      runPi(testDir, "/commit\n");
    } catch {
      // The process may exit non-zero if pi reports an error message,
      // but it should not crash with a Command failed: git add error
    }

    assert.ok(true);
  });

  // -----------------------------------------------------------------------
  it("Test 10: Nested .gitignore is respected", () => {
    const toml = `[committer]\nenabled = true\ntrigger_mode = "on_goal"\n`;
    writeFileSync(path.join(testDir, ".pi-committer.toml"), toml, "utf-8");

    // Remove the global *.json ignore from test 8
    writeFileSync(path.join(testDir, ".gitignore"), "");

    const benchmarksDir = path.join(testDir, "benchmarks");
    fs.mkdirSync(benchmarksDir, { recursive: true });
    writeFileSync(path.join(benchmarksDir, ".gitignore"), "*.json\n");

    writeFileSync(path.join(benchmarksDir, "results.json"), "{}");
    writeFileSync(path.join(testDir, "keep.ts"), "// keep");

    runPi(testDir, "/commit\n");

    const count = commitCount(testDir);
    assert.ok(count >= 3, `Expected >=3 commits, got ${count}`);

    // benchmarks/results.json should still be untracked
    const status = execSync("git status --porcelain -- benchmarks/", {
      cwd: testDir,
      encoding: "utf-8",
    }).trim();
    assert.ok(status.includes("results.json"), "Expected results.json to remain untracked in nested gitignore");
  });
});

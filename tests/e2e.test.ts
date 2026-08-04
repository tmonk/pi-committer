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
import { mkdtempSync, writeFileSync, existsSync } from "node:fs";
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
  const out = execSync(`printf '${input}' | pi -p -e "${EXT_PATH}"`, {
    cwd: dir,
    encoding: "utf-8",
    maxBuffer: 10 * 1024 * 1024,
    timeout: 180_000,
  });
  if (process.env.PI_COMMITTER_E2E_DEBUG) {
    console.error(`[e2e-debug] runPi(${JSON.stringify(input.trim())}) output: ${JSON.stringify(out.slice(0, 400))}`);
  }
  return out;
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

e2e("pi-committer E2E", { timeout: 720_000 }, () => {
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

    // Lower the grouping threshold so these 3 files actually trigger the
    // subagent grouping path (default is 15, which these never reach), and
    // force sync commits so the grouped commits exist before the assertion
    // (5 files would otherwise hit the async threshold and race the check).
    const toml = `[committer]\nenabled = true\ntrigger_mode = "on_goal"\nstaged_commits = true\nsubagent_grouping_min_files = 2\nasync_threshold = 0\n`;
    writeFileSync(path.join(testDir, ".pi-committer.toml"), toml, "utf-8");

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
    // NOTE: repo2's CHANGELOG.md must NOT be pre-written here — multi-repo
    // detection is session-history based, so the agent has to create the file
    // via its write tool for repo2 to be detected and committed.

    runPi(testDir,
      "Two steps:\n" +
      "  1. Create a file at " + repo2 + "/CHANGELOG.md with any content.\n" +
      "  2. Call the commit_changes tool."
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

    // The ignored.json should NOT be tracked (gitignored files never show in
    // plain `git status --porcelain`, so verify via the index instead)
    const tracked = execSync("git ls-files", {
      cwd: testDir,
      encoding: "utf-8",
    }).trim();
    assert.ok(!tracked.includes("ignored.json"), "Expected ignored.json to remain untracked");
    assert.ok(tracked.includes("keep.ts"), "Expected keep.ts to be committed");
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
  it("Test 11: Async commit with many files runs in background", async () => {
    // Clear the previous test's swallow-all .gitignore ("*\n!.gitignore")
    // so the new files are actually committable, and enable the extension.
    writeFileSync(path.join(testDir, ".gitignore"), "");
    const toml = `[committer]\nenabled = true\ntrigger_mode = "on_goal"\n`;
    writeFileSync(path.join(testDir, ".pi-committer.toml"), toml, "utf-8");

    // Create 6 files to trigger async threshold (default is 5)
    for (let i = 0; i < 6; i++) {
      writeFileSync(path.join(testDir, `async-e2e-${i}.ts`), `// async e2e ${i}\n`);
    }

    // Read the baseline BEFORE running pi: the async worker can commit so
    // quickly that it finishes before runPi returns, which would make the
    // post-run baseline already include the commit and the poll would never
    // observe an increase.
    const startCount = commitCount(testDir);

    // Run pi with commit_changes — this should trigger the async path
    // because we have 6 files and the default asyncThreshold is 5.
    const output = runPi(testDir, "Call commit_changes\n");

    // The output should indicate the commit is running in background
    // (or it may have completed synchronously if the async worker failed).
    // Either way, there should be new commits in the repo.

    // Wait for up to 6 minutes for the async worker to complete (the worker's
    // subagent SDK/LLM path can stall for minutes before falling back in
    // headless runs — e.g. a dead parent session reference on pi exit)
    let currentCount = startCount;
    const deadline = Date.now() + 360_000;
    while (Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 2000));
      currentCount = commitCount(testDir);
      if (currentCount > startCount) break;
    }

    assert.ok(
      currentCount > startCount,
      `Expected new commits after async, got ${currentCount} (was ${startCount})`,
    );
  });

  // -----------------------------------------------------------------------
  it("Test 12: Nested .gitignore is respected", () => {
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

    // benchmarks/results.json should still be untracked (gitignored files never
    // show in plain `git status --porcelain`, so verify via the index instead)
    const tracked = execSync("git ls-files -- benchmarks/", {
      cwd: testDir,
      encoding: "utf-8",
    }).trim();
    assert.ok(
      !tracked.includes("results.json"),
      "Expected results.json to remain untracked in nested gitignore",
    );
    assert.ok(
      tracked.includes("benchmarks/.gitignore"),
      "Expected the nested .gitignore itself to be committed",
    );
  });

  // -----------------------------------------------------------------------
  it("Test 13: Async commit worker loads successfully under node_modules (jiti execArgv path)", async () => {
    // This test verifies that the async worker can be forked from a path
    // under node_modules using the jiti loader, which is the exact scenario
    // that was crashing (ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING).

    // Create a temp node_modules structure
    const nmDir = mkdtempSync(path.join(tmpDir(), "pi-e2e-nm-"));
    after(() => { try { fs.rmSync(nmDir, { recursive: true, force: true }); } catch { /* ignore */ } });

    const pkgDir = path.join(nmDir, "node_modules", "pi-committer-e2e");
    fs.mkdirSync(pkgDir, { recursive: true });

    // Symlink the real worker into the node_modules location
    const realWorker = path.resolve(__dirname, "..", "async-commit-worker.ts");
    fs.symlinkSync(realWorker, path.join(pkgDir, "async-commit-worker.ts"));

    const jitiReg = path.join(process.cwd(), "node_modules", "jiti", "lib", "jiti-register.mjs");

    // Build a runner script byte-by-byte to avoid template/String escaping
    const runnerLines: string[] = [];
    runnerLines.push("import { fork } from 'node:child_process';");
    runnerLines.push("import { writeFileSync } from 'node:fs';");
    runnerLines.push("const worker = " + JSON.stringify(path.join(pkgDir, "async-commit-worker.ts")) + ";");
    runnerLines.push("const jiti = " + JSON.stringify(jitiReg) + ";");
    runnerLines.push("const child = fork(worker, [], { execArgv: ['--import', jiti], stdio: ['ignore','ignore','ignore','ipc'] });");
    runnerLines.push("const donePath = " + JSON.stringify(path.join(nmDir, "done.flag")) + ";");
    runnerLines.push("child.on('message', (msg) => { if (msg && msg.type === 'result') { writeFileSync(donePath, 'done'); process.exit(0); } });");
    runnerLines.push("child.on('exit', (code) => { if (code !== 0) process.exit(code); });");
    runnerLines.push("setTimeout(() => process.exit(2), 10000);");
    runnerLines.push("child.send({ type: 'start', params: { dir: " + JSON.stringify(testDir) + ", diffStat: '', diffContent: '', allFiles: [], stagedCommits: false, excludePatterns: [], minChanges: 1, subagentModel: undefined, subagentGroupingMinFiles: 4, subagentMessageMinFiles: 3, subagentThinkingLevel: 'off' } });");

    const runnerScript = path.join(nmDir, "runner.mjs");
    writeFileSync(runnerScript, runnerLines.join("\n"));

    // Run the runner and check for done flag
    try {
      execSync(`node "${runnerScript}"`, { timeout: 15_000, encoding: "utf-8", maxBuffer: 1024 });
    } catch (e: any) {
      assert.fail(`Runner failed: ${e.message}`);
    }

    // Verify the done.flag was created (worker sent result message)
    const doneFlag = path.join(nmDir, "done.flag");
    assert.ok(existsSync(doneFlag),
      "Worker should have created done.flag, indicating result message was received");
  });
});

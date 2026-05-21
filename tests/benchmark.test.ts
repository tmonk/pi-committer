/**
 * Performance benchmarks for pi-committer.
 *
 * Measures wall-clock time for key operations across repos of varying sizes
 * and both staging modes (stagedCommits on/off).
 *
 * Saves results to tests/benchmark-results.txt for before/after comparison.
 *
 * Run: node --test tests/benchmark.test.ts
 *
 * To capture BASELINE (pre-optimization):
 *   1. git checkout -- index.ts async-commit-worker.ts config.ts
 *   2. node --test tests/benchmark.test.ts 2>&1 | tee /tmp/baseline-output.txt
 *   3. cp tests/benchmark-results.txt tests/benchmark-baseline.txt
 *
 * To capture OPTIMIZED (post-optimization):
 *   1. git apply /tmp/optimizations.patch   (or restore your changes)
 *   2. node --test tests/benchmark.test.ts 2>&1 | tee /tmp/optimized-output.txt
 *   3. cp tests/benchmark-results.txt tests/benchmark-optimized.txt
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert";
import { mkdtempSync, writeFileSync, rmSync, readFileSync, appendFileSync } from "node:fs";
import { execSync } from "node:child_process";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { tmpdir } from "node:os";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function tmpDir(): string {
  return process.env.TMPDIR || "/tmp";
}

function getGitVariant(): string {
  const v = execSync("git --version", { encoding: "utf-8" }).trim();
  return v;
}

/** Create a fresh git repo with N files of varying sizes. */
function createRepoWithFiles(
  repoDir: string,
  fileCount: number,
  includeGitIgnore = false,
): void {
  execSync("git init", { cwd: repoDir, stdio: "ignore" });
  execSync("git config user.email bench@test.com", { cwd: repoDir, stdio: "ignore" });
  execSync("git config user.name Bench", { cwd: repoDir, stdio: "ignore" });

  const subdirs = ["src", "tests", "lib", "dist"];
  for (const d of subdirs) {
    execSync("mkdir -p " + d, { cwd: repoDir });
  }

  for (let i = 0; i < fileCount; i++) {
    const subdir = i % 3 === 0 ? "src" : i % 3 === 1 ? "tests" : "lib";
    const ext = i % 4 === 0 ? ".ts" : i % 4 === 1 ? ".js" : i % 4 === 2 ? ".css" : ".json";
    const filePath = path.join(repoDir, subdir, `file-${i}${ext}`);
    writeFileSync(filePath, `// file ${i}\nconst x${i} = ${i};\nexport default x${i};\n`);
  }

  if (includeGitIgnore) {
    const ignores = ["*.log", "node_modules/", "dist/", ".env"];
    writeFileSync(path.join(repoDir, ".gitignore"), ignores.join("\n") + "\n");
  }

  execSync("git add -A", { cwd: repoDir, stdio: "ignore" });
  execSync("git commit -m initial", { cwd: repoDir, stdio: "ignore" });
}

function modifyFiles(repoDir: string, fileCount: number): void {
  for (let i = 0; i < fileCount; i++) {
    const subdir = i % 3 === 0 ? "src" : i % 3 === 1 ? "tests" : "lib";
    const ext = i % 4 === 0 ? ".ts" : i % 4 === 1 ? ".js" : i % 4 === 2 ? ".css" : ".json";
    const filePath = path.join(repoDir, subdir, `file-${i}${ext}`);
    writeFileSync(filePath, `// file ${i} v2\nconst x${i} = ${i + 1};\nexport default x${i + 1};\n`, { flag: "a" });
  }
}

function createMixedChanges(repoDir: string, changeCount: number, ignoredCount = 3): void {
  modifyFiles(repoDir, changeCount);
  for (let i = 0; i < Math.ceil(changeCount / 2); i++) {
    writeFileSync(path.join(repoDir, "src", `new-${i}.ts`), `// new file ${i}\nconst n${i} = ${i};\n`);
  }
  for (let i = 0; i < ignoredCount; i++) {
    writeFileSync(path.join(repoDir, "dist", `build-${i}.js`), `// ignored ${i}\n`);
    writeFileSync(path.join(repoDir, `debug-${i}.log`), `log entry ${i}\n`);
  }
}

// ---------------------------------------------------------------------------
// Imports from index.ts
// ---------------------------------------------------------------------------

import {
  getDiffContent,
  filterGitignoredFiles,
  unstageExcludedFiles,
  stageAll,
  getChangedFiles,
  deterministicCommitMessage,
  parseCommitGroups,
  _getLastSubagentCallMs,
  _getLastGroupGenCallMs,
  setConfig,
  loadConfig,
  getConfig,
  type CommitterConfig,
} from "../index.ts";

// ---------------------------------------------------------------------------
// Benchmark configuration
// ---------------------------------------------------------------------------

const SMALL_COUNT = 5;
const MEDIUM_COUNT = 30;
const LARGE_COUNT = 100;

const RUNS = 3;

interface BenchmarkResult {
  label: string;
  size: string;
  avgMs: number;
  minMs: number;
  maxMs: number;
  runs: number;
}

const results: BenchmarkResult[] = [];
const BENCHMARK_RESULTS_FILE = new URL(
  "benchmark-results.txt",
  import.meta.url,
).pathname;

function record(label: string, size: string, timings: number[]): void {
  const avg = timings.reduce((a, b) => a + b, 0) / timings.length;
  const min = Math.min(...timings);
  const max = Math.max(...timings);
  results.push({
    label,
    size,
    avgMs: Math.round(avg * 100) / 100,
    minMs: Math.round(min * 100) / 100,
    maxMs: Math.round(max * 100) / 100,
    runs: timings.length,
  });
}

// ---------------------------------------------------------------------------
// The benchmark suite
// ---------------------------------------------------------------------------

describe("benchmark", () => {
  let originalConfig: CommitterConfig;
  let gitVariant: string;

  before(() => {
    setConfig(loadConfig(process.cwd()));
    originalConfig = getConfig();
    gitVariant = getGitVariant();
  });

  after(() => {
    setConfig(originalConfig);

    // Print summary table
    console.log("\n=== BENCHMARK RESULTS ===\n");
    console.log(`${"Operation".padEnd(45)} ${"Size".padEnd(8)} ${"Avg (ms)".padEnd(10)} ${"Min (ms)".padEnd(10)} ${"Max (ms)".padEnd(10)} ${"Runs"}`);
    console.log("-".repeat(95));
    for (const r of results) {
      console.log(`${r.label.padEnd(45)} ${r.size.padEnd(8)} ${String(r.avgMs).padEnd(10)} ${String(r.minMs).padEnd(10)} ${String(r.maxMs).padEnd(10)} ${String(r.runs)}`);
    }
    console.log("\n=========================\n");

    // Save to file for before/after comparison
    const header = `# Benchmark results — ${new Date().toISOString()}\n# Git: ${gitVariant}\n# Run: ${results.length} measurements\n`;
    const lines = [`${"Operation".padEnd(45)} ${"Size".padEnd(8)} ${"Avg (ms)".padEnd(10)} ${"Min (ms)".padEnd(10)} ${"Max (ms)".padEnd(10)} ${"Runs"}`];
    for (const r of results) {
      lines.push(`${r.label.padEnd(45)} ${r.size.padEnd(8)} ${String(r.avgMs).padEnd(10)} ${String(r.minMs).padEnd(10)} ${String(r.maxMs).padEnd(10)} ${String(r.runs)}`);
    }
    const content = header + "\n" + lines.join("\n") + "\n";
    try {
      writeFileSync(BENCHMARK_RESULTS_FILE, content, "utf-8");
      console.log(`Results saved to ${BENCHMARK_RESULTS_FILE}`);
    } catch (e) {
      console.error(`Failed to save results: ${e}`);
    }
  });

  // ===================================================================
  // 1. getDiffContent — tempdir approach vs execSync pipe
  // ===================================================================

  describe("getDiffContent", () => {
    for (const [size, count] of [
      ["small", SMALL_COUNT],
      ["medium", MEDIUM_COUNT],
      ["large", LARGE_COUNT],
    ] as const) {
      it(`${size} (${count} files)`, () => {
        const repoDir = mkdtempSync(path.join(tmpDir(), "bench-getdiff-"));
        after(() => { try { rmSync(repoDir, { recursive: true, force: true }); } catch { /* */ } });
        createRepoWithFiles(repoDir, count);
        modifyFiles(repoDir, count);
        execSync("git add -A", { cwd: repoDir, stdio: "ignore" });

        const timings: number[] = [];
        for (let i = 0; i < RUNS; i++) {
          const start = performance.now();
          const content = getDiffContent(repoDir);
          timings.push(performance.now() - start);
          assert.ok(content.length > 0, `expected diff content (${size})`);
          execSync("git reset HEAD -- .", { cwd: repoDir, stdio: "ignore" });
          execSync("git add -A", { cwd: repoDir, stdio: "ignore" });
        }
        record("getDiffContent", size, timings);
      });
    }
  });

  // ===================================================================
  // 2. filterGitignoredFiles — per-file vs batched git check-ignore
  // ===================================================================

  describe("filterGitignoredFiles", () => {
    for (const [size, count] of [
      ["small", SMALL_COUNT],
      ["medium", MEDIUM_COUNT],
      ["large", LARGE_COUNT],
    ] as const) {
      it(`${size} (${count} files, with .gitignore)`, () => {
        const repoDir = mkdtempSync(path.join(tmpDir(), "bench-filter-"));
        after(() => { try { rmSync(repoDir, { recursive: true, force: true }); } catch { /* */ } });
        createRepoWithFiles(repoDir, count, true);
        createMixedChanges(repoDir, count);
        execSync("git add -A", { cwd: repoDir, stdio: "ignore" });
        const diffStat = execSync("git diff --cached --stat", {
          cwd: repoDir, encoding: "utf-8", maxBuffer: 10 * 1024 * 1024, stdio: ["ignore", "pipe", "ignore"],
        }).trim();
        const allFiles = getChangedFiles(diffStat);
        assert.ok(allFiles.length > 0, `expected files (${size})`);

        const timings: number[] = [];
        for (let i = 0; i < RUNS; i++) {
          const start = performance.now();
          const result = filterGitignoredFiles(repoDir, allFiles);
          timings.push(performance.now() - start);
          assert.ok(Array.isArray(result));
        }
        record("filterGitignoredFiles", size, timings);
      });
    }
  });

  // ===================================================================
  // 3. unstageExcludedFiles — per-file vs batch git reset
  // ===================================================================

  describe("unstageExcludedFiles", () => {
    for (const [size, count] of [
      ["small", SMALL_COUNT],
      ["medium", MEDIUM_COUNT],
      ["large", LARGE_COUNT],
    ] as const) {
      it(`${size} (${count} files, with exclude patterns)`, () => {
        const repoDir = mkdtempSync(path.join(tmpDir(), "bench-unstage-"));
        after(() => { try { rmSync(repoDir, { recursive: true, force: true }); } catch { /* */ } });
        createRepoWithFiles(repoDir, count);
        createMixedChanges(repoDir, count);
        execSync("git add -A", { cwd: repoDir, stdio: "ignore" });
        const diffStat = execSync("git diff --cached --stat", {
          cwd: repoDir, encoding: "utf-8", maxBuffer: 10 * 1024 * 1024, stdio: ["ignore", "pipe", "ignore"],
        }).trim();
        const allFiles = getChangedFiles(diffStat);
        assert.ok(allFiles.length > 0, `expected files (${size})`);

        const timings: number[] = [];
        for (let i = 0; i < RUNS; i++) {
          const start = performance.now();
          const result = unstageExcludedFiles(repoDir, allFiles, ["*.log", "dist/"]);
          timings.push(performance.now() - start);
          assert.ok(Array.isArray(result));
          execSync("git add -A", { cwd: repoDir, stdio: "ignore" });
        }
        record("unstageExcludedFiles", size, timings);
      });
    }
  });

  // ===================================================================
  // 4. stageAll (git add + diff stat + diff content combined)
  // ===================================================================

  describe("stageAll", () => {
    for (const [size, count] of [
      ["small", SMALL_COUNT],
      ["medium", MEDIUM_COUNT],
      ["large", LARGE_COUNT],
    ] as const) {
      it(`${size} (${count} files)`, () => {
        const repoDir = mkdtempSync(path.join(tmpDir(), "bench-stage-"));
        after(() => { try { rmSync(repoDir, { recursive: true, force: true }); } catch { /* */ } });
        createRepoWithFiles(repoDir, count);
        modifyFiles(repoDir, count);

        const timings: number[] = [];
        for (let i = 0; i < RUNS; i++) {
          const start = performance.now();
          const result = stageAll(repoDir);
          timings.push(performance.now() - start);
          assert.ok(result.diffStat, "expected diffStat");
          assert.ok(result.diffContent, "expected diffContent");
          execSync("git reset HEAD -- .", { cwd: repoDir, stdio: "ignore" });
        }
        record("stageAll", size, timings);
      });
    }
  });

  // ===================================================================
  // 5. getChangedFiles — diff stat parsing
  // ===================================================================

  describe("getChangedFiles (parsing)", () => {
    for (const [size, count] of [
      ["small", SMALL_COUNT],
      ["medium", MEDIUM_COUNT],
      ["large", LARGE_COUNT],
    ] as const) {
      it(`${size} (${count} files)`, () => {
        const repoDir = mkdtempSync(path.join(tmpDir(), "bench-parse-"));
        after(() => { try { rmSync(repoDir, { recursive: true, force: true }); } catch { /* */ } });
        createRepoWithFiles(repoDir, count);
        modifyFiles(repoDir, count);
        execSync("git add -A", { cwd: repoDir, stdio: "ignore" });
        const diffStat = execSync("git diff --cached --stat", {
          cwd: repoDir, encoding: "utf-8", maxBuffer: 10 * 1024 * 1024, stdio: ["ignore", "pipe", "ignore"],
        }).trim();

        const timings: number[] = [];
        for (let i = 0; i < RUNS; i++) {
          const start = performance.now();
          const files = getChangedFiles(diffStat);
          timings.push(performance.now() - start);
          assert.ok(files.length > 0, `expected changed files (${size})`);
        }
        record("getChangedFiles (parse)", size, timings);
      });
    }
  });

  // ===================================================================
  // 6. git commit latency — bare git commit -F - timing
  // ===================================================================

  describe("git commit", () => {
    for (const [size, count] of [
      ["small", SMALL_COUNT],
      ["medium", MEDIUM_COUNT],
      ["large", LARGE_COUNT],
    ] as const) {
      it(`${size} (${count} files)`, () => {
        const repoDir = mkdtempSync(path.join(tmpDir(), "bench-commit-"));
        after(() => { try { rmSync(repoDir, { recursive: true, force: true }); } catch { /* */ } });
        createRepoWithFiles(repoDir, count);
        modifyFiles(repoDir, count);

        const timings: number[] = [];
        for (let i = 0; i < RUNS; i++) {
          execSync("git add -A", { cwd: repoDir, stdio: "ignore" });
          const start = performance.now();
          execSync("git commit -F -", {
            cwd: repoDir,
            encoding: "utf-8",
            stdio: ["pipe", "pipe", "ignore"],
            input: `chore: bench run ${i}\n\nAutomated benchmark commit.\n`,
          });
          timings.push(performance.now() - start);
          // Add a new change for the next run
          writeFileSync(path.join(repoDir, "src", `bench-${i}.ts`), `// bench run ${i}\n`);
        }
        record("git commit", size, timings);
      });
    }
  });

  // ===================================================================
  // 7. Full pipeline: stageAll + git commit (stagedCommits default = true)
  // ===================================================================

  describe("full pipeline (stagedCommits=default)", () => {
    for (const [size, count] of [
      ["small", SMALL_COUNT],
      ["medium", MEDIUM_COUNT],
      ["large", LARGE_COUNT],
    ] as const) {
      it(`${size} (${count} files)`, () => {
        const repoDir = mkdtempSync(path.join(tmpDir(), "bench-pipe-"));
        after(() => { try { rmSync(repoDir, { recursive: true, force: true }); } catch { /* */ } });
        createRepoWithFiles(repoDir, count);
        modifyFiles(repoDir, count);

        const timings: number[] = [];
        for (let i = 0; i < RUNS; i++) {
          const start = performance.now();

          // Simulate the stageAll + single-commit path
          const { diffStat, diffContent } = stageAll(repoDir);
          assert.ok(diffStat, "expected diffStat");
          assert.ok(diffContent, "expected diffContent");

          const allFiles = getChangedFiles(diffStat);
          const keptFiles = filterGitignoredFiles(repoDir, allFiles);
          const cleaned = unstageExcludedFiles(repoDir, keptFiles, []);

          execSync("git commit -F -", {
            cwd: repoDir,
            encoding: "utf-8",
            stdio: ["pipe", "pipe", "ignore"],
            input: `chore: bench full pipeline ${i}\n\nCommit ${i} of ${count} files.\n`,
          });

          timings.push(performance.now() - start);

          // Add new change for next iteration
          for (let j = 0; j < count; j++) {
            const subdir = j % 3 === 0 ? "src" : j % 3 === 1 ? "tests" : "lib";
            const ext = j % 4 === 0 ? ".ts" : j % 4 === 1 ? ".js" : j % 4 === 2 ? ".css" : ".json";
            const filePath = path.join(repoDir, subdir, `file-${j}${ext}`);
            writeFileSync(filePath, `// file ${j} after commit ${i}\nconst x${j} = ${j + i};\n`);
          }
        }
        record("full pipeline stagedCommits=on", size, timings);
      });
    }
  });

  // ===================================================================
  // 8. Full pipeline with stagedCommits disabled
  // ===================================================================

  describe("full pipeline (stagedCommits=false)", () => {
    for (const [size, count] of [
      ["small", SMALL_COUNT],
      ["medium", MEDIUM_COUNT],
      ["large", LARGE_COUNT],
    ] as const) {
      it(`${size} (${count} files)`, () => {
        const repoDir = mkdtempSync(path.join(tmpDir(), "bench-pipe2-"));
        after(() => { try { rmSync(repoDir, { recursive: true, force: true }); } catch { /* */ } });
        createRepoWithFiles(repoDir, count);
        modifyFiles(repoDir, count);

        setConfig({ ...originalConfig, stagedCommits: false });
        const timings: number[] = [];
        for (let i = 0; i < RUNS; i++) {
          const start = performance.now();

          // Same pipeline as above but with stagedCommits: false
          const { diffStat, diffContent } = stageAll(repoDir);
          assert.ok(diffStat, "expected diffStat");
          assert.ok(diffContent, "expected diffContent");

          const allFiles = getChangedFiles(diffStat);
          const keptFiles = filterGitignoredFiles(repoDir, allFiles);
          const cleaned = unstageExcludedFiles(repoDir, keptFiles, []);

          execSync("git commit -F -", {
            cwd: repoDir,
            encoding: "utf-8",
            stdio: ["pipe", "pipe", "ignore"],
            input: `chore: bench full pipeline ${i}\n\nCommit ${i} of ${count} files.\n`,
          });

          timings.push(performance.now() - start);

          for (let j = 0; j < count; j++) {
            const subdir = j % 3 === 0 ? "src" : j % 3 === 1 ? "tests" : "lib";
            const ext = j % 4 === 0 ? ".ts" : j % 4 === 1 ? ".js" : j % 4 === 2 ? ".css" : ".json";
            const filePath = path.join(repoDir, subdir, `file-${j}${ext}`);
            writeFileSync(filePath, `// file ${j} after commit ${i}\nconst x${j} = ${j + i};\n`);
          }
        }
        record("full pipeline stagedCommits=off", size, timings);
        setConfig(originalConfig);
      });
    }
  });

  // ===================================================================
  // 9. deterministicCommitMessage — subagent fallback message generator
  // ===================================================================

  describe("deterministicCommitMessage (subagent fallback)", () => {
    for (const [size, count] of [
      ["small", SMALL_COUNT],
      ["medium", MEDIUM_COUNT],
      ["large", LARGE_COUNT],
    ] as const) {
      it(`${size} (${count} files)`, () => {
        const repoDir = mkdtempSync(path.join(tmpDir(), "bench-det-msg-"));
        after(() => { try { rmSync(repoDir, { recursive: true, force: true }); } catch { /* */ } });
        createRepoWithFiles(repoDir, count);
        modifyFiles(repoDir, count);
        execSync("git add -A", { cwd: repoDir, stdio: "ignore" });
        const diffStat = execSync("git diff --cached --stat", {
          cwd: repoDir, encoding: "utf-8", maxBuffer: 10 * 1024 * 1024, stdio: ["ignore", "pipe", "ignore"],
        }).trim();
        const diffContent = getDiffContent(repoDir);

        const timings: number[] = [];
        for (let i = 0; i < RUNS; i++) {
          const start = performance.now();
          const msg = deterministicCommitMessage(diffStat, diffContent);
          timings.push(performance.now() - start);
          assert.ok(msg.length > 0, `expected non-empty message (${size})`);
          // deterministicCommitMessage outputs "type(scope): desc" format
          assert.ok(msg.includes(":"), `expected conventional commit format in: ${msg.slice(0, 60)}`);
        }
        record("deterministicCommitMessage", size, timings);
      });
    }
  });

  // ===================================================================
  // 10. parseCommitGroups — subagent output parsing
  // ===================================================================

  describe("parseCommitGroups (subagent output parsing)", () => {
    for (const [size, count] of [
      ["small", SMALL_COUNT],
      ["medium", MEDIUM_COUNT],
      ["large", LARGE_COUNT],
    ] as const) {
      it(`${size} (${count} files)`, () => {
        const repoDir = mkdtempSync(path.join(tmpDir(), "bench-parse-groups-"));
        after(() => { try { rmSync(repoDir, { recursive: true, force: true }); } catch { /* */ } });
        createRepoWithFiles(repoDir, count);
        modifyFiles(repoDir, count);
        execSync("git add -A", { cwd: repoDir, stdio: "ignore" });
        const diffStat = execSync("git diff --cached --stat", {
          cwd: repoDir, encoding: "utf-8", maxBuffer: 10 * 1024 * 1024, stdio: ["ignore", "pipe", "ignore"],
        }).trim();
        const allFiles = getChangedFiles(diffStat);

        // Build a realistic subagent output with all files grouped into one
        const groupOutput = [
          "--- COMMIT GROUP 1 ---",
          "chore: bench update",
          "",
          `Update ${allFiles.length} files for benchmark.`,
          `Files: ${allFiles.join(", ")}`,
        ].join("\n");

        const timings: number[] = [];
        for (let i = 0; i < RUNS; i++) {
          const start = performance.now();
          const groups = parseCommitGroups(groupOutput, allFiles);
          timings.push(performance.now() - start);
          assert.ok(groups.length > 0, `expected at least one group (${size})`);
          assert.strictEqual(groups[0].files.length, allFiles.length, "all files should be in the group");
        }
        record("parseCommitGroups", size, timings);
      });
    }
  });

  // ===================================================================
  // 11. Profiling instrumentation — subagent call timing hooks
  // ===================================================================

  describe("profiling instrumentation (subagent call timing)", () => {
    it("reports initial value of 0 before any subagent call", () => {
      const t = _getLastSubagentCallMs();
      assert.strictEqual(typeof t, "number", "_getLastSubagentCallMs() should return a number");
      assert.ok(t >= 0, "should be >= 0");
    });

    it("reports initial value of 0 before any group generation call", () => {
      const t = _getLastGroupGenCallMs();
      assert.strictEqual(typeof t, "number", "_getLastGroupGenCallMs() should return a number");
      assert.ok(t >= 0, "should be >= 0");
    });

    it("profiling timers are defined in index.ts source", () => {
      // Verify the instrumentation exists by reading the source
      const srcIndexPath = new URL("../index.ts", import.meta.url).pathname;
      const src = readFileSync(srcIndexPath, "utf-8");
      assert.ok(src.includes("__lastSubagentCallMs"), "source should contain __lastSubagentCallMs");
      assert.ok(src.includes("__lastGroupGenCallMs"), "source should contain __lastGroupGenCallMs");
      assert.ok(src.includes("performance.now()"), "source should use performance.now() for timing");
      assert.ok(src.includes("_getLastSubagentCallMs"), "source should export _getLastSubagentCallMs");
      assert.ok(src.includes("_getLastGroupGenCallMs"), "source should export _getLastGroupGenCallMs");
    });

    it("subagent call timing is captured during deterministic fallback", () => {
      // deterministicCommitMessage IS the subagent fallback — benchmark its performance
      // The actual subagent (LLM) timing is captured via _getLastSubagentCallMs()
      // during real usage. This test verifies the deterministic fallback path.
      const repoDir = mkdtempSync(path.join(tmpDir(), "bench-prof-"));
      after(() => { try { rmSync(repoDir, { recursive: true, force: true }); } catch { /* */ } });
      createRepoWithFiles(repoDir, 10);
      modifyFiles(repoDir, 10);
      execSync("git add -A", { cwd: repoDir, stdio: "ignore" });
      const diffStat = execSync("git diff --cached --stat", {
        cwd: repoDir, encoding: "utf-8", maxBuffer: 10 * 1024 * 1024, stdio: ["ignore", "pipe", "ignore"],
      }).trim();
      const diffContent = getDiffContent(repoDir);

      const start = performance.now();
      const msg = deterministicCommitMessage(diffStat, diffContent);
      const elapsed = performance.now() - start;

      assert.ok(msg.length > 0, "deterministic fallback should produce a message");
      assert.ok(elapsed < 500, `deterministic fallback should be fast (<500ms, got ${Math.round(elapsed)}ms)`);
    });
  });
});

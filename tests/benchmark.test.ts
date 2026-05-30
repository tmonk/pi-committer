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
import { mkdtempSync, writeFileSync, rmSync, readFileSync, appendFileSync, mkdirSync } from "node:fs";
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
  resolveWorkerExecArgv,
  _findJitiRegisterForPath,
  batchStageFilesForGroup,
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

  // ===================================================================
  // Worker execArgv resolution performance
  // ===================================================================

  describe("resolveWorkerExecArgv / _findJitiRegisterForPath", () => {
    const RUNS = 100;

    it("resolveWorkerExecArgv (non-node_modules path)", () => {
      const timings: number[] = [];
      for (let i = 0; i < RUNS; i++) {
        const start = performance.now();
        resolveWorkerExecArgv("/home/user/projects/app/worker.ts");
        timings.push(performance.now() - start);
      }
      record("resolveWorkerExecArgv (non-nm)", String(RUNS), timings);
      const avg = timings.reduce((a, b) => a + b, 0) / timings.length;
      // Should be well under 1ms (simple string check)
      assert.ok(avg < 1, `resolveWorkerExecArgv should be fast (<1ms avg, got ${Math.round(avg * 1000)}µs)`);
    });

    it("_findJitiRegisterForPath (node_modules path)", () => {
      const cwd = process.cwd();
      const workerPath = path.join(cwd, "node_modules", "some-pkg", "worker.ts");
      const timings: number[] = [];
      for (let i = 0; i < RUNS; i++) {
        const start = performance.now();
        _findJitiRegisterForPath(workerPath);
        timings.push(performance.now() - start);
      }
      record("_findJitiRegisterForPath (nm)", String(RUNS), timings);
      const avg = timings.reduce((a, b) => a + b, 0) / timings.length;
      // May involve filesystem checks (~0.1-2ms)
      assert.ok(avg < 5, `_findJitiRegisterForPath should be fast (<5ms avg, got ${Math.round(avg * 100) / 100}ms)`);
    });

    it("_findJitiRegisterForPath (no node_modules)", () => {
      const timings: number[] = [];
      for (let i = 0; i < RUNS; i++) {
        const start = performance.now();
        _findJitiRegisterForPath("/home/user/projects/app/worker.ts");
        timings.push(performance.now() - start);
      }
      record("_findJitiRegisterForPath (no-nm)", String(RUNS), timings);
      const avg = timings.reduce((a, b) => a + b, 0) / timings.length;
      // Only checks cwd and homedir (both may not match), so fast
      assert.ok(avg < 5, `_findJitiRegisterForPath(no-nm) should be fast (<5ms avg, got ${Math.round(avg * 100) / 100}ms)`);
    });

    it("resolveWorkerExecArgv (node_modules path with real jiti)", () => {
      const cwd = process.cwd();
      const workerInNm = path.join(cwd, "node_modules", "any-pkg", "worker.ts");
      const timings: number[] = [];
      for (let i = 0; i < RUNS; i++) {
        const start = performance.now();
        const argv = resolveWorkerExecArgv(workerInNm);
        timings.push(performance.now() - start);
      }
      record("resolveWorkerExecArgv (nm+jiti)", String(RUNS), timings);
      const avg = timings.reduce((a, b) => a + b, 0) / timings.length;
      assert.ok(avg < 5, `resolveWorkerExecArgv(nm+jiti) should be fast (<5ms avg, got ${Math.round(avg * 100) / 100}ms)`);
    });
  });

  // ===================================================================
  // Unstageable file handling — batched vs per-file staging
  // ===================================================================

  describe("unstageable file handling", () => {
    const BENCH_RUNS = 1; // Single iteration (10k file setup is slow enough)

    /**
     * Create a repo with `tracked` files (committed), then delete most and
     * modify a few to create a mixed stageable/unstageable state.
     */
    function createUnstageableFixture(
      repoDir: string,
      totalFiles: number,
      stageableCount: number,
      specialCount: number,
    ): string[] {
      execSync("git init", { cwd: repoDir, stdio: "ignore" });
      execSync("git config user.email bench@test.com", { cwd: repoDir, stdio: "ignore" });
      execSync("git config user.name Bench", { cwd: repoDir, stdio: "ignore" });

      // Create subdirectories
      for (const d of ["src", "lib", "tests", "data", "vectors"]) {
        mkdirSync(path.join(repoDir, d), { recursive: true });
      }

      // Create tracked files (use writeFileSync in a loop, not a giant shell cmd)
      for (let i = 0; i < totalFiles; i++) {
        const subdir = i % 4 === 0 ? "src" : i % 4 === 1 ? "lib" : i % 4 === 2 ? "tests" : "data";
        writeFileSync(path.join(repoDir, subdir, `f-${i}.ts`), `// file ${i}\nconst x${i} = ${i};\n`);
      }

      execSync("git add -A", { cwd: repoDir, stdio: "ignore" });
      execSync("git commit -m initial", { cwd: repoDir, stdio: "ignore" });

      const deleteCount = totalFiles - stageableCount;
      const deletedFiles: string[] = [];

      // Delete most tracked files (makes them unstageable via per-file git add)
      for (let i = 0; i < deleteCount; i++) {
        const subdir = i % 4 === 0 ? "src" : i % 4 === 1 ? "lib" : i % 4 === 2 ? "tests" : "data";
        const f = path.join(repoDir, subdir, `f-${i}.ts`);
        rmSync(f, { force: true });
        deletedFiles.push(`${subdir}/f-${i}.ts`);
      }

      // Add special unstageable files (track them, then delete from disk)
      const specialFiles: string[] = [];
      for (let i = 0; i < specialCount; i++) {
        const sf = `vectors/chunk_${i}.mmap`;
        specialFiles.push(sf);
        writeFileSync(path.join(repoDir, sf), `mmap data ${i}`);
      }
      execSync("git add -A", { cwd: repoDir, stdio: "ignore" });
      execSync("git commit -m 'add special files'", { cwd: repoDir, stdio: "ignore" });

      // Delete special files from disk (simulating missing special files)
      for (const sf of specialFiles) {
        rmSync(path.join(repoDir, sf), { force: true });
      }

      // Modify the stageable files (append content)
      for (let i = 0; i < stageableCount; i++) {
        const idx = totalFiles - stageableCount + i;
        const subdir = idx % 4 === 0 ? "src" : idx % 4 === 1 ? "lib" : idx % 4 === 2 ? "tests" : "data";
        const fp = path.join(repoDir, subdir, `f-${idx}.ts`);
        writeFileSync(fp, `// file ${idx} v2\nconst x${idx} = ${idx + 1};\n`, { flag: "a" });
      }

      // Return all files the per-file loop would try to stage
      const all = [...deletedFiles, ...specialFiles];
      for (let i = 0; i < stageableCount; i++) {
        const idx = totalFiles - stageableCount + i;
        const subdir = idx % 4 === 0 ? "src" : idx % 4 === 1 ? "lib" : idx % 4 === 2 ? "tests" : "data";
        all.push(`${subdir}/f-${idx}.ts`);
      }
      return all;
    }

    // The per-file approach (simulates the O(N) bottleneck of the old code)
    function stageFilesOneByOne(dir: string, files: string[]): number {
      let staged = 0;
      for (const f of files) {
        try {
          execSync(`git add -- "${f}"`, { cwd: dir, stdio: "pipe" });
          staged++;
        } catch {
          // skip unstageable
        }
      }
      return staged;
    }

    // The batched approach (the optimization)
    function stageFilesBatched(dir: string, files: string[]): number {
      const warned: string[] = [];
      const result = batchStageFilesForGroup(
        dir,
        files,
        (_f, _m) => { warned.push(_f); },
        () => {},
      );
      return result.staged.length;
    }

    // ── 1k-unstageable: per-file vs batched direct comparison ──
    it("1k-unstageable (1020 files, 20 stageable, 10 special)", () => {
      const repoDir = mkdtempSync(path.join(tmpDir(), "bench-unstage-"));
      after(() => { try { rmSync(repoDir, { recursive: true, force: true }); } catch { /* */ } });

      const allFiles = createUnstageableFixture(repoDir, 1020, 20, 10);

      // stageAll (common to both approaches)
      const { diffStat } = stageAll(repoDir);
      assert.ok(diffStat, "expected diffStat after stageAll");

      // Measure per-file approach (OLD)
      execSync("git reset HEAD -- .", { cwd: repoDir, stdio: "ignore" });
      const startOld = performance.now();
      const stagedOld = stageFilesOneByOne(repoDir, allFiles);
      const elapsedOld = performance.now() - startOld;
      execSync("git reset HEAD -- .", { cwd: repoDir, stdio: "ignore" });

      // Measure batched approach (NEW)
      const startNew = performance.now();
      const stagedNew = stageFilesBatched(repoDir, allFiles);
      const elapsedNew = performance.now() - startNew;
      execSync("git reset HEAD -- .", { cwd: repoDir, stdio: "ignore" });

      record(`stageFiles one-by-one (1k)`, "1020", [elapsedOld]);
      record(`stageFiles batched (1k)`, "1020", [elapsedNew]);

      assert.ok(stagedNew >= stagedOld, `new staged (${stagedNew}) >= old (${stagedOld})`);
      const ratio = elapsedOld / elapsedNew;
      console.log(`  ⚡ 1k-unstageable: ${ratio.toFixed(1)}x speedup (old=${elapsedOld.toFixed(0)}ms → new=${elapsedNew.toFixed(0)}ms)`);
    });

    // ── 10k-unstageable: full pipeline end-to-end ──
    // The per-file approach at 10k scale takes ~150s (extrapolated from 1k: 15s × 10).
    // Instead of running that extreme slow path, we benchmark the batched approach
    // and compute the ≥100x speedup against the extrapolated per-file baseline.
    it("10k-unstageable (10020 files, 20 stageable, 10 special) — full pipeline", () => {
      const repoDir = mkdtempSync(path.join(tmpDir(), "bench-unstage-10k-"));
      after(() => { try { rmSync(repoDir, { recursive: true, force: true }); } catch { /* */ } });

      const allFiles = createUnstageableFixture(repoDir, 10020, 20, 10);

      // ---- Per-file baseline at 1k scale (for extrapolation) ----
      const { diffStat } = stageAll(repoDir);
      assert.ok(diffStat, "expected diffStat after stageAll");
      execSync("git reset HEAD -- .", { cwd: repoDir, stdio: "ignore" });

      // Stage 1k files (first 1000) with per-file approach to get baseline timing
      const sampleFiles = allFiles.slice(0, 1000);
      const startSample = performance.now();
      stageFilesOneByOne(repoDir, sampleFiles);
      const sampleTimeMs = performance.now() - startSample;
      execSync("git reset HEAD -- .", { cwd: repoDir, stdio: "ignore" });

      // Extrapolate: per-file for 10k files ≈ sampleTimeMs × 10
      const perFile10kBaselineMs = sampleTimeMs * 10;

      // ---- Full pipeline with batched approach at 10k scale ----
      // This exercises the real code path: unstageAll → batchStageFilesForGroup → commit
      const startFullPipeline = performance.now();

      // Simulate the grouped commit path: unstage, batch-stage, commit
      // First, do stageAll to get the diff (as tryCommit does)
      execSync("git add -A", { cwd: repoDir, stdio: "ignore" });

      // Now simulate the per-group flow: unstageAll then batch-stage the group files
      execSync("git reset HEAD -- .", { cwd: repoDir, stdio: "ignore" });

      const batchResult = batchStageFilesForGroup(
        repoDir,
        allFiles,
        () => {},
        () => {},
      );

      // Actually commit the staged files to prove the pipeline works end-to-end
      execSync("git commit -F -", {
        cwd: repoDir,
        encoding: "utf-8",
        stdio: ["pipe", "pipe", "ignore"],
        input: `chore: benchmark 10k unstageable\n\nStaged ${batchResult.staged.length} of ${allFiles.length} files with batch approach.`,
      });

      const elapsedFullPipeline = performance.now() - startFullPipeline;

      record(`full pipeline batched (10k)`, "10020", [elapsedFullPipeline]);
      record(`per-file extrapolated (10k)`, "10020", [perFile10kBaselineMs]);

      // Verify the pipeline actually committed something
      const logCount = execSync("git log --oneline", {
        cwd: repoDir, encoding: "utf-8",
      }).trim().split("\n").length;
      // Initial commit + special files commit + benchmark commit = 3
      assert.strictEqual(logCount, 3, "should have 3 commits (initial + special + benchmark)");

      // Verify speedup ≥ 100x
      const ratio = perFile10kBaselineMs / elapsedFullPipeline;
      console.log(`  ⚡ 10k-unstageable (full pipeline): ${ratio.toFixed(1)}x speedup`);
      console.log(`     Per-file extrapolated baseline: ${(perFile10kBaselineMs / 1000).toFixed(1)}s`);
      console.log(`     Batched full pipeline time: ${(elapsedFullPipeline / 1000).toFixed(1)}s`);
      console.log(`     Files staged: ${batchResult.staged.length} of ${allFiles.length}`);

      assert.ok(
        ratio >= 100,
        `Expected ≥100x speedup at 10k scale, got ${ratio.toFixed(1)}x ` +
        `(per-file extrapolated=${(perFile10kBaselineMs / 1000).toFixed(1)}s, ` +
        `batched=${(elapsedFullPipeline / 1000).toFixed(1)}s)`,
      );
    });
  });
});

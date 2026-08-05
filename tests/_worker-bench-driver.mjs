/**
 * Self-contained worker boot + IPC round-trip benchmark driver.
 *
 * Spawned as a subprocess by tests/benchmark.test.ts (node:test's runner has
 * known IPC quirks when forking with IPC channels, so we isolate the forks
 * here and report timings over stdout).
 *
 * Usage: node _worker-bench-driver.mjs <repoDir> <execArgvJson> <runs> [deterministic]
 *
 * For each run: forks async-commit-worker.ts with the given execArgv, sends a
 * "start" (no subagent), and reports:
 *   bootMs      — fork → first "progress" message (worker loaded + initial git work)
 *   roundtripMs — fork → "result" message (full pipeline + block, or + commit when
 *                 deterministic=1 enables the deterministic_fallback gate)
 * Between runs the driver re-modifies and re-stages a file so each run has a
 * fresh change to commit.
 */

import { fork } from "node:child_process";
import { execSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { performance } from "node:perf_hooks";

const [repoDir, execArgvJson, runsArg, deterministicArg] = process.argv.slice(2);
if (!repoDir || !execArgvJson || !runsArg) {
  console.error("usage: node _worker-bench-driver.mjs <repoDir> <execArgvJson> <runs> [deterministic]");
  process.exit(1);
}
const execArgv = JSON.parse(execArgvJson);
const runs = parseInt(runsArg, 10);
const deterministic = deterministicArg === "1";
const workerPath = new URL("../async-commit-worker.ts", import.meta.url).pathname;

const WORK_FILE = "work.ts";
function stageFreshChange(runIdx) {
  writeFileSync(path.join(repoDir, WORK_FILE), `// work ${runIdx}\nconst n = ${runIdx};\n`);
  execSync("git add -A", { cwd: repoDir, stdio: "ignore" });
}

function runOnce(runIdx) {
  return new Promise((resolve) => {
    stageFreshChange(runIdx);
    const t0 = performance.now();
    const child = fork(workerPath, [], {
      execArgv,
      stdio: ["ignore", "ignore", "ignore", "ipc"],
    });
    let bootMs = null;
    let done = false;
    const finish = (roundtripMs) => {
      if (!done) {
        done = true;
        resolve({ bootMs, roundtripMs });
        try { child.kill(); } catch { /* */ }
      }
    };
    child.on("message", (msg) => {
      if (!msg) return;
      if (msg.type === "progress" && bootMs === null) {
        bootMs = performance.now() - t0;
      } else if (msg.type === "result") {
        finish(performance.now() - t0);
      }
    });
    child.on("exit", (code) => {
      if (!done) finish(performance.now() - t0); // early exit (e.g. load failure)
    });
    child.on("error", () => finish(performance.now() - t0));
    child.send({
      type: "start",
      params: {
        dir: repoDir,
        diffStat: "",
        diffContent: "",
        allFiles: [WORK_FILE],
        stagedCommits: false,
        excludePatterns: [],
        minChanges: 1,
        subagentModel: undefined,
        subagentGroupingMinFiles: 4,
        subagentMessageMinFiles: 3,
        subagentThinkingLevel: "off",
        deterministicFallback: deterministic,
      },
    });
    setTimeout(() => finish(performance.now() - t0), 15000);
  });
}

for (let i = 0; i < runs; i++) {
  const r = await runOnce(i);
  process.stdout.write(
    JSON.stringify({ bootMs: r.bootMs, roundtripMs: r.roundtripMs }) + "\n",
  );
}
process.exit(0);
